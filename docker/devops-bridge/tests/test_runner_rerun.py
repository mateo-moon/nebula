"""
Run from docker/devops-bridge:  python -m unittest discover -s tests
Needs httpx only; nothing here talks to a cluster or a network.
"""
import json
import unittest

import httpx

from runner_rerun.core import (
    DROP,
    RERUN_FAILED,
    RERUN_JOB,
    WAIT,
    LostJob,
    decide,
    disruption_reason,
    lost_with_node,
    node_is_ready,
)
from runner_rerun.platforms import Gitea, GitHub, NotReady
from runner_rerun.tracker import Tracker


def pod(name="runner-a", uid="u1", phase="Running", reason=None, labels=None):
    conditions = [{"type": "Ready", "status": "True"}]
    if reason:
        conditions.append({"type": "DisruptionTarget", "status": "True", "reason": reason})
    return {
        "metadata": {"name": name, "uid": uid, "labels": labels or {}},
        "spec": {"nodeName": "node-1"},
        "status": {"phase": phase, "conditions": conditions},
    }


def lost(runner="runner-a", attempt=1, lost_at=1000.0, tries=0, run_id=7):
    return LostJob("github", "acme/app", run_id, attempt, runner, "EvictionByEvictionAPI", lost_at, tries)


def job(job_id, runner, conclusion):
    return {"id": job_id, "name": f"job-{job_id}", "status": "completed", "conclusion": conclusion, "runner_name": runner}


class Rules(unittest.TestCase):
    def test_a_pod_kubernetes_took_away_carries_the_reason(self):
        self.assertEqual(disruption_reason(pod(reason="DeletionByPodGC")), "DeletionByPodGC")
        self.assertIsNone(disruption_reason(pod()))
        false_condition = pod()
        false_condition["status"]["conditions"].append({"type": "DisruptionTarget", "status": "False", "reason": "x"})
        self.assertIsNone(disruption_reason(false_condition))

    def test_a_pod_evicted_for_exceeding_its_own_limit_is_the_jobs_doing(self):
        own = pod(reason="TerminationByKubelet")
        own["status"].update(reason="Evicted", message="Pod ephemeral local storage usage exceeds the total limit of containers 25Gi.")
        self.assertIsNone(disruption_reason(own))
        self.assertFalse(lost_with_node(own, None))
        pressure = pod(reason="TerminationByKubelet")
        pressure["status"].update(reason="Evicted", message="The node was low on resource: ephemeral-storage.")
        self.assertEqual(disruption_reason(pressure), "TerminationByKubelet")

    def test_a_running_pod_deleted_on_a_ready_node_is_not_a_loss(self):
        self.assertFalse(lost_with_node(pod(), True))
        self.assertTrue(lost_with_node(pod(), False))
        self.assertTrue(lost_with_node(pod(), None))
        self.assertFalse(lost_with_node(pod(phase="Succeeded"), None))

    def test_node_readiness(self):
        self.assertIsNone(node_is_ready(None))
        self.assertTrue(node_is_ready({"status": {"conditions": [{"type": "Ready", "status": "True"}]}}))
        self.assertFalse(node_is_ready({"status": {"conditions": [{"type": "Ready", "status": "Unknown"}]}}))
        self.assertFalse(node_is_ready({"status": {}}))

    def test_the_run_must_have_finished(self):
        self.assertEqual(decide({"status": "in_progress", "run_attempt": 1}, [], [lost()], 1100).action, WAIT)

    def test_one_lost_job_is_rerun_alone_and_a_job_that_failed_itself_is_left(self):
        jobs = [job(11, "runner-a", "failure"), job(12, "runner-b", "failure"), job(13, "runner-c", "success")]
        decision = decide({"status": "completed", "conclusion": "failure", "run_attempt": 1}, jobs, [lost()], 1100)
        self.assertEqual((decision.action, decision.job_id), (RERUN_JOB, 11))

    def test_several_lost_jobs_of_a_run_are_rerun_together(self):
        jobs = [job(11, "runner-a", "failure"), job(12, "runner-b", "cancelled")]
        decision = decide({"status": "completed", "run_attempt": 1}, jobs, [lost(), lost("runner-b")], 1100)
        self.assertEqual(decision.action, RERUN_FAILED)

    def test_a_run_somebody_already_reran_is_left_alone(self):
        decision = decide({"status": "completed", "run_attempt": 2}, [job(11, "runner-a", "failure")], [lost()], 1100)
        self.assertEqual(decision.action, DROP)

    def test_the_last_attempt_allowed_is_not_exceeded(self):
        run = {"status": "completed", "run_attempt": 3}
        self.assertEqual(decide(run, [job(11, "runner-a", "failure")], [lost(attempt=3)], 1100).action, DROP)
        self.assertEqual(decide(run, [job(11, "runner-a", "failure")], [lost(attempt=3)], 1100, max_attempts=4).action, RERUN_JOB)

    def test_a_job_that_finished_before_its_runner_went_is_not_rerun(self):
        decision = decide({"status": "completed", "run_attempt": 1}, [job(11, "runner-a", "success")], [lost()], 1100)
        self.assertEqual(decision.action, DROP)

    def test_waiting_and_retrying_end(self):
        running = {"status": "in_progress", "run_attempt": 1}
        self.assertEqual(decide(running, [], [lost(lost_at=0)], 6 * 3600 + 1).action, DROP)
        self.assertEqual(decide(running, [], [lost(tries=10)], 1100).action, DROP)

    def test_a_lost_job_survives_the_state_file(self):
        entry = lost(tries=2)
        self.assertEqual(LostJob.from_dict(json.loads(json.dumps(entry.to_dict()))), entry)


class Apis(unittest.TestCase):
    def serve(self, routes):
        calls = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append((request.method, request.url.path, dict(request.url.params), request.headers.get("authorization")))
            status, body = routes[(request.method, request.url.path)]
            return httpx.Response(status, json=body)

        return httpx.Client(transport=httpx.MockTransport(handler)), calls

    def test_github(self):
        client, calls = self.serve({
            ("GET", "/repos/acme/app/actions/runs/7"): (200, {"status": "completed", "run_attempt": 2}),
            ("GET", "/repos/acme/app/actions/runs/7/jobs"): (200, {"jobs": [job(11, "runner-a", "failure")]}),
            ("POST", "/repos/acme/app/actions/jobs/11/rerun"): (201, {}),
            ("POST", "/repos/acme/app/actions/runs/7/rerun-failed-jobs"): (403, {"message": "This workflow is already in progress"}),
        })
        github = GitHub("t0ken", client=client)
        self.assertEqual(github.run("acme/app", 7)["run_attempt"], 2)
        self.assertEqual(github.jobs("acme/app", 7)[0]["id"], 11)
        github.rerun_job("acme/app", 7, 11)
        with self.assertRaises(NotReady):
            github.rerun_failed("acme/app", 7)
        self.assertEqual(calls[1][2], {"filter": "latest", "per_page": "100"})
        self.assertTrue(all(call[3] == "Bearer t0ken" for call in calls))

    def test_gitea(self):
        client, calls = self.serve({
            ("GET", "/api/v1/repos/acme/app/actions/runs/7"): (200, {"status": "completed", "run_attempt": 1}),
            ("GET", "/api/v1/repos/acme/app/actions/runs/7/jobs"): (200, {"jobs": [job(11, "runner-a", "failure")]}),
            ("GET", "/api/v1/repos/acme/app/actions/jobs"): (200, {"jobs": [], "total_count": 0}),
            ("POST", "/api/v1/repos/acme/app/actions/runs/7/jobs/11/rerun"): (201, {}),
            ("POST", "/api/v1/repos/acme/app/actions/runs/7/rerun-failed-jobs"): (409, {"message": "run is not done"}),
        })
        gitea = Gitea("https://git.example.com/", "t0ken", client=client)
        self.assertEqual(gitea.run("acme/app", 7)["status"], "completed")
        self.assertEqual(len(gitea.jobs("acme/app", 7)), 1)
        self.assertEqual(gitea.running("acme/app"), [])
        gitea.rerun_job("acme/app", 7, 11)
        with self.assertRaises(NotReady):
            gitea.rerun_failed("acme/app", 7)
        self.assertEqual(calls[2][2], {"status": "in_progress", "limit": "50"})
        self.assertTrue(all(call[3] == "token t0ken" for call in calls))

    def test_a_refusal_for_another_reason_is_an_error(self):
        client, _ = self.serve({("POST", "/repos/acme/app/actions/jobs/11/rerun"): (403, {"message": "Resource not accessible by personal access token"})})
        with self.assertRaises(httpx.HTTPStatusError):
            GitHub("t0ken", client=client).rerun_job("acme/app", 7, 11)


class Store:
    def __init__(self, state=None):
        self.state = state or {}

    def load(self):
        return self.state

    def save(self, state):
        self.state = json.loads(json.dumps(state))


class Platform:
    def __init__(self, run, jobs=(), running=()):
        self._run, self._jobs, self._running = run, list(jobs), list(running)
        self.reruns = []

    def run(self, repository, run_id):
        return self._run

    def jobs(self, repository, run_id):
        return self._jobs

    def running(self, repository):
        return self._running

    def rerun_job(self, repository, run_id, job_id):
        self.reruns.append(("job", repository, run_id, job_id))

    def rerun_failed(self, repository, run_id):
        self.reruns.append(("failed", repository, run_id))


ARC = {"kind": "arc", "namespace": "arc-runners"}
GITEA = {"kind": "gitea", "namespace": "gitea-runners", "instanceUrl": "https://git.example.com", "pools": {"infra": "acme/infra"}}


def arc_runner(name="runner-a", repository="acme/app", run_id=7):
    return {"metadata": {"name": name}, "status": {"jobRepositoryName": repository, "workflowRunId": run_id}}


class FromLossToRerun(unittest.TestCase):
    def tracker(self, platforms, store=None, **options):
        self.now = 1000.0
        return Tracker(platforms, store or Store(), clock=lambda: self.now, **options)

    def test_a_github_job_on_an_evicted_runner_is_rerun_once_its_run_has_finished(self):
        github = Platform({"status": "in_progress", "run_attempt": 1})
        tracker = self.tracker({"github": github})
        tracker.note_arc_runner(arc_runner())
        entry = tracker.pod_event(ARC, "MODIFIED", pod(reason="EvictionByEvictionAPI"), lambda: True)
        self.assertEqual((entry.repository, entry.run_id, entry.attempt), ("acme/app", 7, 1))
        self.assertIsNone(tracker.pod_event(ARC, "DELETED", pod(reason="EvictionByEvictionAPI"), lambda: None))

        tracker.process()
        self.assertEqual(github.reruns, [])
        github._run = {"status": "completed", "conclusion": "failure", "run_attempt": 1}
        github._jobs = [job(11, "runner-a", "failure"), job(12, "runner-z", "failure")]
        tracker.process()
        self.assertEqual(github.reruns, [("job", "acme/app", 7, 11)])
        self.assertEqual(tracker.pending, [])
        tracker.process()
        self.assertEqual(len(github.reruns), 1)

    def test_a_gitea_job_is_found_by_the_runner_that_holds_it(self):
        gitea = Platform(
            {"status": "completed", "conclusion": "failure", "run_attempt": 1},
            jobs=[job(21, "infra-abc-1", "failure")],
            running=[{"id": 21, "run_id": 9, "run_attempt": 1, "runner_name": "infra-abc-1"}],
        )
        tracker = self.tracker({"gitea": gitea})
        runner = pod("infra-abc-1", "u2", reason="DeletionByPodGC", labels={"gitea-runner/pool": "infra"})
        entry = tracker.pod_event(GITEA, "MODIFIED", runner, lambda: None)
        self.assertEqual((entry.platform, entry.repository, entry.run_id), ("gitea", "acme/infra", 9))
        tracker.process()
        self.assertEqual(gitea.reruns, [("job", "acme/infra", 9, 21)])

    def test_a_runner_deleted_with_its_node_counts_and_one_deleted_on_a_ready_node_does_not(self):
        github = Platform({"status": "completed", "run_attempt": 1}, jobs=[job(11, "runner-a", "failure")])
        tracker = self.tracker({"github": github})
        tracker.note_arc_runner(arc_runner())
        self.assertIsNone(tracker.pod_event(ARC, "DELETED", pod(), lambda: True))
        self.assertIsNotNone(tracker.pod_event(ARC, "DELETED", pod(), lambda: None))

    def test_an_idle_runner_and_a_job_that_ended_are_left_alone(self):
        github = Platform({"status": "completed", "run_attempt": 1})
        tracker = self.tracker({"github": github})
        self.assertIsNone(tracker.pod_event(ARC, "MODIFIED", pod(reason="EvictionByEvictionAPI"), lambda: True))
        tracker.note_arc_runner(arc_runner("runner-b"))
        self.assertIsNone(tracker.pod_event(ARC, "MODIFIED", pod("runner-b", "u3", phase="Succeeded"), lambda: True))
        tracker.process()
        self.assertEqual(github.reruns, [])

    def test_a_dry_run_and_a_missing_token_ask_for_nothing(self):
        github = Platform({"status": "completed", "run_attempt": 1}, jobs=[job(11, "runner-a", "failure")])
        tracker = self.tracker({"github": github}, dry_run=True)
        tracker.note_arc_runner(arc_runner())
        tracker.pod_event(ARC, "MODIFIED", pod(reason="EvictionByEvictionAPI"), lambda: True)
        tracker.process()
        self.assertEqual((github.reruns, tracker.pending), ([], []))

        no_token = self.tracker({"github": None})
        no_token.note_arc_runner(arc_runner())
        self.assertIsNone(no_token.pod_event(ARC, "MODIFIED", pod(reason="EvictionByEvictionAPI"), lambda: True))

    def test_what_is_pending_survives_a_restart(self):
        store = Store()
        github = Platform({"status": "in_progress", "run_attempt": 1})
        first = self.tracker({"github": github}, store)
        first.note_arc_runner(arc_runner())
        first.pod_event(ARC, "MODIFIED", pod(reason="EvictionByEvictionAPI"), lambda: True)

        github._run = {"status": "completed", "run_attempt": 1}
        github._jobs = [job(11, "runner-a", "failure")]
        second = self.tracker({"github": github}, store)
        self.assertEqual(len(second.pending), 1)
        self.assertIsNone(second.pod_event(ARC, "MODIFIED", pod(reason="EvictionByEvictionAPI"), lambda: True))
        second.process()
        self.assertEqual(github.reruns, [("job", "acme/app", 7, 11)])

    def test_a_failing_request_is_retried_and_counted(self):
        class Failing(Platform):
            def rerun_job(self, repository, run_id, job_id):
                raise httpx.ConnectError("no route")

        github = Failing({"status": "completed", "run_attempt": 1}, jobs=[job(11, "runner-a", "failure")])
        tracker = self.tracker({"github": github})
        tracker.note_arc_runner(arc_runner())
        tracker.pod_event(ARC, "MODIFIED", pod(reason="EvictionByEvictionAPI"), lambda: True)
        tracker.process()
        self.assertEqual([entry.tries for entry in tracker.pending], [1])


if __name__ == "__main__":
    unittest.main()
