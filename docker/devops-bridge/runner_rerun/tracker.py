"""
What the controller remembers and does: which job each runner holds, which
jobs were lost with their runner, and the rerun once their run has finished.
"""
from __future__ import annotations

import logging
import threading
import time
from dataclasses import replace

import httpx

from .core import (
    DROP,
    RERUN_JOB,
    WAIT,
    LostJob,
    decide,
    disruption_reason,
    group_by_run,
    lost_with_node,
)
from .platforms import NotReady

log = logging.getLogger("runner-rerun")

KEEP_RUNNER_SECONDS = 6 * 3600
KEEP_HANDLED_SECONDS = 24 * 3600


class Tracker:
    def __init__(
        self,
        platforms: dict,
        store,
        max_attempts: int = 3,
        max_wait: float = 6 * 3600,
        dry_run: bool = False,
        clock=time.time,
    ) -> None:
        self.platforms = platforms
        self.store = store
        self.max_attempts = max_attempts
        self.max_wait = max_wait
        self.dry_run = dry_run
        self.clock = clock
        self.lock = threading.Lock()
        self.runners: dict[str, dict] = {}
        state = store.load() or {}
        self.pending = [LostJob.from_dict(entry) for entry in state.get("pending", [])]
        self.handled: dict[str, float] = dict(state.get("handled", {}))

    # --- which job a runner holds -------------------------------------------------

    def note_arc_runner(self, runner: dict) -> None:
        """An EphemeralRunner as the runner controller reports it."""
        status = runner.get("status") or {}
        if status.get("jobRepositoryName") and status.get("workflowRunId"):
            self._note(runner["metadata"]["name"], "github", status["jobRepositoryName"], int(status["workflowRunId"]), None)

    def note_gitea_jobs(self, repository: str, jobs: list[dict]) -> None:
        for job in jobs:
            if job.get("runner_name"):
                self._note(job["runner_name"], "gitea", repository, int(job["run_id"]), int(job.get("run_attempt") or 1))

    def _note(self, runner: str, platform: str, repository: str, run_id: int, attempt: int | None) -> None:
        with self.lock:
            self.runners[runner] = {
                "platform": platform, "repository": repository, "run_id": run_id, "attempt": attempt, "seen": self.clock(),
            }

    def _job_of(self, source: dict, pod: dict) -> dict | None:
        name = pod["metadata"]["name"]
        with self.lock:
            held = self.runners.get(name)
        if held is None and source["kind"] == "gitea":
            pool = (pod["metadata"].get("labels") or {}).get(source.get("poolLabel", "gitea-runner/pool"))
            repository = (source.get("pools") or {}).get(pool)
            client = self.platforms.get("gitea")
            if repository and client:
                self.note_gitea_jobs(repository, client.running(repository))
                with self.lock:
                    held = self.runners.get(name)
        if held is None:
            return None
        if held["attempt"] is None:
            client = self.platforms.get(held["platform"])
            if client is None:
                log.warning("runner %s was lost with %s run %s, but no %s token is set", name, held["repository"], held["run_id"], held["platform"])
                return None
            held = {**held, "attempt": int(client.run(held["repository"], held["run_id"]).get("run_attempt") or 1)}
        return held

    # --- a runner that went --------------------------------------------------------

    def pod_event(self, source: dict, event: str, pod: dict, node_ready) -> LostJob | None:
        """Record the job of a runner pod that was taken away; `node_ready()` is asked only when needed."""
        uid = pod["metadata"]["uid"]
        with self.lock:
            if uid in self.handled:
                return None
        reason = disruption_reason(pod)
        if reason is None and event == "DELETED" and lost_with_node(pod, node_ready()):
            reason = "NodeLost"
        if reason is None:
            return None
        name = pod["metadata"]["name"]
        try:
            held = self._job_of(source, pod)
        except httpx.HTTPError as error:
            log.warning("runner %s was lost (%s), its job could not be looked up: %s", name, reason, error)
            return None
        with self.lock:
            self.handled[uid] = self.clock()
        if held is None:
            log.info("runner %s was lost (%s) without a job", name, reason)
            self._save()
            return None
        entry = LostJob(held["platform"], held["repository"], held["run_id"], held["attempt"], name, reason, self.clock())
        with self.lock:
            self.pending.append(entry)
        log.info("runner %s was lost (%s) with %s run %s attempt %s", name, reason, entry.repository, entry.run_id, entry.attempt)
        self._save()
        return entry

    # --- the rerun -----------------------------------------------------------------

    def process(self) -> None:
        with self.lock:
            runs = group_by_run(list(self.pending))
        for (platform, repository, run_id), entries in runs.items():
            client = self.platforms.get(platform)
            if client is None:
                self._settle(entries, f"no {platform} token is set")
                continue
            try:
                run = client.run(repository, run_id)
                jobs = client.jobs(repository, run_id) if run.get("status") == "completed" else []
                decision = decide(run, jobs, entries, self.clock(), self.max_attempts, self.max_wait)
                if decision.action == WAIT:
                    continue
                if decision.action == DROP:
                    self._settle(entries, decision.why)
                    continue
                if self.dry_run:
                    self._settle(entries, f"dry run, would {decision.action}: {decision.why}")
                    continue
                if decision.action == RERUN_JOB:
                    client.rerun_job(repository, run_id, decision.job_id)
                else:
                    client.rerun_failed(repository, run_id)
                self._settle(entries, f"{decision.action} requested: {decision.why}")
            except NotReady as error:
                log.info("%s run %s is not ready for a rerun yet: %s", repository, run_id, error)
            except httpx.HTTPError as error:
                log.warning("%s run %s: %s", repository, run_id, error)
                self._retry(entries)
        self._prune()

    def _settle(self, entries: list[LostJob], why: str) -> None:
        with self.lock:
            self.pending = [entry for entry in self.pending if entry not in entries]
        for entry in entries:
            log.info("%s run %s attempt %s (runner %s): %s", entry.repository, entry.run_id, entry.attempt, entry.runner, why)
        self._save()

    def _retry(self, entries: list[LostJob]) -> None:
        with self.lock:
            self.pending = [replace(entry, tries=entry.tries + 1) if entry in entries else entry for entry in self.pending]
        self._save()

    def _prune(self) -> None:
        now = self.clock()
        with self.lock:
            before = len(self.handled)
            self.handled = {uid: at for uid, at in self.handled.items() if now - at < KEEP_HANDLED_SECONDS}
            self.runners = {name: held for name, held in self.runners.items() if now - held["seen"] < KEEP_RUNNER_SECONDS}
            changed = len(self.handled) != before
        if changed:
            self._save()

    def _save(self) -> None:
        with self.lock:
            state = {"pending": [entry.to_dict() for entry in self.pending], "handled": dict(self.handled)}
        try:
            self.store.save(state)
        except Exception as error:  # the state is a convenience across restarts, not a condition to work
            log.warning("state not saved: %s", error)
