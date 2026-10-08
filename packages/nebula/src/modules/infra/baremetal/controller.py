"""Namespace-scoped SSH baremetal provisioning and pooled k0s handoff."""
import base64
import copy
import datetime
import json
import os
from pathlib import Path
import shlex
import ssl
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from installer import canonical, fingerprint, validate_spec

API = "/apis/baremetal.nebula.io/v1alpha1/namespaces/{}/sshbaremetalhosts"
RETAIN = "baremetal.nebula.io/retain-host"
BINDING = "baremetal.nebula.io/request-uid"
BOOTSTRAP = """set -eu
if [ ! -d /run/systemd/system ] || [ "$(uname -m)" != x86_64 ]; then
  printf '%s\\n' '{"error":"source host must be x86_64 Linux running systemd"}'
  exit 1
fi
missing=false
for utility in python3 ip lsblk findmnt pvs; do
  command -v "$utility" >/dev/null 2>&1 || missing=true
done
if [ "$missing" = true ]; then
  if [ -d /var/lib/k0s ] || [ -f /etc/kubernetes/kubelet.conf ]; then
    printf '%s\\n' '{"error":"existing Kubernetes installation: refusing fresh OS installation"}'
    exit 1
  fi
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update >&2
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 iproute2 util-linux lvm2 ca-certificates >&2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3 iproute util-linux lvm2 ca-certificates >&2
  else
    printf '%s\\n' '{"error":"source needs Python 3, iproute, util-linux and LVM tools, or apt/dnf to install them"}'
    exit 1
  fi
fi
exec "$@"
"""
KINDS = {
    "PooledRemoteMachine": ("infrastructure.cluster.x-k8s.io/v1beta2", "pooledremotemachines"),
    "RemoteMachineTemplate": ("infrastructure.cluster.x-k8s.io/v1beta2", "remotemachinetemplates"),
    "K0sWorkerConfigTemplate": ("bootstrap.cluster.x-k8s.io/v1beta2", "k0sworkerconfigtemplates"),
    "MachineDeployment": ("cluster.x-k8s.io/v1beta2", "machinedeployments"),
    "MutatingAdmissionPolicy": ("admissionregistration.k8s.io/v1", "mutatingadmissionpolicies"),
    "MutatingAdmissionPolicyBinding": ("admissionregistration.k8s.io/v1", "mutatingadmissionpolicybindings"),
    "ValidatingAdmissionPolicy": ("admissionregistration.k8s.io/v1", "validatingadmissionpolicies"),
    "ValidatingAdmissionPolicyBinding": ("admissionregistration.k8s.io/v1", "validatingadmissionpolicybindings"),
}


class Kubernetes:
    def __init__(self, server, context, token=None):
        self.server, self.context, self.token = server.rstrip("/"), context, token
        parsed = urllib.parse.urlparse(server)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ValueError("Kubernetes endpoint must use verified HTTPS")

    def request(self, method, path, value=None, content_type="application/merge-patch+json"):
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token()
        if value is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(self.server + path, headers=headers, method=method,
                                         data=None if value is None else canonical(value).encode())
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if method == "GET" and error.code == 404:
                return None
            # Kubernetes failure bodies may contain submitted Secret fields.
            raise RuntimeError(f"Kubernetes {method} failed with HTTP {error.code}") from None

    def secret(self, namespace, name, key):
        if not name or "/" in name:
            raise ValueError("invalid Secret name")
        value = self.request("GET", f"/api/v1/namespaces/{namespace}/secrets/{name}")
        if not value or key not in value.get("data", {}):
            raise ValueError("required Secret or key is missing")
        return base64.b64decode(value["data"][key], validate=True)


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def conditions(host, reason, message):
    ready = host.get("status", {}).get("phase") == "Ready" and reason == "WorkerReady"
    return [{"type": "Ready", "status": "True" if ready else "False",
             "observedGeneration": host["metadata"].get("generation", 1),
             "reason": reason, "message": message, "lastTransitionTime": timestamp()}]


def save(api, host, **changes):
    status = {**host.get("status", {}), **changes}
    path = API.format(host["metadata"]["namespace"]) + "/" + host["metadata"]["name"] + "/status"
    result = api.request("PATCH", path, {"metadata": {"resourceVersion": host["metadata"]["resourceVersion"]}, "status": status})
    host.update(result)


class SSH:
    def __init__(self, api, host, directory):
        self.host, self.directory = host, Path(directory)
        spec, ns = host["spec"], host["metadata"]["namespace"]
        for local, key in (("initial", "secretName"), ("worker", "workerSecretName")):
            path = self.directory / local
            path.write_bytes(api.secret(ns, spec["ssh"][key], "value"))
            path.chmod(0o600)
        known = host.get("status", {}).get("knownHosts")
        if known is None and spec["ssh"].get("knownHostsSecretName"):
            known = api.secret(ns, spec["ssh"]["knownHostsSecretName"], "known_hosts").decode()
        (self.directory / "known_hosts").write_text(known or "")
        self.strict = bool(known)
        here = Path(__file__).parent
        self.agent = (here / "installer.py").read_text() + "\n" + (here / "host.py").read_text()

    def public_key(self):
        return subprocess.check_output(["ssh-keygen", "-y", "-f", str(self.directory / "worker")], text=True).strip()

    def call(self, action, installed=False, **extra):
        spec = self.host["spec"]
        user = "root" if installed else spec["ssh"]["user"]
        port = spec["ssh"]["port"]
        args = ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                "-o", "ConnectTimeout=10", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2",
                "-o", "GlobalKnownHostsFile=/dev/null", "-o", "UserKnownHostsFile=" + str(self.directory / "known_hosts"),
                "-o", "HostKeyAlias=" + spec["hostname"], "-o", "StrictHostKeyChecking=" + ("yes" if self.strict else "accept-new"),
                "-i", str(self.directory / ("worker" if installed else "initial")), "-p", str(port), user + "@" + spec["address"]]
        remote = ["python3", "-c", self.agent, action]
        if action == "probe" and not installed:
            remote = ["sh", "-c", BOOTSTRAP, "nebula-bootstrap", *remote]
        remote = (["sudo", "-n"] if user != "root" else []) + remote
        result = subprocess.run(args + [shlex.join(remote)], input=canonical({"spec": spec, "uid": self.host["metadata"]["uid"], **extra}),
                                text=True, capture_output=True, timeout=900 if action in ("probe", "stage") else 45)
        if result.returncode:
            # Host output is diagnostic, never code. Avoid exposing key paths,
            # private payloads or provider banners in status and logs.
            message = "check connectivity, privileges and host prerequisites"
            try:
                diagnostic = json.loads(result.stdout)
                if isinstance(diagnostic.get("error"), str):
                    message = diagnostic["error"][:512]
            except (ValueError, AttributeError):
                pass
            raise RuntimeError("SSH " + action + " failed: " + message)
        self.strict = True
        return json.loads(result.stdout)

    def known_hosts(self):
        return (self.directory / "known_hosts").read_text()


def subset(expected, actual):
    if isinstance(expected, dict):
        return isinstance(actual, dict) and all(key in actual and subset(value, actual[key]) for key, value in expected.items())
    return expected == actual


def apply_bound(api, obj, host, cluster_scoped=False):
    obj = copy.deepcopy(obj)
    version, plural = KINDS[obj["kind"]]
    if obj["apiVersion"] != version:
        raise ValueError("unexpected enrollment API version")
    meta = obj["metadata"]
    namespace = host["metadata"]["namespace"]
    if not cluster_scoped and meta.get("namespace") != namespace:
        raise ValueError("cross-namespace enrollment is forbidden")
    path = "/apis/" + version + ("" if cluster_scoped else "/namespaces/" + namespace) + "/" + plural + "/" + meta["name"]
    existing = api.request("GET", path)
    if existing and existing["metadata"].get("annotations", {}).get(BINDING) != host["metadata"]["uid"]:
        raise ValueError("refusing to adopt an enrollment resource owned by another request")
    if existing and obj["kind"] == "PooledRemoteMachine" and existing.get("status", {}).get("reserved"):
        if not subset(obj["spec"], existing["spec"]):
            raise ValueError("reserved pool connection settings cannot be changed")
        return existing
    meta.setdefault("annotations", {})[BINDING] = host["metadata"]["uid"]
    # Retained resources intentionally have no GC ownerReference. Removal of a
    # Git request cannot drain a worker, reset k0s or erase its local storage.
    return api.request("PATCH", path + "?fieldManager=nebula-ssh-baremetal", obj, "application/apply-patch+yaml")


def workload_client(api, host, directory):
    import yaml
    config = yaml.safe_load(api.secret(host["metadata"]["namespace"], host["spec"]["workloadKubeconfigSecretName"], "value"))
    context = next(c["context"] for c in config["contexts"] if c["name"] == config["current-context"])
    cluster = next(c["cluster"] for c in config["clusters"] if c["name"] == context["cluster"])
    user = next(u["user"] for u in config["users"] if u["name"] == context["user"])
    if cluster.get("insecure-skip-tls-verify") or "exec" in user or "auth-provider" in user:
        raise ValueError("workload kubeconfig must use a trusted CA and embedded client credentials")
    paths = {}
    for key, source in (("certificate-authority", cluster), ("client-certificate", user), ("client-key", user)):
        path = Path(directory) / key
        path.write_bytes(base64.b64decode(source[key + "-data"], validate=True))
        path.chmod(0o600)
        paths[key] = str(path)
    tls = ssl.create_default_context(cafile=paths["certificate-authority"])
    tls.load_cert_chain(paths["client-certificate"], paths["client-key"])
    return Kubernetes(cluster["server"], tls)


def network_admission(host):
    name, cidr = host["spec"]["hostname"], host["spec"]["ipv6PodCidr"]
    match = {"matchPolicy": "Equivalent", "resourceRules": [{"apiGroups": [""], "apiVersions": ["v1"], "operations": ["CREATE"], "resources": ["nodes"], "scope": "Cluster"}]}
    common = {"matchConstraints": match, "matchConditions": [{"name": "exact-host", "expression": "object.metadata.name == " + json.dumps(name)}], "failurePolicy": "Fail"}
    for kind, suffix in (("MutatingAdmissionPolicy", "cidr"), ("ValidatingAdmissionPolicy", "identity")):
        policy_name = "nebula-" + name + "-" + suffix
        spec = copy.deepcopy(common)
        if suffix == "cidr":
            spec.update({"reinvocationPolicy": "Never", "mutations": [{"patchType": "ApplyConfiguration", "applyConfiguration": {
                "expression": 'Object{metadata: Object.metadata{annotations: {"network.cilium.io/ipv6-pod-cidr": ' + json.dumps(cidr) + '}}}'}}]})
        else:
            spec["validations"] = [{"expression": 'request.userInfo.username == "system:node:" + object.metadata.name', "message": "This Node must register through its kubelet"}]
        yield {"apiVersion": "admissionregistration.k8s.io/v1", "kind": kind, "metadata": {"name": policy_name}, "spec": spec}
        yield {"apiVersion": "admissionregistration.k8s.io/v1", "kind": kind + "Binding", "metadata": {"name": policy_name},
               "spec": {"policyName": policy_name, **({"validationActions": ["Deny"]} if suffix == "identity" else {})}}


def reconcile(api, host, ssh_factory=SSH, clock=time.time):
    spec, meta = host["spec"], host["metadata"]
    validate_spec(spec)
    if meta.get("deletionTimestamp"):
        return
    if RETAIN not in meta.get("finalizers", []):
        result = api.request("PATCH", API.format(meta["namespace"]) + "/" + meta["name"],
                             {"metadata": {"resourceVersion": meta["resourceVersion"], "finalizers": meta.get("finalizers", []) + [RETAIN]}})
        host.update(result)
        return
    status = host.get("status", {})
    current_fingerprint = fingerprint(spec)
    if status.get("fingerprint", current_fingerprint) != current_fingerprint:
        raise ValueError("installation identity/profile changed; restore it or explicitly decommission this host")
    phase = status.get("phase", "Pending")
    if phase not in ("Pending", "Discovered", "Staged", "Installing", "OSReady", "Enrolling", "Ready"):
        raise ValueError("unknown provisioning state; refusing to install")
    with tempfile.TemporaryDirectory(prefix="baremetal-") as directory:
        if phase in ("Pending", "Discovered", "Staged", "Installing"):
            ssh = ssh_factory(api, host, directory)
            if phase == "Pending":
                facts = ssh.call("probe")
                if facts.get("installed"):
                    raise ValueError("existing installation receipt without management binding; restore management state")
                save(api, host, phase="Discovered", fingerprint=current_fingerprint, facts=facts, knownHosts=ssh.known_hosts())
                return
            if phase == "Discovered":
                ssh.call("stage", facts=status["facts"], workerPublicKey=ssh.public_key())
                save(api, host, phase="Staged")
                return
            if phase == "Staged":
                # Persist intent BEFORE scheduling the destructive transition.
                save(api, host, phase="Installing", startedAt=clock())
                ssh.call("commit")
                return
            if phase == "Installing":
                try:
                    result = ssh.call("verify", installed=True)
                except RuntimeError:
                    if clock() - status["startedAt"] > spec["installation"].get("timeoutSeconds", 3600):
                        raise ValueError("installation deadline exceeded; recovery needs inspection, never automatic reimaging")
                    # A crash between saving Installing and scheduling kexec is
                    # recoverable only while the authenticated ORIGINAL boot is
                    # still present. An unknown boot is never reinstalled.
                    try:
                        facts = ssh.call("probe")
                    except RuntimeError:
                        return
                    if facts.get("bootId") == status["facts"]["bootId"]:
                        ssh.call("commit")
                    return
                if result.get("verified") is not True:
                    raise ValueError("installed OS verification did not succeed")
                save(api, host, phase="OSReady", addresses=result["addresses"])
                return
        if spec.get("ipv6PodCidr"):
            workload = workload_client(api, host, directory)
            for obj in network_admission(host):
                apply_bound(workload, obj, host, cluster_scoped=True)
        # Only reached after SSH verified the new OS and storage. Publishing the
        # MD last also prevents the MachineHealthCheck clock starting at install.
        for obj in spec["enrollment"]:
            apply_bound(api, obj, host)
        md = next(obj for obj in spec["enrollment"] if obj["kind"] == "MachineDeployment")
        path = f"/apis/cluster.x-k8s.io/v1beta2/namespaces/{meta['namespace']}/machinedeployments/{md['metadata']['name']}"
        observed = api.request("GET", path) or {}
        md_status = observed.get("status", {})
        generation = observed.get("metadata", {}).get("generation")
        ready = (generation is not None and md_status.get("observedGeneration") == generation
                 and (md_status.get("readyReplicas") or 0) >= 1
                 and any(c.get("type") == "MachinesReady" and c.get("status") == "True"
                         and c.get("observedGeneration") == generation for c in md_status.get("conditions", [])))
        save(api, host, phase="Ready" if ready else "Enrolling", lastError="")
        save(api, host, conditions=conditions(host, "WorkerReady" if ready else "WaitingForCAPI", "OS verified; pooled k0s enrollment is managed by CAPI"))


def main():
    os.umask(0o077)
    namespace = os.environ["NAMESPACE"]
    account = Path("/var/run/secrets/kubernetes.io/serviceaccount")
    service_host = os.environ["KUBERNETES_SERVICE_HOST"]
    if ":" in service_host and not service_host.startswith("["):
        service_host = "[" + service_host + "]"
    server = "https://" + service_host + ":" + os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443")
    api = Kubernetes(server, ssl.create_default_context(cafile=str(account / "ca.crt")), lambda: (account / "token").read_text().strip())
    while True:
        try:
            hosts = api.request("GET", API.format(namespace))["items"]
            addresses = [h["spec"]["address"] for h in hosts]
            for host in hosts:
                try:
                    if addresses.count(host["spec"]["address"]) != 1:
                        raise ValueError("duplicate host address; refusing concurrent installations")
                    reconcile(api, host)
                except (ValueError, RuntimeError, KeyError, OSError, subprocess.SubprocessError) as error:
                    message = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
                    print(canonical({"host": host["metadata"]["name"], "error": message}), flush=True)
                    try:
                        save(api, host, lastError=message, conditions=conditions(host, "ProvisioningBlocked", message))
                    except (ValueError, RuntimeError, OSError):
                        pass
        except (ValueError, RuntimeError, OSError) as error:
            print("Kubernetes observation failed: " + type(error).__name__, flush=True)
        time.sleep(15)


if __name__ == "__main__":
    main()
