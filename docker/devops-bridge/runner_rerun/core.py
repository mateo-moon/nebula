"""
Decisions of the runner rerun controller, free of cluster and network code.

Pods and API objects are plain dicts in the shape the APIs return them, so the
rules below can be tested with literals.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass

DISRUPTION_CONDITION = "DisruptionTarget"
FINISHED_WELL = {"success", "skipped"}

WAIT = "wait"
DROP = "drop"
RERUN_JOB = "rerun-job"
RERUN_FAILED = "rerun-failed"


def over_its_own_limit(pod: dict) -> bool:
    """Evicted by the kubelet for exceeding a limit of the pod itself: the job's doing, and a rerun would repeat it."""
    status = pod.get("status") or {}
    return status.get("reason") == "Evicted" and "exceed" in (status.get("message") or "").lower()


def disruption_reason(pod: dict) -> str | None:
    """Why Kubernetes took the pod away (eviction, taint manager, pod GC, kubelet), if it did."""
    if over_its_own_limit(pod):
        return None
    for condition in (pod.get("status") or {}).get("conditions") or []:
        if condition.get("type") == DISRUPTION_CONDITION and condition.get("status") == "True":
            return condition.get("reason") or "Disrupted"
    return None


def lost_with_node(pod: dict, node_ready: bool | None) -> bool:
    """A pod deleted while it still ran, on a node that is gone (None) or not ready.

    Covers a deletion that carries no disruption condition. A runner removed
    while idle, or by hand, sits on a ready node and is not a loss.
    """
    return (pod.get("status") or {}).get("phase") == "Running" and node_ready is not True and not over_its_own_limit(pod)


def node_is_ready(node: dict | None) -> bool | None:
    if node is None:
        return None
    for condition in (node.get("status") or {}).get("conditions") or []:
        if condition.get("type") == "Ready":
            return condition.get("status") == "True"
    return False


@dataclass(frozen=True)
class LostJob:
    """A job whose runner was taken away with its node."""

    platform: str
    repository: str
    run_id: int
    attempt: int
    runner: str
    reason: str
    lost_at: float
    tries: int = 0

    @property
    def run_key(self) -> tuple[str, str, int]:
        return (self.platform, self.repository, self.run_id)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "LostJob":
        return cls(**{k: data[k] for k in cls.__dataclass_fields__ if k in data})


@dataclass(frozen=True)
class Decision:
    action: str
    why: str
    job_id: int | None = None


def decide(
    run: dict,
    jobs: list[dict],
    lost: list[LostJob],
    now: float,
    max_attempts: int = 3,
    max_wait: float = 6 * 3600,
    max_tries: int = 10,
) -> Decision:
    """What to do about the lost jobs of one run, given the run and its latest jobs."""
    attempt = int(run.get("run_attempt") or 1)
    if attempt > max(entry.attempt for entry in lost):
        return Decision(DROP, f"attempt {attempt} already started")
    if now - min(entry.lost_at for entry in lost) > max_wait:
        return Decision(DROP, "waited too long for the run to finish")
    if max(entry.tries for entry in lost) >= max_tries:
        return Decision(DROP, "the rerun request kept failing")
    if run.get("status") != "completed":
        return Decision(WAIT, f"run is {run.get('status')}")
    runners = {entry.runner for entry in lost}
    failed = [
        job for job in jobs
        if job.get("runner_name") in runners and job.get("conclusion") not in FINISHED_WELL
    ]
    if not failed:
        return Decision(DROP, "the job finished before its runner went")
    if attempt >= max_attempts:
        return Decision(DROP, f"attempt {attempt} is the last one allowed")
    if len(failed) == 1:
        return Decision(RERUN_JOB, f"runner {failed[0]['runner_name']} was lost", job_id=int(failed[0]["id"]))
    return Decision(RERUN_FAILED, f"{len(failed)} runners were lost")


def group_by_run(pending: list[LostJob]) -> dict[tuple[str, str, int], list[LostJob]]:
    runs: dict[tuple[str, str, int], list[LostJob]] = {}
    for entry in pending:
        runs.setdefault(entry.run_key, []).append(entry)
    return runs
