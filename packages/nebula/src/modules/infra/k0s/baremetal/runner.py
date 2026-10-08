"""A finite installation Job. Crossplane owns enrollment and all resource orchestration.

This process can read/patch only its precreated progress ConfigMap. Private keys
are mounted Secrets; it cannot list hosts, read Secrets or create CAPI resources.
"""
import hashlib
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
            # Keep raw API failure bodies out of progress records and logs.
            raise RuntimeError(f"Kubernetes {method} failed with HTTP {error.code}") from None


class SSH:
    def __init__(self, host, directory, credentials="/etc/credentials"):
        self.host, self.directory = host, Path(directory)
        spec = host["spec"]
        for local in ("initial", "worker"):
            path = self.directory / local
            path.write_bytes((Path(credentials) / local / "value").read_bytes())
            path.chmod(0o600)
        known = host.get("status", {}).get("knownHosts")
        if host.get("status", {}).get("phase", "Pending") != "Pending" and not known:
            raise ValueError("recorded SSH host keys are missing; restore management state")
        if known is None and spec["ssh"].get("knownHostsSecretName"):
            known = (Path(credentials) / "known-hosts" / "value").read_text()
        if not (known or "").strip() and not spec["ssh"].get("trustOnFirstUse"):
            raise ValueError("pinned known_hosts Secret is empty")
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


class Journal:
    def __init__(self, api, namespace, name, request, request_hash):
        self.api = api
        self.path = f"/api/v1/namespaces/{namespace}/configmaps/{name}"
        self.request, self.request_hash = request, request_hash
        self.refresh()

    def refresh(self):
        self.resource = self.api.request("GET", self.path)
        if not self.resource:
            raise RuntimeError("progress ConfigMap is not available")
        data = self.resource.get("data", {})
        if data.get("uid") != self.request["uid"] or data.get("requestHash") != self.request_hash:
            raise ValueError("progress belongs to another request or profile")
        self.status = json.loads(data.get("progress", "{}"))

    def save(self, **changes):
        status = {**self.status, **changes}
        data = {"progress": canonical(status), "phase": status.get("phase", "Pending")}
        if status.get("phase") == "OSReady":
            data["verifiedRequestHash"] = self.request_hash
        # Optimistic locking: never schedule kexec if recording intent lost a race.
        self.resource = self.api.request("PATCH", self.path, {
            "metadata": {"resourceVersion": self.resource["metadata"]["resourceVersion"]}, "data": data})
        self.status = status


def advance(journal, ssh_factory=SSH, clock=time.time):
    spec = journal.request["spec"]
    validate_spec(spec)
    status = journal.status
    current_fingerprint = fingerprint(spec)
    if status.get("fingerprint", current_fingerprint) != current_fingerprint:
        raise ValueError("installation identity/profile changed; restore the original request")
    if status.get("terminalError"):
        raise ValueError("installation is blocked; inspect the retained progress record")
    phase = status.get("phase", "Pending")
    if phase == "OSReady":
        return True
    if phase not in ("Pending", "Discovered", "Staged", "Installing"):
        raise ValueError("unknown provisioning state; refusing to install")
    host = {"spec": spec, "metadata": {"uid": journal.request["uid"]}, "status": status}
    with tempfile.TemporaryDirectory(prefix="baremetal-") as directory:
        ssh = ssh_factory(host, directory)
        if phase == "Pending":
            facts = ssh.call("probe")
            if facts.get("installed"):
                raise ValueError("existing installation receipt without management binding; restore management state")
            journal.save(phase="Discovered", fingerprint=current_fingerprint, facts=facts, knownHosts=ssh.known_hosts())
        elif phase == "Discovered":
            ssh.call("stage", facts=status["facts"], workerPublicKey=ssh.public_key())
            journal.save(phase="Staged")
        elif phase == "Staged":
            # Persist destructive intent BEFORE scheduling kexec.
            journal.save(phase="Installing", startedAt=clock())
            ssh.call("commit")
        elif phase == "Installing":
            try:
                result = ssh.call("verify", installed=True)
            except RuntimeError:
                if clock() - status["startedAt"] > spec["installation"]["timeoutSeconds"]:
                    raise ValueError("installation deadline exceeded; recovery needs inspection, never automatic reimaging")
                # Recover a crash after saving intent only on the authenticated
                # original source boot. An unknown boot is never reinstalled.
                try:
                    facts = ssh.call("probe")
                except RuntimeError:
                    return False
                if facts.get("bootId") == status["facts"]["bootId"]:
                    ssh.call("commit")
                return False
            if result.get("verified") is not True:
                raise ValueError("installed OS verification did not succeed")
            journal.save(phase="OSReady", addresses=result["addresses"], lastError="")
            return True
    return False


def main():
    os.umask(0o077)
    raw = Path("/etc/provisioner/request.json").read_bytes()
    request = json.loads(raw)
    request_hash = hashlib.sha256(raw).hexdigest()
    account = Path("/var/run/secrets/kubernetes.io/serviceaccount")
    service_host = os.environ["KUBERNETES_SERVICE_HOST"]
    if ":" in service_host:
        service_host = "[" + service_host + "]"
    server = "https://" + service_host + ":" + os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443")
    api = Kubernetes(server, ssl.create_default_context(cafile=str(account / "ca.crt")), lambda: (account / "token").read_text().strip())
    # The Job's activeDeadlineSeconds bounds the entire run, including discovery
    # and staging; the persisted timestamp bounds the irreversible install step.
    while True:
        journal = None
        try:
            journal = Journal(api, os.environ["NAMESPACE"], os.environ["STATE_CONFIG_MAP"], request, request_hash)
            if advance(journal):
                return
        except (ValueError, RuntimeError, KeyError, OSError, subprocess.SubprocessError) as error:
            message = str(error) if isinstance(error, (ValueError, RuntimeError)) else type(error).__name__
            print(canonical({"error": message}), flush=True)
            if journal:
                try:
                    journal.save(lastError=message, terminalError=isinstance(error, (ValueError, KeyError)))
                except (ValueError, RuntimeError, OSError):
                    pass
            if isinstance(error, (ValueError, KeyError)):
                raise SystemExit(1) from None
        time.sleep(15)


if __name__ == "__main__":
    main()
