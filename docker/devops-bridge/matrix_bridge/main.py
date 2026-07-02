"""
Matrix/Element bridge — a polling bot that DMs the orchestrator over A2A.

Matrix is not a native kagent chat provider, so this bot (matrix-nio) does the same job as the
Telegram bot: forwards room messages to `devops-orchestrator`, surfaces replies, and handles
the propose-then-approve gate via text ("reply 'approve' or 'reject'"). Per-room `context_id`
continuity.

HITL over Matrix is text-based on the human side (no portable inline keyboards via nio): when
the orchestrator returns `input-required`, the bot asks the room to reply approve/reject; that
reply is sent back as a structured DataPart approval (send_async_approval) — NOT free text,
which kagent's requireApproval gate ignores — resuming the paused turn on the same context.

Env:
  MATRIX_HOMESERVER   e.g. https://matrix.org  (or your self-hosted Synapse)
  MATRIX_USER         full @user:server id
  MATRIX_TOKEN        access token (device token) for MATRIX_USER
  MATRIX_ROOMS        comma-separated room ids to respond in (default: all joined)
  + A2A_* (from a2a_common)
"""
from __future__ import annotations

import asyncio
import logging
import os

from nio import AsyncClient, MatrixRoom, RoomMessageText

from a2a_common import A2AError, A2AClient, A2AResponse

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("matrix-bridge")

HOMESERVER = os.environ.get("MATRIX_HOMESERVER", "")
USER_ID = os.environ.get("MATRIX_USER", "")
TOKEN = os.environ.get("MATRIX_TOKEN", "")
ALLOWED_ROOMS = {r for r in os.environ.get("MATRIX_ROOMS", "").split(",") if r}
if not ALLOWED_ROOMS:
    # Fail-closed: only listed rooms may interact (prompt + approve). Without it any joined
    # room member is both requester and approver (H5).
    raise SystemExit("MATRIX_ROOMS is not set — refusing to start (fail-closed).")

a2a = A2AClient()
# Set in main(); the nio client used to send replies.
client: AsyncClient | None = None
# room_id -> A2A context id (conversation continuity)
contexts: dict[str, str | None] = {}
# room_id -> pending input-required A2AResponse. The FULL response is kept so that
# send_async_approval can extract the pending tool-call IDs from resp.raw (kagent's
# requireApproval gate IGNORES free-text Approve/Reject — it needs a DataPart decision).
pending: dict[str, A2AResponse] = {}


async def _send(room_id: str, text: str) -> None:
    assert client is not None
    await client.room_send(
        room_id=room_id,
        message_type="m.room.message",
        content={"msgtype": "m.text", "body": text[:4000]},
    )


async def _handle(room_id: str, text: str, cid: str | None) -> None:
    log.info("room=%s -> orchestrator: %s", room_id, text[:80])
    try:
        resp = await a2a.send_async(text, context_id=cid)
    except A2AError as exc:
        await _send(room_id, f"⚠️ orchestrator error: {exc}")
        return
    if resp.context_id:
        contexts[room_id] = resp.context_id
    if resp.needs_input:
        # Stash the FULL response: send_async_approval reads the pending tool-call IDs out
        # of resp.raw. kagent's requireApproval gate IGNORES free-text Approve/Reject.
        pending[room_id] = resp
        await _send(room_id, f"🔐 Approval needed:\n\n{resp.text}\n\n_(reply 'approve' or 'reject')_")
    else:
        await _send(room_id, resp.text or "(no reply)")


async def _on_message(room: MatrixRoom, event: RoomMessageText) -> None:
    if event.sender == USER_ID:
        return  # ignore our own messages (loop guard)
    if ALLOWED_ROOMS and room.room_id not in ALLOWED_ROOMS:
        return
    body = (event.body or "").strip()
    if not body:
        return

    room_id = room.room_id
    low = body.lower()
    # HITL resume: a bare approve/reject in a room awaiting input continues the gated turn
    # with a structured DataPart decision (free-text is ignored by kagent's requireApproval).
    if low in ("approve", "reject", "yes", "no") and room_id in pending:
        prior_resp = pending.pop(room_id)
        decision = "approve" if low in ("approve", "yes") else "reject"
        icon = "✅" if decision == "approve" else "❌"
        log.info("room=%s HITL decision: %s", room_id, decision)
        try:
            resp = await a2a.send_async_approval(prior_resp, decision=decision)
        except A2AError as exc:
            await _send(room_id, f"⚠️ orchestrator error: {exc}")
            return
        if resp.context_id:
            contexts[room_id] = resp.context_id
        if resp.needs_input:
            # Another gate in the same turn — re-arm and keep awaiting the human.
            pending[room_id] = resp
            await _send(room_id, f"🔐 Approval needed:\n\n{resp.text}\n\n_(reply 'approve' or 'reject')_")
        else:
            await _send(room_id, f"{icon} {decision}\n\n{resp.text or '(done)'}")
        return

    cid = contexts.get(room_id)
    await _handle(room_id, body, cid)


async def main() -> None:
    global client
    if not (HOMESERVER and USER_ID and TOKEN):
        raise SystemExit("MATRIX_HOMESERVER, MATRIX_USER, MATRIX_TOKEN are required")
    client = AsyncClient(HOMESERVER, USER_ID)
    client.access_token = TOKEN

    # One sync to validate the token; nio raises on auth failure.
    await client.sync(timeout=30000)
    log.info("matrix bot synced; responding in rooms=%s", ALLOWED_ROOMS or "(all joined)")

    client.add_event_callback(_on_message, RoomMessageText)
    await client.sync_forever(timeout=30000, full_state=False)


if __name__ == "__main__":
    asyncio.run(main())
