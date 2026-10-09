"""Authenticated SSH and Kubernetes transports; no lifecycle decisions."""

from __future__ import annotations

import json
import shlex
import ssl
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Callable
from contextlib import ExitStack
from pathlib import Path
from typing import Any, Protocol

from agent import build_agent
from models import JsonObject
from runtime import ProvisioningError, RetryableError, canonical, json_object


class KubernetesClient(Protocol):
    def request(
        self,
        method: str,
        path: str,
        value: JsonObject | None = None,
        content_type: str = "application/merge-patch+json",
    ) -> JsonObject | None: ...


class SshClient(Protocol):
    def call(self, action: str, installed: bool = False, **extra: Any) -> JsonObject: ...
    def public_key(self) -> str: ...
    def known_hosts(self) -> str: ...


BOOTSTRAP = """set -eu
if [ ! -d /run/systemd/system ] || [ "$(uname -m)" != x86_64 ]; then
  printf '%s\\n' '{"error":"source host must be x86_64 Linux running systemd"}'
  exit 1
fi
missing=false
for utility in python3 ip lsblk findmnt pvs wipefs mdadm udevadm; do
  command -v "$utility" >/dev/null 2>&1 || missing=true
done
if [ "$missing" = true ]; then
  if [ -d /var/lib/k0s ] || [ -f /etc/kubernetes/kubelet.conf ]; then
    printf '%s\\n' '{"error":"existing Kubernetes installation: refusing fresh OS installation"}'
    exit 1
  fi
  if command -v apt-get >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get update >&2
    DEBIAN_FRONTEND=noninteractive apt-get install -y python3 iproute2 util-linux lvm2 mdadm udev ca-certificates >&2
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y python3 iproute util-linux lvm2 mdadm systemd-udev ca-certificates >&2
  else
    printf '%s\\n' '{"error":"source needs Python 3, iproute, util-linux and LVM tools, or apt/dnf to install them"}'
    exit 1
  fi
fi
exec "$@"
"""


class Kubernetes:
    def __init__(
        self, server: str, context: ssl.SSLContext, token: Callable[[], str] | None = None
    ) -> None:
        self.server = server.rstrip("/")
        self.context = context
        self.token = token
        parsed = urllib.parse.urlparse(server)
        if parsed.scheme != "https" or parsed.username or parsed.password:
            raise ProvisioningError("Kubernetes endpoint must use verified HTTPS")

    def request(
        self,
        method: str,
        path: str,
        value: JsonObject | None = None,
        content_type: str = "application/merge-patch+json",
    ) -> JsonObject | None:
        headers = {"Accept": "application/json"}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token()
        if value is not None:
            headers["Content-Type"] = content_type
        request = urllib.request.Request(
            self.server + path,
            headers=headers,
            method=method,
            data=None if value is None else canonical(value).encode(),
        )
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=30) as response:
                return json_object(json.load(response), "Kubernetes response")
        except urllib.error.HTTPError as error:
            if method == "GET" and error.code == 404:
                return None
            # Keep raw API failure bodies out of progress records and logs.
            raise RetryableError(f"Kubernetes {method} failed with HTTP {error.code}") from None
        except (urllib.error.URLError, OSError) as error:
            raise RetryableError(
                f"Kubernetes {method} transport failed: {type(error).__name__}"
            ) from None


class SSH:
    def __init__(
        self, host: JsonObject, directory: str | Path, credentials: str | Path = "/etc/credentials"
    ) -> None:
        self.host = host
        self.directory = Path(directory)
        self.initial_credential = Path(credentials) / "initial" / "value"
        spec = host["spec"]
        for local in ("initial", "worker"):
            if local == "initial" and spec["ssh"].get("authentication") == "password":
                continue
            path = self.directory / local
            path.write_bytes((Path(credentials) / local / "value").read_bytes())
            path.chmod(0o600)
        known = host.get("status", {}).get("knownHosts")
        if host.get("status", {}).get("phase", "Pending") != "Pending" and not known:
            raise ProvisioningError("recorded SSH host keys are missing; restore management state")
        if known is None and spec["ssh"].get("knownHostsSecretName"):
            known = (Path(credentials) / "known-hosts" / "value").read_text()
        if not (known or "").strip() and not spec["ssh"].get("trustOnFirstUse"):
            raise ProvisioningError("pinned known_hosts Secret is empty")
        (self.directory / "known_hosts").write_text(known or "")
        self.strict = bool(known)
        self.agent = build_agent()

    def public_key(self) -> str:
        return subprocess.check_output(
            ["ssh-keygen", "-y", "-f", str(self.directory / "worker")], text=True
        ).strip()

    def call(self, action: str, installed: bool = False, **extra: Any) -> JsonObject:
        spec = self.host["spec"]
        user = "root" if installed else spec["ssh"]["user"]
        port = spec["ssh"]["port"]
        password_auth = not installed and spec["ssh"].get("authentication") == "password"
        args = [
            "ssh",
            "-F",
            "/dev/null",
            "-o",
            "BatchMode=" + ("no" if password_auth else "yes"),
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "ConnectTimeout=10",
            "-o",
            "ServerAliveInterval=15",
            "-o",
            "ServerAliveCountMax=2",
            "-o",
            "GlobalKnownHostsFile=/dev/null",
            "-o",
            "UserKnownHostsFile=" + str(self.directory / "known_hosts"),
            "-o",
            "HostKeyAlias=" + spec["hostname"],
            "-o",
            "StrictHostKeyChecking=" + ("yes" if self.strict else "accept-new"),
        ]
        if password_auth:
            args.extend(
                [
                    "-o",
                    "PreferredAuthentications=keyboard-interactive,password",
                    "-o",
                    "PubkeyAuthentication=no",
                    "-o",
                    "NumberOfPasswordPrompts=1",
                ]
            )
        else:
            args.extend(["-i", str(self.directory / ("worker" if installed else "initial"))])
        args.extend(["-p", str(port), user + "@" + spec["address"]])
        remote = ["python3", "-I", "-B", "-c", self.agent, action]
        if action == "probe" and not installed:
            remote = ["sh", "-c", BOOTSTRAP, "nebula-bootstrap", *remote]
        remote = (["sudo", "-n"] if user != "root" else []) + remote
        try:
            with ExitStack() as stack:
                descriptors: tuple[int, ...] = ()
                if password_auth:
                    # Read the mounted Secret through an inherited descriptor. Neither
                    # argv, environment, request JSON nor scratch files contain it.
                    credential = stack.enter_context(self.initial_credential.open("rb"))
                    descriptors = (credential.fileno(),)
                    args = ["sshpass", "-d", str(credential.fileno()), *args]
                result = subprocess.run(
                    args + [shlex.join(remote)],
                    input=canonical({"spec": spec, "uid": self.host["metadata"]["uid"], **extra}),
                    text=True,
                    capture_output=True,
                    pass_fds=descriptors,
                    timeout=900 if action in ("probe", "stage") else 45,
                )
        except (subprocess.TimeoutExpired, OSError) as error:
            raise RetryableError(f"SSH {action} transport failed: {type(error).__name__}") from None
        if result.returncode:
            # Host output is diagnostic, never code. Avoid exposing key paths,
            # private payloads or provider banners in status and logs.
            message = "check connectivity, privileges and host prerequisites"
            terminal = False
            try:
                diagnostic = json.loads(result.stdout)
                if isinstance(diagnostic.get("error"), str):
                    message = diagnostic["error"][:512]
                terminal = diagnostic.get("terminal") is True
            except (ValueError, AttributeError):
                pass
            if terminal:
                raise ProvisioningError("SSH " + action + " failed: " + message)
            raise RetryableError("SSH " + action + " failed: " + message)
        self.strict = True
        try:
            return json_object(json.loads(result.stdout), "Host response")
        except ValueError:
            raise ProvisioningError(f"SSH {action} returned an invalid response") from None

    def known_hosts(self) -> str:
        return (self.directory / "known_hosts").read_text()
