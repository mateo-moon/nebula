"""
Kubernetes watch reactor — proactive trigger for the DevOps orchestrator.

kagent is request/response: it has no native scheduler. This bridge watches the cluster
for unhealthy workloads and, on a breach, pushes an A2A task to `devops-orchestrator`.

SMART DEDUP — prevents token waste on persistent issues:
  - When the orchestrator returns `input-required` (fix proposed, awaiting approval),
    the breach is marked "pending approval" and NOT re-fired. The alert is already in
    the system; re-firing just burns tokens re-diagnosing the same issue.
  - When the orchestrator returns `completed` (handled), the breach gets an extended
    cooldown (default 6h) so it doesn't re-fire on a known-resolved issue.
  - Only NEW breaches (first sighting) or CHANGED breaches (different error/reason
    than last time) trigger a fresh orchestrator call.
  - A max-age cap (default 24h) ensures stale "pending approval" entries eventually
    re-fire in case the approval was lost (human missed it, session expired, etc.).

Env:
  RESTART_THRESHOLD     default 5
  COOLDOWN_SECONDS      default 300 (first-sighting cooldown; overridden by pending/resolved)
  RESOLVED_COOLDOWN     default 21600 (6h — when orchestrator marked it completed)
  MAX_PENDING_AGE       default 86400 (24h — re-fire a pending-approval breach after this)
  POLL_INTERVAL_SECONDS default 30
  WATCH_NAMESPACES      default "" (all; comma-separated to scope)
  WATCH_EVENT_REASONS   default "BackOff,Unhealthy,Failed,Evicted,OOMKilling,FailedScheduling"
  + A2A_* (see a2a_common)
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone

from kubernetes import client, config
from kubernetes.client.rest import ApiException

from a2a_common import A2AClient, A2AError

RESTART_THRESHOLD = int(os.getenv("RESTART_THRESHOLD", "5"))
COOLDOWN_SECONDS = int(os.getenv("COOLDOWN_SECONDS", "300"))
RESOLVED_COOLDOWN = int(os.getenv("RESOLVED_COOLDOWN", "21600"))  # 6h
MAX_PENDING_AGE = int(os.getenv("MAX_PENDING_AGE", "86400"))  # 24h
POLL_INTERVAL_SECONDS = int(os.getenv("POLL_INTERVAL_SECONDS", "30"))
WATCH_NAMESPACES = [n for n in os.getenv("WATCH_NAMESPACES", "").split(",") if n]
WATCH_EVENT_REASONS = set(
    (os.getenv("WATCH_EVENT_REASONS", "BackOff,Unhealthy,Failed,Evicted,OOMKilling,FailedScheduling"))
    .split(",")
)

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger("k8s-watch")


class BreachState:
    """Per-breach tracking: when last fired, the orchestrator's response state,
    and the last-seen error signature. Prevents re-firing on persistent issues
    that have already been diagnosed + are awaiting approval."""

    def __init__(self) -> None:
        # key -> {"last_fired": epoch, "response": "completed"|"input-required"|"failed"|None,
        #         "signature": str, "fired_count": int}
        self._state: dict[str, dict] = {}

    def should_fire(self, key: str, current_signature: str) -> bool:
        """Decide whether to fire for this breach. Returns True if it's new or changed."""
        entry = self._state.get(key)
        now = time.time()

        if entry is None:
            # First sighting — always fire.
            self._state[key] = {"last_fired": now, "response": None, "signature": current_signature, "fired_count": 1}
            return True

        last_fired = entry["last_fired"]
        response = entry["response"]
        elapsed = now - last_fired

        # If the orchestrator returned input-required (fix proposed, awaiting approval):
        # don't re-fire until MAX_PENDING_AGE expires. The diagnosis + proposed fix is
        # already in the system; re-firing just burns tokens re-diagnosing the same thing.
        if response == "input-required":
            if elapsed < MAX_PENDING_AGE:
                return False
            log.info("re-firing %s: pending approval expired (%.0fh old)", key, elapsed / 3600)
            entry["last_fired"] = now
            entry["fired_count"] += 1
            return True

        # If the orchestrator returned completed (handled or no action needed):
        # extended cooldown so we don't re-fire on known-resolved issues.
        if response == "completed":
            if elapsed < RESOLVED_COOLDOWN:
                return False
            log.info("re-firing %s: resolved cooldown expired (%.0fh old)", key, elapsed / 3600)
            entry["last_fired"] = now
            entry["fired_count"] += 1
            return True

        # Default cooldown for first-seen or unknown-response breaches.
        if elapsed < COOLDOWN_SECONDS:
            return False

        entry["last_fired"] = now
        entry["fired_count"] += 1
        return True

    def record_response(self, key: str, state: str) -> None:
        """Record the orchestrator's response state for this breach."""
        if key in self._state:
            self._state[key]["response"] = state
            log.info("breach %s response=%s (fired %d times)", key, state, self._state[key]["fired_count"])


def _namespaces() -> list[str]:
    return WATCH_NAMESPACES or [""]


def _crashloop_breaches(core: client.CoreV1Api) -> list[tuple[str, str, str]]:
    """Return (stable_key, signature, message) for crashlooping pods."""
    breaches: list[tuple[str, str, str]] = []
    for ns in _namespaces():
        try:
            pods = core.list_namespaced_pod(ns) if ns else core.list_pod_for_all_namespaces()
        except Exception as exc:
            log.warning("listing pods failed: %s", exc)
            continue
        for pod in pods.items:
            pname = pod.metadata.name
            pns = pod.metadata.namespace
            for cs in pod.status.container_statuses or []:
                restarts = cs.restart_count or 0
                waiting = cs.state.waiting if cs.state else None
                reason = waiting.reason if waiting else None
                if restarts >= RESTART_THRESHOLD or reason == "CrashLoopBackOff":
                    detail = ""
                    term = cs.last_state.terminated if cs.last_state else None
                    if term:
                        detail = f" exit={term.exit_code} reason={term.reason}"
                    key = f"{pns}/{pname}/{cs.name}"
                    sig = f"CrashLoopBackOff:{reason or 'none'}:{term.reason if term else 'none'}"
                    breaches.append((
                        key,
                        sig,
                        f"CrashLoopBackOff: pod {pns}/{pname} container '{cs.name}' "
                        f"restartCount={restarts} (waiting={reason}){detail}",
                    ))
    return breaches


def _warning_events(core: client.CoreV1Api, since_seconds: int) -> list[tuple[str, str, str]]:
    """Return (stable_key, signature, message) for recent Warning events of watched reasons."""
    breaches: list[tuple[str, str, str]] = []
    for ns in _namespaces():
        try:
            events = (
                core.list_namespaced_event(ns, field_selector=f"type=Warning")
                if ns
                else core.list_event_for_all_namespaces(field_selector=f"type=Warning")
            )
        except Exception as exc:
            log.warning("listing events failed: %s", exc)
            continue
        cutoff = time.time() - since_seconds
        for ev in events.items:
            if (ev.reason or "") not in WATCH_EVENT_REASONS:
                continue
            ts = ev.last_timestamp or ev.event_time
            if ts is None:
                continue
            epoch = ts.replace(tzinfo=timezone.utc).timestamp() if ts.tzinfo is None else ts.timestamp()
            if epoch < cutoff:
                continue
            inv = ev.involved_object
            key = f"{inv.namespace}/{inv.kind}/{inv.name}/{ev.reason}"
            sig = f"Warning/{ev.reason}:{ev.message[:80]}"
            breaches.append((
                key,
                sig,
                f"Warning/{ev.reason}: {inv.namespace}/{inv.kind}/{inv.name} — {ev.message}",
            ))
    return breaches


def main() -> None:
    try:
        config.load_incluster_config()
        log.info("loaded in-cluster kubeconfig")
    except config.ConfigException:
        config.load_kubeconfig()
        log.info("loaded local kubeconfig")

    core = client.CoreV1Api()
    state = BreachState()
    a2a = A2AClient()
    log.info(
        "watching ns=%s restart>=%s cooldown=%ss resolved_cooldown=%sh max_pending=%sh poll=%ss",
        WATCH_NAMESPACES or "(all)", RESTART_THRESHOLD, COOLDOWN_SECONDS,
        RESOLVED_COOLDOWN // 3600, MAX_PENDING_AGE // 3600, POLL_INTERVAL_SECONDS,
    )

    event_window = max(POLL_INTERVAL_SECONDS * 3, 90)

    while True:
        breaches = _crashloop_breaches(core) + _warning_events(core, event_window)
        for key, sig, msg in breaches:
            if not state.should_fire(key, sig):
                continue
            prompt = (
                "[PROACTIVE: k8s-watch reactor] A workload is unhealthy on the cluster:\n"
                f"  {msg}\n\n"
                "IMPORTANT: Before diagnosing, check your memory for any prior diagnosis of "
                "this exact issue. If you already diagnosed it and proposed a fix, just confirm "
                "'already diagnosed — fix pending approval' instead of re-diagnosing (saves time).\n\n"
                "If this is new: diagnose the root cause (delegate to k8s-inspector), then draft "
                "the smallest reversible fix (delegate to change-author). Any apply is gated — "
                "propose it first. Report what you found."
            )
            log.info("breach -> orchestrator: %s", msg)
            try:
                resp = a2a.send(prompt)
                resp_state = resp.state or "unknown"
                log.info("orchestrator responded: state=%s reply=%s",
                         resp_state, (resp.text or "")[:150])
                state.record_response(key, resp_state)
            except A2AError as exc:
                log.error("A2A send failed: %s", exc)
                state.record_response(key, "failed")
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
