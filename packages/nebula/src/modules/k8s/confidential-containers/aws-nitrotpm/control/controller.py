"""Reconcile the reusable module. All persisted data is public intent/status.

Workload keys enter the authority only through the separately authenticated
owner publisher, never through this controller, its CR, or Kubernetes Secrets.
"""
import base64
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import threading
import time
from datetime import datetime, timezone, timedelta

import boto3
from botocore.exceptions import ClientError
from cloud import Cloud, Pending, require
from kube import Kube, ApiError, credential_environment

FINALIZER = "coco.nebula.io/aws-resources"
RUNTIME_CLASS = "kata-remote-aws-nitrotpm"
APPROVAL_ANNOTATION = "coco.nebula.io/approval"
LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")


class Lease:
    """Control-plane work serialization only; never an authority/key lease."""
    def __init__(self, kube, name, holder):
        self.kube, self.holder = kube, holder
        self.path = f"/apis/coordination.k8s.io/v1/namespaces/{kube.namespace}/leases/{name}"
        self.until = 0.0
        self.stop = threading.Event()
        self.started = False

    def renew(self):
        now = datetime.now(timezone.utc)
        obj = self.kube.get(self.path)
        spec = obj.get("spec", {})
        previous = datetime.fromisoformat(spec.get("renewTime", "1970-01-01T00:00:00+00:00").replace("Z", "+00:00"))
        require(not spec.get("holderIdentity") or spec["holderIdentity"] == self.holder or
                previous + timedelta(seconds=spec.get("leaseDurationSeconds", 30)) < now, "another controller holds the lease")
        self.kube.patch(self.path, {"metadata": {"resourceVersion": obj["metadata"]["resourceVersion"]},
            "spec": {"holderIdentity": self.holder, "leaseDurationSeconds": 30, "renewTime": now.isoformat()}})
        self.until = time.monotonic() + 20

    def require_current(self, **_):
        if self.until <= time.monotonic(): raise Pending("ControllerLeaseLost")

    def start(self):
        self.renew()
        def loop():
            while not self.stop.wait(5):
                try: self.renew()
                except (ApiError, OSError, ValueError): self.until = 0
        threading.Thread(target=loop, daemon=True).start()
        self.started = True


def inspect_authority(addresses, profile, deployment, identity=None, binary="/usr/local/bin/aws-trustee-bootstrap"):
    def inspect(address):
        config = {"address": address + ":9444", "profile": profile, "deployment": deployment, "expectedIdentity": identity}
        result = subprocess.run([binary, "--inspect-authority"], input=(json.dumps(config) + "\n").encode(),
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=50, check=False)
        require(result.returncode == 0 and len(result.stdout) < 16384, "attested quorum unavailable")
        answer = json.loads(result.stdout)
        require(answer["kind"] == "health" and answer["body"]["status"]["deployment"] == deployment, "invalid attested health")
        return answer["body"]
    # Only the current leader answers a fresh quorum barrier. All failures are
    # opaque: verifier internals and network payloads never enter cluster logs.
    with ThreadPoolExecutor(max_workers=3) as pool:
        pending = [pool.submit(inspect, address) for address in addresses]
        for future in as_completed(pending):
            try: return future.result()
            except (OSError, ValueError, KeyError, subprocess.TimeoutExpired): pass
    return None


def validate_spec(spec, release):
    require(set(spec) == {"deployment", "region", "placement", "genesis", "release"}, "unexpected module settings")
    require(spec["release"] == release["id"] and release["version"] == 1, "controller/release mismatch")
    require(spec["region"] in ("eu-west-1", "us-east-2"), "unsupported SNP region")
    require(set(spec["placement"]) == {"vpcId", "workerSecurityGroupIds"}, "invalid platform placement")
    require(re.fullmatch(r"vpc-[a-f0-9]{17}", spec["placement"]["vpcId"]), "invalid platform VPC")
    groups = spec["placement"]["workerSecurityGroupIds"]
    require(1 <= len(groups) <= 10 and len(set(groups)) == len(groups) and
            all(re.fullmatch(r"sg-[a-f0-9]{17}", group) for group in groups), "invalid platform worker groups")
    envelope = spec["genesis"]
    raw = base64.b64decode(envelope["payload"], validate=True)
    require(len(raw) <= 16384 and hashlib.sha256(raw).hexdigest() == spec["deployment"], "genesis commitment mismatch")
    genesis = json.loads(raw)
    require(genesis["authorityRelease"] == release["authority"]["profile"]["release"] and
            genesis["runtimeReleases"] == [release["runtime"]["profile"]["release"]], "genesis/release mismatch")
    # The immutable guest verifies canonical encoding and DSSE signatures. This
    # is just bounded configuration validation in the untrusted control plane.


class Controller:
    def __init__(self, kube, name, release, session_factory, verifier=inspect_authority):
        self.kube, self.name, self.release = kube, name, release
        self.session_factory, self.verifier = session_factory, verifier
        self.path = f"/apis/coco.nebula.io/v1alpha1/namespaces/{kube.namespace}/awsconfidentialruntimes/{name}"
        self.obj = None

    def checkpoint(self, phase, cursors, **public):
        old = next((item for item in self.obj.get("status", {}).get("conditions", []) if item["type"] == "Ready"), {})
        transition = old.get("lastTransitionTime") if old.get("reason") == phase else None
        status = {**self.obj.get("status", {}), **public, "phase": phase, "cursors": cursors,
                  "observedGeneration": self.obj["metadata"]["generation"],
                  "conditions": [{"type": "Ready", "status": "True" if phase == "Ready" else "False", "reason": phase,
                                  "lastTransitionTime": transition or datetime.now(timezone.utc).isoformat()}]}
        self.obj = self.kube.patch(self.path + "/status", {"metadata": {"resourceVersion": self.obj["metadata"]["resourceVersion"]}, "status": status})

    def peer_config(self, cloud, values):
        path = f"/api/v1/namespaces/{self.kube.namespace}/configmaps/peer-pods-cm"
        cm = self.kube.get(path)
        if any(cm.get("data", {}).get(key) != value for key, value in values.items()):
            self.kube.patch(path, {"data": values})
        # ConfigMap envFrom is read at container start, so reconcile the rollout
        # after the ConfigMap as a separate idempotent step (including crashes).
        credentials = self.kube.get(f"/api/v1/namespaces/{self.kube.namespace}/secrets/{self.name}-caa")["metadata"]["resourceVersion"]
        stamp = hashlib.sha256(json.dumps([values, credentials], sort_keys=True).encode()).hexdigest()
        path = f"/apis/apps/v1/namespaces/{self.kube.namespace}/daemonsets/cloud-api-adaptor-daemonset"
        ds = self.kube.get(path)
        if ds["spec"]["template"]["metadata"].get("annotations", {}).get("coco.nebula.io/config") != stamp:
            self.kube.patch(path, {"spec": {"template": {"metadata": {"annotations": {"coco.nebula.io/config": stamp}}}}})
        credentials = self.kube.get(f"/api/v1/namespaces/{self.kube.namespace}/secrets/{self.name}-cleanup")["metadata"]["resourceVersion"]
        path = f"/apis/apps/v1/namespaces/{self.kube.namespace}/deployments/{os.environ['NEBULA_CLEANUP_DEPLOYMENT']}"
        cleanup = self.kube.get(path)
        if cleanup["spec"]["template"]["metadata"].get("annotations", {}).get("coco.nebula.io/credentials") != credentials:
            self.kube.patch(path, {"spec": {"template": {"metadata": {"annotations": {"coco.nebula.io/credentials": credentials}}}}})

    def pod_intents(self, cloud, common, active=None):
        active = set(active or ())
        for pod in self.kube.items("/api/v1/pods"):
            if pod["spec"].get("runtimeClassName") != RUNTIME_CLASS or pod["metadata"].get("deletionTimestamp"): continue
            namespace, name = pod["metadata"]["namespace"], pod["metadata"]["name"]
            reference = pod["metadata"].get("annotations", {}).get(APPROVAL_ANNOTATION, "")
            if not LABEL.fullmatch(reference): continue
            try: approval = self.kube.get(f"/api/v1/namespaces/{namespace}/configmaps/{reference}")
            except ApiError as error:
                if error.status == 404: continue
                raise
            if approval["metadata"].get("annotations", {}).get("coco.nebula.io/deployment") != common["deployment"]: continue
            data = approval.get("data", {})
            require(set(data) == {"descriptor.json", "grant.json"} and sum(len(s) for s in data.values()) <= 400 * 1024,
                    "public workload intent too large")
            key = f"boot/{common['deployment']}/pods/{namespace}/{name}.json"
            cloud.put_configuration(key, {"common": common, "descriptor": json.loads(data["descriptor.json"]), "grant": json.loads(data["grant.json"])})
            active.add(key)
        # Remove only obsolete public routing intent, never protected approvals.
        prefix = f"boot/{common['deployment']}/pods/"
        for page in cloud.s3.get_paginator("list_objects_v2").paginate(Bucket=cloud.bucket, Prefix=prefix):
            obsolete = [{"Key": item["Key"]} for item in page.get("Contents", []) if item["Key"] not in active]
            if obsolete: cloud.s3.delete_objects(Bucket=cloud.bucket, Delete={"Objects": obsolete, "Quiet": True})

    def canary(self, cloud, common, addresses, cursors):
        name = "nebula-runtime-canary"
        key = f"boot/{common['deployment']}/pods/{self.kube.namespace}/{name}.json"
        path = f"/api/v1/namespaces/{self.kube.namespace}/pods/{name}"
        try:
            pod = self.kube.get(path)
        except ApiError as error:
            if error.status != 404: raise
            pod = None
        bundle = None
        # The definition is constructed by the measured authority from its
        # immutable public test image/policy, not from a controller-supplied key.
        for address in addresses:
            try:
                result = subprocess.run(["/usr/local/bin/aws-trustee-bootstrap", "--canary-intent"],
                    input=(json.dumps({"address": address + ":9444", "profile": common["authorityProfile"],
                        "deployment": common["deployment"], "expectedIdentity": cursors["authorityIdentity"]}) + "\n").encode(),
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=50, check=False)
                require(result.returncode == 0 and len(result.stdout) < 512 * 1024, "canary enrollment unavailable")
                response = json.loads(result.stdout)
                require(response["kind"] == "canary", "invalid canary response")
                bundle = response["body"]["bundle"]
                break
            except (ValueError, KeyError, OSError, subprocess.TimeoutExpired): pass
        if not bundle: raise Pending("WaitingForCanaryEnrollment")
        descriptor = json.loads(base64.b64decode(bundle["descriptor"]["payload"], validate=True))
        require(descriptor["workload"] == name and len(descriptor["images"]) == 1, "invalid canary scope")
        image = descriptor["images"][0]
        cloud.put_configuration(key, {"common": common, **bundle})
        if pod:
            require(any(ref.get("uid") == self.obj["metadata"]["uid"] for ref in pod["metadata"].get("ownerReferences", [])), "foreign canary Pod refused")
            require(pod["spec"]["runtimeClassName"] == RUNTIME_CLASS and pod["spec"]["containers"][0]["image"] == image,
                    "canary Pod differs from measured release")
            status = pod.get("status", {})
            if status.get("phase") == "Succeeded":
                containers = status.get("containerStatuses", [])
                require(len(containers) == 1 and containers[0].get("state", {}).get("terminated", {}).get("exitCode") == 0,
                        "canary did not complete")
                return True, key
            if status.get("phase") == "Failed":
                failures = cursors.setdefault("failedCanaries", [])
                if pod["metadata"]["uid"] not in failures:
                    failures.append(pod["metadata"]["uid"])
                    self.checkpoint("RetryingRuntimeCanary", cursors)
                if len(failures) >= 3: raise Pending("RuntimeCanaryFailed")
                self.kube.request("DELETE", path, {"apiVersion": "v1", "kind": "DeleteOptions",
                    "preconditions": {"uid": pod["metadata"]["uid"]}})
                raise Pending("RetryingRuntimeCanary")
            return False, key
        self.kube.request("POST", f"/api/v1/namespaces/{self.kube.namespace}/pods", {"apiVersion": "v1", "kind": "Pod",
            "metadata": {"name": name, "namespace": self.kube.namespace, "ownerReferences": [{"apiVersion": self.obj["apiVersion"],
                "kind": self.obj["kind"], "name": self.name, "uid": self.obj["metadata"]["uid"], "controller": True}]},
            "spec": {"runtimeClassName": RUNTIME_CLASS, "restartPolicy": "Never", "automountServiceAccountToken": False,
                "activeDeadlineSeconds": 900, "containers": [{"name": "canary", "image": image, "imagePullPolicy": "Always",
                    "securityContext": {"runAsNonRoot": True, "runAsUser": 65532, "allowPrivilegeEscalation": False,
                        "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
                    "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"cpu": "100m", "memory": "64Mi"}}}]}})
        return False, key

    def reconcile(self):
        self.obj = self.kube.get(self.path)
        metadata, spec = self.obj["metadata"], self.obj["spec"]
        validate_spec(spec, self.release)
        cursors = self.obj.get("status", {}).get("cursors", {})
        finalizers = metadata.get("finalizers", [])
        if FINALIZER not in finalizers:
            if metadata.get("deletionTimestamp"): return
            self.obj = self.kube.patch(self.path, {"metadata": {"resourceVersion": metadata["resourceVersion"], "finalizers": finalizers + [FINALIZER]}})
        cloud = Cloud(self.session_factory(), spec["deployment"], spec["region"], spec["placement"], self.checkpoint)
        try:
            if metadata.get("deletionTimestamp"):
                self.checkpoint("Deleting", cursors)
                cloud.delete(cursors)
                self.kube.patch(self.path, {"metadata": {"resourceVersion": self.obj["metadata"]["resourceVersion"],
                    "finalizers": [f for f in finalizers if f != FINALIZER]}})
                return
            cloud.storage(cursors)
            images = {role: cloud.image(role, self.release[role]["artifact"], cursors) for role in ("authority", "runtime")}
            subnets = cloud.network()
            authority_group, runtime_group = cloud.group("authority"), cloud.group("runtime")
            for source in (authority_group, runtime_group): cloud.ingress(authority_group, "tcp", 9443, "replication", source=source)
            cloud.ingress(authority_group, "tcp", 9444, "publisher", cidr="0.0.0.0/0")
            for group in spec["placement"]["workerSecurityGroupIds"]:
                cloud.ingress(runtime_group, "tcp", 15150, "agent", source=group)
                cloud.ingress(runtime_group, "udp", 4789, "runtime-tunnel", source=group)
                cloud.ingress(group, "udp", 4789, "worker-tunnel", source=runtime_group)
            interfaces = cloud.interfaces(subnets, authority_group)
            common = {"version": 1, "deployment": spec["deployment"], "genesis": spec["genesis"],
                      "authorityProfile": self.release["authority"]["profile"], "runtimeProfiles": [self.release["runtime"]["profile"]],
                      "peers": [interface["PrivateIpAddress"] for interface in interfaces]}
            cloud.put_configuration(f"boot/{spec['deployment']}/authority.json", common)
            addresses = [interface["PublicAddress"] for interface in interfaces]
            old_identity = cursors.get("authorityIdentity")
            health = self.verifier(addresses, common["authorityProfile"], spec["deployment"], old_identity)
            stable = bool(health and len(health["voters"]) == 3 and not health["joint"] and not health["replacing"])
            if health and not old_identity:
                cursors["authorityIdentity"] = health["status"]["authorityIdentity"]
                self.checkpoint("AuthorityEnrolled", cursors)
            # One replacement per pass, and only while a fresh quorum confirms
            # its protected uniform membership. Initial creation needs no key.
            replaced = False
            for slot, interface in enumerate(interfaces):
                member = next((peer for peer in health["voters"].values() if peer.get("address") == interface["PrivateIpAddress"] + ":9443"), None) if health else None
                instance = cloud.authority(slot, interface, images["authority"], common, cursors,
                    allow_replace=stable and not replaced, previous_peer=member.get("publicKey") if member else None)
                cloud.attach_state(instance)
                if instance.get("NebulaReplacement"): replaced = True
            template = cloud.runtime_template(images["runtime"], subnets[0]["SubnetId"], runtime_group, common["runtimeProfiles"][0]["release"])
            if not stable: raise Pending("WaitingForAuthorityQuorum")
            cloud.collect_retired(interfaces, health, cursors)
            values = {"AWS_REGION": spec["region"], "AWS_SUBNET_ID": subnets[0]["SubnetId"], "AWS_SG_IDS": runtime_group,
                      "PODVM_AMI_ID": images["runtime"], "PODVM_INSTANCE_TYPE": "c6a.large", "PODVM_LAUNCHTEMPLATE_NAME": template}
            self.peer_config(cloud, values)
            passed, canary_key = self.canary(cloud, common, addresses, cursors)
            self.pod_intents(cloud, common, [canary_key])
            # Kubernetes readiness reports installation progress. It is never
            # an authorization input to the protected authority's key gate.
            phase = "Ready" if passed else "WaitingForRuntimeCanary"
            self.checkpoint(phase, cursors, endpoints=[address + ":9444" for address in addresses],
                authority={"identity": cursors["authorityIdentity"], "replicas": 3}, images=images)
        except Pending as pending:
            self.checkpoint(str(pending), cursors)


def main():
    kube = Kube()
    name, holder = os.environ["NEBULA_RUNTIME_NAME"], os.environ["POD_UID"]
    require(LABEL.fullmatch(name), "invalid runtime name")
    release = json.loads(Path("/usr/share/nebula/release.json").read_text())
    lease = Lease(kube, name, holder)
    def session():
        current = boto3.Session(**credential_environment("/var/run/secrets/nebula-aws"))
        current.events.register("before-call.*.*", lease.require_current)
        return current
    controller = Controller(kube, name, release, session)
    while True:
        try:
            if not lease.started: lease.start()
            lease.require_current()
            controller.reconcile()
        except (ApiError, ClientError, ValueError, OSError, KeyError, Pending):
            # Fixed diagnostic only. Never serialize API responses or credentials.
            if controller.obj:
                try: controller.checkpoint("ReconciliationRetry", controller.obj.get("status", {}).get("cursors", {}))
                except (ApiError, OSError): pass
        time.sleep(10)


if __name__ == "__main__": main()
