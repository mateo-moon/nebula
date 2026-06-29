"""
Telegram bot — the primary human interface to the DevOps orchestrator.

Polls Telegram for DMs, forwards each to `devops-orchestrator` over A2A, and surfaces the
reply. When the orchestrator hits a `requireApproval`-gated tool, the A2A reply comes back in
state `input-required` carrying the approval question — this bot renders it with an inline
Approve/Reject keyboard; the human's choice is sent back on the SAME context_id to resume the
paused turn (the propose-then-approve loop).

Per-chat `context_id` is kept in memory so each conversation continues with the orchestrator's
memory intact (a restart loses it; kagent `memory` provides cross-session recall regardless).

Run as a Deployment with `strategy: Recreate` (a single consumer — Telegram allows one long
poll per bot). Token from a Secret (SOPS+AWS-KMS in prod).

Env: TELEGRAM_BOT_TOKEN  (+ A2A_* from a2a_common)
"""
from __future__ import annotations

import logging
import os

from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    ContextTypes,
    MessageHandler,
    filters,
)

from a2a_common import A2AError, A2AClient

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("telegram-bot")

TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN")
if not TOKEN:
    raise SystemExit("TELEGRAM_BOT_TOKEN is not set")

# Fail-closed chat allowlist: only these chat ids may prompt the agent AND tap approve.
# Without it, anyone who discovers the bot is both requester and approver (H5).
ALLOWED_CHATS = {int(x) for x in os.environ.get("ALLOWED_TELEGRAM_CHATS", "").split(",") if x.strip()}
if not ALLOWED_CHATS:
    raise SystemExit("ALLOWED_TELEGRAM_CHATS is not set — refusing to start (fail-closed).")

# Per-chat A2A context id, so a conversation continues with the orchestrator's turn memory.
# (In-memory only — lost on restart. Long-term recall is kagent's vector `memory`.)
contexts: dict[int, str | None] = {}

# Pending HITL approvals keyed by A2A task id → (chat_id, context_id), so an Approve/Reject
# always resumes the specific task it was shown for, not the chat's latest turn (M3).
pending: dict[str, tuple[int, str | None]] = {}

a2a = A2AClient()


def _approval_keyboard(task_id: str | None) -> InlineKeyboardMarkup:
    tid = task_id or ""
    return InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("✅ Approve", callback_data=f"approve|{tid}"),
                InlineKeyboardButton("❌ Reject", callback_data=f"reject|{tid}"),
            ]
        ]
    )


async def cmd_start(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    await update.message.reply_text(
        "Hi — I'm your DevOps agent. Ask me to inspect the cluster, draft a change, or triage "
        "an alert. Any mutation I'll propose first and ask you to approve."
    )


async def handle_message(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    chat_id = update.effective_chat.id
    if chat_id not in ALLOWED_CHATS:
        log.warning("ignored message from unauthorized chat=%s", chat_id)
        return
    text = update.message.text
    cid = contexts.get(chat_id)
    log.info("chat=%s -> orchestrator: %s", chat_id, text[:120])
    try:
        resp = await a2a.send_async(text, context_id=cid)
    except A2AError as exc:
        await update.message.reply_text(f"⚠️ orchestrator error: {exc}")
        return
    if resp.context_id:
        contexts[chat_id] = resp.context_id

    if resp.needs_input:
        if resp.task_id:
            pending[resp.task_id] = (chat_id, resp.context_id, resp)
        await update.message.reply_text(
            f"🔐 Approval needed:\n\n{resp.text}", reply_markup=_approval_keyboard(resp.task_id)
        )
    else:
        await update.message.reply_text(resp.text or "(no reply)")


async def handle_callback(update: Update, _ctx: ContextTypes.DEFAULT_TYPE) -> None:
    """Human tapped Approve/Reject — resume the gated turn with their decision."""
    q = update.callback_query
    await q.answer()
    chat_id = update.effective_chat.id
    if chat_id not in ALLOWED_CHATS:
        return
    try:
        choice, task_id = q.data.split("|", 1)
    except ValueError:
        choice, task_id = q.data, None
    # Resume the specific task this keyboard was shown for (M3), not the chat's latest context.
    entry = pending.pop(task_id, None) if task_id else None
    log.info("chat=%s HITL decision: %s", chat_id, choice)
    try:
        if entry and entry[0] == chat_id and len(entry) >= 3:
            # Structured approval: send a DataPart with decision_type + batch_decisions.
            # kagent's requireApproval gate IGNORES free-text (hitl.go:
            # ExtractDecisionFromMessage — 'no text keyword matching').
            prior_resp = entry[2]
            resp = await a2a.send_async_approval(
                prior_resp, decision="approve" if choice == "approve" else "reject"
            )
        else:
            # Fallback (shouldn't happen — pending always stores the resp).
            cid = entry[1] if (entry and entry[0] == chat_id) else contexts.get(chat_id)
            resp = await a2a.send_async(
                "Approve — proceed." if choice == "approve" else "Reject — do not proceed.",
                context_id=cid,
            )
    except A2AError as exc:
        await q.edit_message_text(f"⚠️ orchestrator error: {exc}")
        return
    if resp.context_id:
        contexts[chat_id] = resp.context_id
    icon = "✅" if choice == "approve" else "❌"
    body = resp.text or "(done)"
    await q.edit_message_text(f"{icon} {'Approved' if choice == 'approve' else 'Rejected'}\n\n{body}")


def main() -> None:
    app = Application.builder().token(TOKEN).build()
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message))
    app.add_handler(CallbackQueryHandler(handle_callback))
    log.info("telegram bot polling; orchestrator=%s/%s", a2a.agent_ns, a2a.agent)
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
