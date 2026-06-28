"""
Kubernetes watch reactor — the first proactive trigger for the DevOps orchestrator.

kagent is request/response: it has no native scheduler. This bridge watches the cluster
for unhealthy workloads and, on a breach, pushes an A2A task to `devops-orchestrator`
(via a2a_common.A2AClient). The orchestrator then delegates (k8s-inspector to diagnose,
change-author to draft a fix — which is gated behind propose-then-approve).

Breaches detected:
  - CrashLoopBackOff: a container with `restartCount >= RESTART_THRESHOLD`, or in a
    `CrashLoopBackOff` waiting state.
  - Warning Events with reasons in {BackOff, Unhealthy, Failed, Evicted, OOMKilling,
    FailedScheduling} that we haven't already surfaced within the cooldown window.

Dedup: each (namespace, object, reason) is surfaced at most once per COOLDOWN_SECONDS, so
a single crashlooping pod doesn't spam the orchestrator on every poll.

RBAC: runs under a ServiceAccount that can get/list/watch pods + events in the watched
namespace(s). It does NOT need write — mutation is the orchestrator's (gated) job.

Env:
  RESTART_THRESHOLD     default 5
  COOLDOWN_SECONDS      default 300
  POLL_INTERVAL_SECONDS default 30
  WATCH_NAMESPACES      default "" (all namespaces; comma-separated to scope, e.g. "kagent,default")
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


class Deduper:
    """Track (key -> last-sent epoch) so we don't re-surface the same breach within the cooldown."""

    def __init__(self, cooldown: int) -> None:
        self.cooldown = cooldown
        self._seen: dict[str, float] = {}

    def should_send(self, key: str) -> bool:
        now = time.time()
        last = self._seen.get(key)
        if last is not None and now - last < self.cooldown:
            return False
        self._seen[key] = now
        return True


def _namespaces() -> list[str]:
    return WATCH_NAMESPACES or [""]  # "" = all namespaces in the kubernetes client API


def _crashloop_breaches(core: client.CoreV1Api) -> list[tuple[str, str]]:
    """Return (stable_key, message) for crashlooping pods."""
    breaches: list[tuple[str, str]] = []
    for ns in _namespaces():
        try:
            pods = core.list_namespaced_pod(ns) if ns else core.list_pod_for_all_namespaces()
        except Exception as exc:  # L10: transient transport errors aren't ApiException — don't CrashLoop on a blip.
            log.warning("listing pods failed: %s", exc)
            continue
        for pod in pods.items:
            pname = pod.metadata.name
            pns = pod.metadata.namespace
            for cs in pod.status.container_statuses or []:
                restarts = cs.restart_count or 0
                # kubernetes-client objects use attribute access (snake_case), not dicts.
                waiting = cs.state.waiting if cs.state else None
                reason = waiting.reason if waiting else None
                if restarts >= RESTART_THRESHOLD or reason == "CrashLoopBackOff":
                    detail = ""
                    term = cs.last_state.terminated if cs.last_state else None
                    if term:
                        detail = f" exit={term.exit_code} reason={term.reason}"
                    breaches.append((
                        # stable identity for de-dup (NOT the restart count, which changes each loop)
                        f"{pns}/{pname}/{cs.name}",
                        f"CrashLoopBackOff: pod {pns}/{pname} container '{cs.name}' "
                        f"restartCount={restarts} (waiting={reason}){detail}",
                    ))
    return breaches


def _warning_events(core: client.CoreV1Api, since_seconds: int) -> list[tuple[str, str]]:
    """Return (stable_key, message) for recent Warning events of watched reasons."""
    breaches: list[tuple[str, str]] = []
    for ns in _namespaces():
        try:
            events = (
                core.list_namespaced_event(ns, field_selector=f"type=Warning")
                if ns
                else core.list_event_for_all_namespaces(field_selector=f"type=Warning")
            )
        except Exception as exc:  # L10: transient transport errors aren't ApiException — don't CrashLoop on a blip.
            log.warning("listing events failed: %s", exc)
            continue
        cutoff = time.time() - since_seconds
        for ev in events.items:
            if (ev.reason or "") not in WATCH_EVENT_REASONS:
                continue
            # event_time / last_timestamp are the recency signals.
            ts = ev.last_timestamp or ev.event_time
            if ts is None:
                continue
            epoch = ts.replace(tzinfo=timezone.utc).timestamp() if ts.tzinfo is None else ts.timestamp()
            if epoch < cutoff:
                continue
            inv = ev.involved_object
            breaches.append((
                f"{inv.namespace}/{inv.kind}/{inv.name}/{ev.reason}",
                f"Warning/{ev.reason}: {inv.namespace}/{inv.kind}/{inv.name} — {ev.message}",
            ))
    return breaches


def main() -> None:
    # In-cluster when run as a pod; fall back to kubeconfig for local dev.
    try:
        config.load_incluster_config()
        log.info("loaded in-cluster kubeconfig")
    except config.ConfigException:
        config.load_kubeconfig()
        log.info("loaded local kubeconfig")

    core = client.CoreV1Api()
    deduper = Deduper(COOLDOWN_SECONDS)
    a2a = A2AClient()
    log.info(
        "watching namespaces=%s restart>=%s cooldown=%ss poll=%ss reasons=%s",
        WATCH_NAMESPACES or "(all)", RESTART_THRESHOLD, COOLDOWN_SECONDS,
        POLL_INTERVAL_SECONDS, WATCH_EVENT_REASONS,
    )

    # Re-surface an event breach if it's still firing; recent window = a few poll cycles.
    event_window = max(POLL_INTERVAL_SECONDS * 3, 90)

    while True:
        breaches = _crashloop_breaches(core) + _warning_events(core, event_window)
        for key, b in breaches:
            if not deduper.should_send(key):
                continue
            prompt = (
                "[PROACTIVE: k8s-watch reactor] A workload is unhealthy on the cluster:\n"
                f"  {b}\n"
                "Diagnose the root cause (delegate to k8s-inspector), then draft the smallest "
                "reversible fix (delegate to change-author). Any apply is gated — propose it first "
                "and I will approve. Report what you found."
            )
            log.info("breach -> orchestrator: %s", b)
            try:
                resp = a2a.send(prompt)
                log.info("orchestrator replied (state=%s needs_input=%s): %s",
                         resp.state or "(msg)", resp.needs_input, (resp.text or "")[:200])
            except A2AError as exc:
                log.error("A2A send failed: %s", exc)
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
