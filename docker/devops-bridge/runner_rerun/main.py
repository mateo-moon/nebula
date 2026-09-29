"""
Runner rerun controller: reruns a CI job whose runner was taken away with its
node (a reclaimed Spot instance, a drained or failed node), and no other.

A job on a lost runner is not moved anywhere. GitHub and Gitea show it as in
progress until they give the runner up, mark it failed, and leave it there.
This controller watches the runner pods, and when Kubernetes takes one away
(the pod carries the DisruptionTarget condition, or is deleted while running
on a node that is gone or not ready) it notes the job the runner held. Once
the run has finished it asks for that job to run again, unless the run has
already started another attempt or reached the last one allowed. A job that
failed on its own is never rerun: its runner pod ended, it was not taken.

Which job a runner holds:
  - Actions Runner Controller: the EphemeralRunner's status names the
    repository and the workflow run.
  - Gitea (runner pods created per queued job): the jobs in progress name
    their runner, which is the pod.

Config (JSON file at RERUN_CONFIG, default /etc/runner-rerun/config.json):
  {"maxAttempts": 3, "maxWaitSeconds": 21600, "sources": [
    {"kind": "arc", "namespace": "arc-runners"},
    {"kind": "gitea", "namespace": "gitea-runners", "instanceUrl": "https://git.example.com",
     "poolLabel": "gitea-runner/pool", "pools": {"infra": "platform/infra"}}]}

Env:
  GITHUB_TOKEN     Actions read and write on the repositories; without it GitHub jobs are only logged
  GITEA_TOKEN      the same for Gitea
  DRY_RUN          "true": log the rerun instead of asking for it
  POD_NAMESPACE    where the state ConfigMap lives
  STATE_CONFIGMAP  default "runner-rerun-state"

RBAC: get/list/watch pods and ephemeralrunners in the runner namespaces, get
nodes, and get/create/update the state ConfigMap in its own namespace.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time

import httpx
from kubernetes import client, config, watch
from kubernetes.client.rest import ApiException

from .core import node_is_ready
from .platforms import Gitea, GitHub
from .tracker import Tracker

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
logging.getLogger("httpx").setLevel(logging.WARNING)
log = logging.getLogger("runner-rerun")

ARC_GROUP, ARC_VERSION, ARC_PLURAL = "actions.github.com", "v1alpha1", "ephemeralrunners"
PROCESS_SECONDS = 30
GITEA_POLL_SECONDS = 15


class ConfigMapStore:
    def __init__(self, core: client.CoreV1Api, namespace: str, name: str) -> None:
        self.core, self.namespace, self.name = core, namespace, name

    def load(self) -> dict:
        try:
            return json.loads(self.core.read_namespaced_config_map(self.name, self.namespace).data.get("state", "{}"))
        except ApiException as error:
            if error.status != 404:
                raise
            return {}

    def save(self, state: dict) -> None:
        body = client.V1ConfigMap(metadata=client.V1ObjectMeta(name=self.name), data={"state": json.dumps(state)})
        try:
            self.core.replace_namespaced_config_map(self.name, self.namespace, body)
        except ApiException as error:
            if error.status != 404:
                raise
            self.core.create_namespaced_config_map(self.namespace, body)


def follow(what: str, list_call, handle, **arguments) -> None:
    """List, then watch from there; start over when the watch ends or fails."""
    while True:
        try:
            listing = list_call(**arguments)
            if isinstance(listing, dict):
                items, version = listing["items"], listing["metadata"]["resourceVersion"]
            else:
                items, version = listing.items, listing.metadata.resource_version
            for item in items:
                handle("MODIFIED", item)
            for event in watch.Watch().stream(list_call, resource_version=version, timeout_seconds=300, **arguments):
                handle(event["type"], event["object"])
        except ApiException as error:
            if error.status != 410:
                log.warning("%s: %s", what, error.reason)
                time.sleep(5)
        except Exception as error:
            log.warning("%s: %s", what, error)
            time.sleep(5)


def main() -> None:
    with open(os.getenv("RERUN_CONFIG", "/etc/runner-rerun/config.json")) as file:
        settings = json.load(file)
    try:
        config.load_incluster_config()
    except config.ConfigException:
        config.load_kube_config()
    core, custom, api = client.CoreV1Api(), client.CustomObjectsApi(), client.ApiClient()

    gitea_url = next((source["instanceUrl"] for source in settings["sources"] if source["kind"] == "gitea"), None)
    platforms = {
        "github": GitHub(os.environ["GITHUB_TOKEN"]) if os.getenv("GITHUB_TOKEN") else None,
        "gitea": Gitea(gitea_url, os.environ["GITEA_TOKEN"]) if gitea_url and os.getenv("GITEA_TOKEN") else None,
    }
    tracker = Tracker(
        platforms,
        ConfigMapStore(core, os.environ["POD_NAMESPACE"], os.getenv("STATE_CONFIGMAP", "runner-rerun-state")),
        max_attempts=int(settings.get("maxAttempts", 3)),
        max_wait=float(settings.get("maxWaitSeconds", 6 * 3600)),
        dry_run=os.getenv("DRY_RUN", "").lower() == "true",
    )
    log.info("watching %s; tokens: %s; %d jobs pending from before",
             [f"{source['kind']}:{source['namespace']}" for source in settings["sources"]],
             [name for name, platform in platforms.items() if platform], len(tracker.pending))

    def node_ready_of(pod: dict):
        def ask() -> bool | None:
            try:
                return node_is_ready(api.sanitize_for_serialization(core.read_node(pod["spec"]["nodeName"])))
            except ApiException as error:
                if error.status == 404:
                    return None
                raise
        return ask

    def start(target, *arguments, **keywords) -> None:
        threading.Thread(target=target, args=arguments, kwargs=keywords, daemon=True).start()

    for source in settings["sources"]:
        def on_pod(event: str, pod, source=source) -> None:
            pod = api.sanitize_for_serialization(pod)
            if pod.get("spec", {}).get("nodeName"):
                tracker.pod_event(source, event, pod, node_ready_of(pod))

        start(follow, f"pods in {source['namespace']}", core.list_namespaced_pod, on_pod, namespace=source["namespace"])
        if source["kind"] == "arc":
            start(follow, f"runners in {source['namespace']}", custom.list_namespaced_custom_object,
                  lambda event, runner: tracker.note_arc_runner(runner),
                  group=ARC_GROUP, version=ARC_VERSION, namespace=source["namespace"], plural=ARC_PLURAL)

    def poll_gitea() -> None:
        repositories = sorted({repository for source in settings["sources"] if source["kind"] == "gitea"
                               for repository in (source.get("pools") or {}).values()})
        while True:
            for repository in repositories:
                try:
                    tracker.note_gitea_jobs(repository, platforms["gitea"].running(repository))
                except httpx.HTTPError as error:
                    log.warning("jobs in progress of %s: %s", repository, error)
            time.sleep(GITEA_POLL_SECONDS)

    if platforms["gitea"]:
        start(poll_gitea)

    while True:
        time.sleep(PROCESS_SECONDS)
        tracker.process()


if __name__ == "__main__":
    main()
