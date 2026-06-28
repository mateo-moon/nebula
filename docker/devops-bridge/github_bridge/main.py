"""
GitHub webhook bridge — turns repo events into orchestrator tasks, and posts the reply back.

GitHub sends webhooks here (a receiver on the AWS NLB + Route53, Phase 5). We verify the
`X-Hub-Signature-256` HMAC, map the event to a prompt (`pull_request` opened/commented,
`issues` opened/assigned, `push`), send it to `devops-orchestrator` over A2A, and post the
orchestrator's reply back as a comment on the originating PR/issue (the "communicate via
GitHub" channel). Changes themselves are drafted by `change-author` (propose), with applies
gated behind propose-then-approve.

Loop guard: ignores events whose sender is the bot's own user (so it doesn't react to its own
comments) and only acts on a configurable event allowlist.

Env:
  WEBHOOK_SECRET      GitHub webhook secret (HMAC)
  GITHUB_TOKEN        PAT used to post reply comments
  GITHUB_ACTOR        The bot's own login (events from this user are ignored)
  + A2A_* (from a2a_common)
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import re

import httpx
from fastapi import FastAPI, Header, Request, Response
from fastapi.responses import JSONResponse

from a2a_common import A2AError, A2AClient

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("github-bridge")

WEBHOOK_SECRET = os.environ.get("WEBHOOK_SECRET", "").encode()
if not WEBHOOK_SECRET:
    # Fail-closed: refuse to start without a secret, else every request would be accepted
    # unsigned (anyone who reaches the webhook could drive the orchestrator / post as the bot).
    raise SystemExit("WEBHOOK_SECRET is not set — refusing to start (HMAC must be enforced).")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_ACTOR = os.environ.get("GITHUB_ACTOR", "")
if not GITHUB_ACTOR:
    # L3: without GITHUB_ACTOR the loop guard can't skip the bot's own events — set it to the
    # bot's GitHub login (the PAT owner) so it doesn't react to its own posted comments.
    log.warning("GITHUB_ACTOR is unset — loop guard inactive (set it to the bot's login).")
GH_API = "https://api.github.com"

app = FastAPI(title="kagent github-webhook bridge")
a2a = A2AClient()


def _verify_signature(raw: bytes, sig: str | None) -> bool:
    # Fail-closed: missing secret (guarded at startup) or missing signature → reject, never accept.
    if not WEBHOOK_SECRET or not sig:
        return False
    digest = hmac.new(WEBHOOK_SECRET, raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(f"sha256={digest}", sig)


def _post_comment(owner: str, repo: str, number: int, body: str) -> None:
    """Post a comment on an issue or PR (issues API serves both)."""
    if not GITHUB_TOKEN:
        log.warning("no GITHUB_TOKEN; skipping reply comment")
        return
    # M12: validate path components so a forged payload can't redirect the POST elsewhere.
    if not (re.fullmatch(r"[A-Za-z0-9._-]+", owner or "") and re.fullmatch(r"[A-Za-z0-9._-]+", repo or "")):
        log.warning("rejecting comment to invalid owner/repo: %s/%s", owner, repo)
        return
    try:
        number = int(number)
    except (TypeError, ValueError):
        log.warning("rejecting comment to invalid issue number: %s", number)
        return
    url = f"{GH_API}/repos/{owner}/{repo}/issues/{number}/comments"
    headers = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"}
    try:
        httpx.post(url, json={"body": body}, headers=headers, timeout=30).raise_for_status()
    except httpx.HTTPError as exc:
        log.error("failed to post comment to %s/%s#%d: %s", owner, repo, number, exc)


def _summarize(event: str, body: dict) -> tuple[str, str, str, int] | None:
    """Return (prompt, owner, repo, number) for an actionable event, else None."""
    repo = body.get("repository", {})
    owner = repo.get("owner", {}).get("login", "")
    name = repo.get("name", "")
    sender = body.get("sender", {}).get("login", "")
    if GITHUB_ACTOR and sender == GITHUB_ACTOR:
        return None  # ignore our own activity (loop guard)

    if event == "pull_request":
        pr = body.get("pull_request", {})
        action = body.get("action")
        number = pr.get("number")
        title = pr.get("title", "")
        if action in ("opened", "reopened", "ready_for_review"):
            return (
                f"[GitHub: PR #{number} '{title}' opened in {owner}/{name} by {sender}] "
                "Review this PR: delegate to k8s-inspector if it touches cluster manifests, "
                "or assess the code change. Summarise risk; if a follow-up change is warranted, "
                "draft it (propose only).",
                owner, name, number,
            )
    if event == "issues":
        issue = body.get("issue", {})
        action = body.get("action")
        number = issue.get("number")
        title = issue.get("title", "")
        if action in ("opened", "reopened", "assigned"):
            return (
                f"[GitHub: issue #{number} '{title}' ({action}) in {owner}/{name} by {sender}] "
                "Triage this issue. If it's a task, track it; inspect or draft a fix as needed "
                "(propose only; applies are gated).",
                owner, name, number,
            )
    return None


@app.post("/github")
async def github(
    req: Request,
    response: Response,
    x_hub_signature_256: str | None = Header(default=None),
    x_github_event: str | None = Header(default=None),
) -> JSONResponse:
    raw = await req.body()
    if not _verify_signature(raw, x_hub_signature_256):
        return JSONResponse(status_code=401, content={"error": "bad signature"})

    if not x_github_event:
        return JSONResponse(status_code=400, content={"error": "no event"})

    try:
        body = await req.json()
    except (ValueError, UnicodeDecodeError) as exc:
        log.warning("malformed github webhook payload: %s", exc)
        body = {}

    summary = _summarize(x_github_event, body)
    if summary is None:
        return JSONResponse(content={"status": "ignored", "event": x_github_event})

    prompt, owner, name, number = summary
    log.info("%s %s/%s#%s -> orchestrator", x_github_event, owner, name, number)
    try:
        resp = await a2a.send_async(prompt)
    except A2AError as exc:
        return JSONResponse(status_code=502, content={"status": "a2a_error", "error": str(exc)})

    reply = resp.text or "(no reply)"
    if resp.needs_input:
        reply = f"🔐 Approval needed:\n\n{reply}\n\n_(reply 'approve' or 'reject' on this issue to continue)_"
    _post_comment(owner, name, number, f"🤖 **devops-orchestrator** ({resp.state or 'done'}):\n\n{reply}")
    return JSONResponse(content={"status": "sent", "event": x_github_event, "state": resp.state})


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
