"""
Alertmanager bridge — pushes firing alerts to the orchestrator for triage.

Alertmanager sends webhooks here (receiver URL `/alertmanager`); we turn firing alerts into a
structured triage prompt and send it to `devops-orchestrator` over A2A. The orchestrator then
delegates (k8s-inspector to diagnose, change-author to draft a fix — gated).

De-dupes within a single webhook payload by `(alertname, fingerprint)`. Cross-request de-dup
(needs shared state) is a TODO; for a PoC we lean on Alertmanager's grouping + repeat interval.

Receives from the central Prometheus/Alertmanager (mainnet tool-node metrics). Runs as a
FastAPI Deployment behind the AWS NLB + Route53 (Phase 5). The orchestrator reply (triage
result / approval prompt) is returned in the HTTP response; persistent delivery to a chat
channel is handled by the k8s-watch / telegram forwarding (TODO: a shared notifier).

Env: + A2A_* (from a2a_common)
"""
from __future__ import annotations

import logging
import os

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from a2a_common import A2AError, A2AClient

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("alert-bridge")

# Shared bearer token Alertmanager must present (H6: the receiver is otherwise unauthenticated
# — anyone reaching it could inject fake critical alerts that drive the orchestrator).
ALERT_TOKEN = os.environ.get("ALERT_TOKEN", "")
if not ALERT_TOKEN:
    raise SystemExit("ALERT_TOKEN is not set — refusing to start (Alertmanager webhook must be authenticated).")

app = FastAPI(title="kagent alertmanager bridge")
a2a = A2AClient()


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/alertmanager")
async def alertmanager(req: Request) -> JSONResponse:
    # Authenticate before any processing — do not echo orchestrator output to anonymous callers.
    if req.headers.get("authorization", "") != f"Bearer {ALERT_TOKEN}":
        return JSONResponse(status_code=401, content={"error": "unauthorized"})
    try:
        payload = await req.json()
    except (ValueError, UnicodeDecodeError) as exc:
        log.warning("malformed alertmanager payload: %s", exc)
        return JSONResponse(status_code=400, content={"error": "invalid JSON"})

    alerts = payload.get("alerts", []) or []
    firing = [a for a in alerts if a.get("status") == "firing"]
    if not firing:
        return JSONResponse(content={"status": "no firing alerts"})

    # De-dupe within this payload by (alertname, fingerprint).
    seen: set[tuple[str, str]] = set()
    lines: list[str] = []
    for a in firing:
        labels = a.get("labels", {}) or {}
        annot = a.get("annotations", {}) or {}
        key = (labels.get("alertname", "?"), a.get("fingerprint", ""))
        if key in seen:
            continue
        seen.add(key)
        lines.append(
            f"- alert={labels.get('alertname')} severity={labels.get('severity', '?')} "
            f"instance={labels.get('instance', '?')}: {annot.get('summary', '')}"
        )

    prompt = (
        "[PROACTIVE: Alertmanager bridge] Firing alerts:\n"
        + "\n".join(lines)
        + "\n\nTriage each: delegate to k8s-inspector to diagnose root cause, and to "
        "change-author to draft the smallest reversible fix if one is warranted (any apply is "
        "gated — propose first). Report what you found and any proposed remediation."
    )
    log.info("%d firing alert(s) -> orchestrator", len(lines))
    try:
        resp = await a2a.send_async(prompt)
    except A2AError as exc:
        return JSONResponse(status_code=502, content={"status": "a2a_error", "error": str(exc)})

    return JSONResponse(
        content={
            "status": "sent",
            "alerts": len(lines),
            "state": resp.state,
            "needs_input": resp.needs_input,
            "reply": (resp.text or "")[:500],
        }
    )


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8080")))
