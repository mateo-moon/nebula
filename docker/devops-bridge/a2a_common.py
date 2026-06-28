"""
Shared A2A client for the DevOps-agent bridges and comms bots.

kagent exposes every Agent over Google A2A (JSON-RPC 2.0). The bridges (k8s-watch,
alertmanager, github-webhook) and comms bots (telegram, matrix) all do the same thing:
send a text prompt to the orchestrator and read back its reply — so the wire protocol
lives here once.

Verified shape (kagent 0.9.x, official Telegram-bot example): the RPC method is
`message/send` (NOT `tasks/send`). The orchestrator is addressed at
`{base}/api/a2a/{namespace}/{name}/`, with an agent card at `.well-known/agent.json`.

HITL (propose-then-approve): when the orchestrator calls a tool listed in
`requireApproval`, the response comes back as a Task in state `input-required`, carrying
the approval question as text. The comms bots surface that to the human (Approve/Reject)
and send the human's reply back on the SAME `context_id` to continue the session.

Env:
  A2A_BASE_URL  default http://kagent-controller.kagent:8083  (in-cluster Service)
  A2A_AGENT_NS  default kagent
  A2A_AGENT     default devops-orchestrator
  A2A_TIMEOUT   default 300 (seconds — the orchestrator may delegate + think for a while)
"""
from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field

import httpx

DEFAULT_BASE_URL = os.getenv("A2A_BASE_URL", "http://kagent-controller.kagent:8083")
DEFAULT_AGENT_NS = os.getenv("A2A_AGENT_NS", "kagent")
DEFAULT_AGENT = os.getenv("A2A_AGENT", "devops-orchestrator")
DEFAULT_TIMEOUT = float(os.getenv("A2A_TIMEOUT", "300"))


class A2AError(RuntimeError):
    """A non-recoverable failure talking to the orchestrator (auth, 4xx, bad JSON-RPC)."""


@dataclass
class A2AResponse:
    """Parsed reply from the orchestrator."""

    #: Concatenated text the agent produced (its answer, or the HITL approval question).
    text: str = ""
    #: A2A Task state — "completed", "input-required" (HITL), "failed", etc. "" if a bare Message.
    state: str = ""
    #: Context id to continue this conversation (pass back as context_id on the next send).
    context_id: str | None = None
    #: Task id (present when the reply is a Task).
    task_id: str | None = None
    #: True when the agent paused for a human approve/reject (propose-then-approve gate).
    needs_input: bool = False
    #: The raw decoded JSON-RPC `result` object, for callers that want more.
    raw: dict = field(default_factory=dict)


def _text_from_result(result: dict) -> str:
    """Extract concatenated text from an A2A `result` (Task.artifacts or Message.parts)."""
    chunks: list[str] = []
    # Task: artifacts[].parts[].text (most-recent artifact last).
    for artifact in result.get("artifacts", []) or []:
        for part in artifact.get("parts", []) or []:
            if part.get("kind") == "text" and part.get("text"):
                chunks.append(part["text"])
    # Bare Message: parts[].text.
    if not chunks:
        for part in result.get("parts", []) or []:
            if part.get("kind") == "text" and part.get("text"):
                chunks.append(part["text"])
    # A Task may also carry a status.message (e.g. the HITL question) — include as a fallback.
    status = result.get("status") or {}
    msg = status.get("message") or {}
    for part in msg.get("parts", []) or []:
        if part.get("kind") == "text" and part.get("text") and part["text"] not in chunks:
            chunks.append(part["text"])
    return "\n".join(chunks).strip()


class A2AClient:
    """Thin client for one kagent Agent's A2A endpoint."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        agent_ns: str = DEFAULT_AGENT_NS,
        agent: str = DEFAULT_AGENT,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.agent_ns = agent_ns
        self.agent = agent
        self.timeout = timeout
        self._endpoint = f"{self.base_url}/api/a2a/{self.agent_ns}/{self.agent}/"
        self._http = httpx.Client(timeout=self.timeout)

    def close(self) -> None:
        self._http.close()

    def __enter__(self) -> "A2AClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def agent_card(self) -> dict:
        """Fetch the agent's A2A card (`/.well-known/agent.json`) — a liveness/capability check."""
        r = self._http.get(f"{self.base_url}/api/a2a/{self.agent_ns}/{self.agent}/.well-known/agent.json")
        r.raise_for_status()
        return r.json()

    def send(self, text: str, context_id: str | None = None) -> A2AResponse:
        """Send `text` to the orchestrator and return its parsed reply.

        Pass a prior `A2AResponse.context_id` to continue an existing session (so the
        agent keeps its memory of the turn — needed to answer a HITL approval prompt).
        """
        message: dict = {
            "role": "user",
            "parts": [{"kind": "text", "text": text}],
        }
        if context_id:
            message["contextId"] = context_id

        envelope = {
            "jsonrpc": "2.0",
            "id": str(uuid.uuid4()),
            "method": "message/send",
            "params": {
                "id": str(uuid.uuid4()),
                "message": message,
            },
        }

        # Retry transient transport/5xx failures; A2A calls can be long, so keep the
        # attempt count modest.
        last_exc: Exception | None = None
        for attempt in range(3):
            try:
                r = self._http.post(self._endpoint, json=envelope)
                if r.status_code >= 500 and attempt < 2:
                    last_exc = A2AError(f"upstream {r.status_code}: {r.text[:200]}")
                    continue
                r.raise_for_status()
                break
            except httpx.HTTPError as exc:
                last_exc = exc
        else:
            raise A2AError(f"A2A request failed after retries: {last_exc}")

        body = r.json()
        # L7: a well-behaved server echoes the request id; a mismatch means we got an
        # unrelated/unmatched response — refuse it rather than acting on the wrong reply.
        if isinstance(body.get("id"), str) and body["id"] != envelope["id"]:
            raise A2AError(
                f"JSON-RPC id mismatch (sent {envelope['id']}, got {body.get('id')})"
            )
        if "error" in body:
            err = body["error"]
            raise A2AError(f"JSON-RPC error {err.get('code')}: {err.get('message')}")

        result = body.get("result") or {}
        state = (result.get("status") or {}).get("state", "")
        resp = A2AResponse(
            text=_text_from_result(result),
            state=state,
            context_id=result.get("contextId") or context_id,
            task_id=result.get("id"),
            needs_input=state == "input-required",
            raw=result,
        )
        return resp

    async def send_async(self, text: str, context_id: str | None = None) -> A2AResponse:
        """Async wrapper: run the blocking `send` in a worker thread so a slow orchestrator
        call never blocks the event loop (M1). Use from async handlers (telegram/alert/
        github/matrix bridges)."""
        import asyncio

        return await asyncio.to_thread(self.send, text, context_id=context_id)


def send_a2a_message(
    text: str,
    *,
    base_url: str = DEFAULT_BASE_URL,
    agent_ns: str = DEFAULT_AGENT_NS,
    agent: str = DEFAULT_AGENT,
    context_id: str | None = None,
    timeout: float = DEFAULT_TIMEOUT,
) -> A2AResponse:
    """One-shot helper: send a prompt to the orchestrator and return the parsed reply."""
    client = A2AClient(base_url, agent_ns, agent, timeout)
    try:
        return client.send(text, context_id=context_id)
    finally:
        client.close()


if __name__ == "__main__":
    # Manual smoke test:  python a2a_common.py "what pods are running in kagent?"
    import sys

    prompt = " ".join(sys.argv[1:]) or "ping"
    print(f"→ sending to {DEFAULT_AGENT_NS}/{DEFAULT_AGENT} at {DEFAULT_BASE_URL}")
    out = send_a2a_message(prompt)
    print(f"  state={out.state or '(message)'} needs_input={out.needs_input} ctx={out.context_id}")
    print(f"  reply:\n{out.text or '(no text)'}")
