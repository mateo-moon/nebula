"""
The two Actions APIs the controller talks to. Gitea's follows GitHub's: a run
has `status`, `conclusion` and `run_attempt`, a job has `runner_name`.
"""
from __future__ import annotations

import httpx

TIMEOUT = httpx.Timeout(20.0)


class NotReady(Exception):
    """The platform refused the rerun for now (the run is not finished)."""


class GitHub:
    name = "github"

    def __init__(self, token: str, base_url: str = "https://api.github.com", client: httpx.Client | None = None) -> None:
        self.client = client or httpx.Client(timeout=TIMEOUT)
        self.base_url = base_url.rstrip("/")
        self.headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _get(self, path: str, **params) -> dict:
        response = self.client.get(f"{self.base_url}{path}", headers=self.headers, params=params)
        response.raise_for_status()
        return response.json()

    def _post(self, path: str) -> None:
        response = self.client.post(f"{self.base_url}{path}", headers=self.headers)
        if response.status_code in (403, 409) and "progress" in response.text.lower():
            raise NotReady(response.text[:200])
        response.raise_for_status()

    def run(self, repository: str, run_id: int) -> dict:
        return self._get(f"/repos/{repository}/actions/runs/{run_id}")

    def jobs(self, repository: str, run_id: int) -> list[dict]:
        return self._get(f"/repos/{repository}/actions/runs/{run_id}/jobs", filter="latest", per_page=100).get("jobs") or []

    def rerun_job(self, repository: str, run_id: int, job_id: int) -> None:
        self._post(f"/repos/{repository}/actions/jobs/{job_id}/rerun")

    def rerun_failed(self, repository: str, run_id: int) -> None:
        self._post(f"/repos/{repository}/actions/runs/{run_id}/rerun-failed-jobs")


class Gitea:
    name = "gitea"

    def __init__(self, base_url: str, token: str, client: httpx.Client | None = None) -> None:
        self.client = client or httpx.Client(timeout=TIMEOUT)
        self.base_url = f"{base_url.rstrip('/')}/api/v1"
        self.headers = {"Authorization": f"token {token}"}

    def _get(self, path: str, **params) -> dict:
        response = self.client.get(f"{self.base_url}{path}", headers=self.headers, params=params)
        response.raise_for_status()
        return response.json()

    def _post(self, path: str) -> None:
        response = self.client.post(f"{self.base_url}{path}", headers=self.headers)
        if response.status_code == 409:
            raise NotReady(response.text[:200])
        response.raise_for_status()

    def run(self, repository: str, run_id: int) -> dict:
        return self._get(f"/repos/{repository}/actions/runs/{run_id}")

    def jobs(self, repository: str, run_id: int) -> list[dict]:
        return self._get(f"/repos/{repository}/actions/runs/{run_id}/jobs", limit=50).get("jobs") or []

    def running(self, repository: str) -> list[dict]:
        """The jobs a runner holds right now."""
        return self._get(f"/repos/{repository}/actions/jobs", status="in_progress", limit=50).get("jobs") or []

    def rerun_job(self, repository: str, run_id: int, job_id: int) -> None:
        self._post(f"/repos/{repository}/actions/runs/{run_id}/jobs/{job_id}/rerun")

    def rerun_failed(self, repository: str, run_id: int) -> None:
        self._post(f"/repos/{repository}/actions/runs/{run_id}/rerun-failed-jobs")
