"""Finite, journaled provisioning lifecycle. Crossplane owns enrollment.

Each handler advances at most one phase. Destructive actions are scheduled only
following a successful journal checkpoint; a restarted Job resumes that checkpoint.
"""

from __future__ import annotations

import hashlib
import json
import os
import ssl
import subprocess
import tempfile
import time
from collections.abc import Callable
from enum import Enum
from pathlib import Path

from models import JsonObject, WorkerSpec
from runtime import ProvisioningError, RetryableError, canonical, fingerprint, json_object
from transport import SSH, Kubernetes, KubernetesClient, SshClient
from validation import validate_spec


class Phase(str, Enum):
    PENDING = "Pending"
    DISCOVERED = "Discovered"
    STAGED = "Staged"
    INSTALLING = "Installing"
    CONFIGURING_UEFI = "ConfiguringUefi"
    REBOOTING_UEFI = "RebootingUefi"
    VERIFYING_UEFI = "VerifyingUefi"
    OS_READY = "OSReady"


FIRMWARE_PHASES = {Phase.CONFIGURING_UEFI, Phase.REBOOTING_UEFI, Phase.VERIFYING_UEFI}
POLL_INTERVAL_SECONDS = 15
SshFactory = Callable[[JsonObject, str], SshClient]


class Journal:
    """Compare-and-swap progress storage bound to one immutable request."""

    def __init__(
        self,
        api: KubernetesClient,
        namespace: str,
        name: str,
        request: JsonObject,
        request_hash: str,
    ) -> None:
        self.api = api
        self.path = f"/api/v1/namespaces/{namespace}/configmaps/{name}"
        self.request = request
        self.request_hash = request_hash
        self.refresh()

    def refresh(self) -> None:
        resource = self.api.request("GET", self.path)
        if not resource:
            raise RetryableError("progress ConfigMap is not available")
        data = resource.get("data", {})
        if data.get("uid") != self.request["uid"] or data.get("requestHash") != self.request_hash:
            raise ProvisioningError("progress belongs to another request or profile")
        self.resource = resource
        self.status = json_object(json.loads(data.get("progress", "{}")), "Progress")

    def save(self, **changes: object) -> None:
        status = {**self.status, **changes}
        data = {"progress": canonical(status), "phase": status.get("phase", Phase.PENDING)}
        if status.get("phase") == Phase.OS_READY:
            data["verifiedRequestHash"] = self.request_hash
        resource = self.api.request(
            "PATCH",
            self.path,
            {
                "metadata": {"resourceVersion": self.resource["metadata"]["resourceVersion"]},
                "data": data,
            },
        )
        if resource is None:
            raise RetryableError("progress checkpoint was not acknowledged")
        self.resource = resource
        self.status = status


class Provisioner:
    """Execute one resumable transition using a snapshot of the persisted state."""

    def __init__(
        self, journal: Journal, clock: Callable[[], float] = time.time, skip_uefi: bool = False
    ) -> None:
        self.journal = journal
        self.clock = clock
        self.spec: WorkerSpec = journal.request["spec"]
        self.status = journal.status
        self.uefi = self.spec["installation"].get("uefi")
        self.skip_uefi = skip_uefi
        try:
            self.phase = Phase(self.status.get("phase", Phase.PENDING))
        except ValueError:
            raise ProvisioningError("unknown provisioning state; refusing to install") from None

    def validate_checkpoint(self) -> None:
        validate_spec(self.spec)
        expected = fingerprint(self.spec)
        if self.status.get("fingerprint", expected) != expected:
            raise ProvisioningError(
                "installation identity/profile changed; restore the original request"
            )
        if self.status.get("terminalError"):
            raise ProvisioningError("installation is blocked; inspect the retained progress record")
        if (
            self.phase == Phase.OS_READY
            and self.uefi
            and not (
                self.status.get("uefiVerified") is True
                or (self.skip_uefi and self.status.get("uefiSkipped") is True)
            )
        ):
            raise ProvisioningError("UEFI verification is missing; refusing enrollment")
        if self.phase in FIRMWARE_PHASES:
            if not self.uefi:
                raise ProvisioningError("UEFI phase has no firmware profile")
            if not self.skip_uefi and self.clock() - self.status["uefiStartedAt"] > self.uefi.get(
                "rebootTimeoutSeconds", 900
            ):
                raise ProvisioningError(
                    "UEFI deadline exceeded; inspect firmware or power-cycle requirements"
                )

    def step(self, ssh: SshClient) -> bool:
        if self.skip_uefi and self.phase in FIRMWARE_PHASES:
            return self.skip_firmware(ssh)
        handlers = {
            Phase.PENDING: self.discover,
            Phase.DISCOVERED: self.stage,
            Phase.STAGED: self.start_installation,
            Phase.INSTALLING: self.await_installation,
            Phase.CONFIGURING_UEFI: self.configure_firmware,
            Phase.REBOOTING_UEFI: self.await_firmware,
            Phase.VERIFYING_UEFI: self.await_firmware,
        }
        return handlers[self.phase](ssh)

    def discover(self, ssh: SshClient) -> bool:
        facts = ssh.call("probe", skipUefi=self.skip_uefi)
        if facts.get("installed"):
            raise ProvisioningError(
                "existing installation receipt without management binding; restore management state"
            )
        self.journal.save(
            phase=Phase.DISCOVERED,
            fingerprint=fingerprint(self.spec),
            facts=facts,
            knownHosts=ssh.known_hosts(),
        )
        return False

    def stage(self, ssh: SshClient) -> bool:
        ssh.call("stage", facts=self.status["facts"], workerPublicKey=ssh.public_key())
        self.journal.save(phase=Phase.STAGED)
        return False

    def start_installation(self, ssh: SshClient) -> bool:
        # Never schedule kexec unless the management checkpoint succeeded.
        self.journal.save(phase=Phase.INSTALLING, startedAt=self.clock())
        ssh.call("commit")
        return False

    def resume_original_boot(self, ssh: SshClient) -> None:
        if self.clock() - self.status["startedAt"] > self.spec["installation"].get(
            "timeoutSeconds", 3600
        ):
            raise ProvisioningError(
                "installation deadline exceeded; recovery needs inspection, never automatic reimaging"
            )
        try:
            facts = ssh.call("probe", skipUefi=self.skip_uefi)
        except RetryableError:
            return
        # A crash between checkpoint and kexec may resume only the known source boot.
        if facts.get("bootId") == self.status["facts"]["bootId"]:
            ssh.call("commit")

    def await_installation(self, ssh: SshClient) -> bool:
        try:
            result = ssh.call("verify", installed=True)
        except RetryableError:
            self.resume_original_boot(ssh)
            return False
        if result.get("verified") is not True:
            raise ProvisioningError("installed OS verification did not succeed")
        if self.uefi and not self.skip_uefi:
            self.journal.save(
                phase=Phase.CONFIGURING_UEFI,
                uefiStartedAt=self.clock(),
                installedBootId=result["bootId"],
                addresses=result["addresses"],
                lastError="",
            )
            return False
        self.mark_os_ready(result)
        return True

    def mark_os_ready(self, result: JsonObject) -> None:
        skipped = bool(self.uefi and self.skip_uefi)
        self.journal.save(
            phase=Phase.OS_READY,
            addresses=result["addresses"],
            verifiedBootId=result["bootId"],
            uefiSkipped=skipped,
            uefiVerified=False,
            lastError="",
        )

    def skip_firmware(self, ssh: SshClient) -> bool:
        # Recheck the retained OS receipt, disk layout and networking. Never
        # call firmware or installer actions, and retain every earlier failure.
        result = ssh.call("verify", installed=True)
        if result.get("verified") is not True:
            raise ProvisioningError("installed OS verification did not succeed")
        self.mark_os_ready(result)
        return True

    def configure_firmware(self, ssh: SshClient) -> bool:
        result = ssh.call(
            "uefi-apply", installed=True, expectedBootId=self.status["installedBootId"]
        )
        if result.get("configured") is not True:
            raise ProvisioningError("UEFI configuration did not succeed")
        phase = Phase.REBOOTING_UEFI if result["changed"] else Phase.VERIFYING_UEFI
        # Persist the next phase before a reboot can interrupt the SSH session.
        self.journal.save(phase=phase, lastError="")
        if result["changed"]:
            ssh.call("uefi-reboot", installed=True)
        return False

    def await_firmware(self, ssh: SshClient) -> bool:
        try:
            firmware = ssh.call("uefi-verify", installed=True)
            if firmware.get("verified") is not True:
                if self.phase == Phase.REBOOTING_UEFI:
                    ssh.call("uefi-reboot", installed=True)
                return False
            result = ssh.call("verify", installed=True)
        except RetryableError:
            return False  # The persisted deadline bounds reboot connectivity loss.
        if result.get("verified") is not True or result["bootId"] != firmware["bootId"]:
            raise ProvisioningError("OS and UEFI verification are not from the same installed boot")
        self.journal.save(
            phase=Phase.OS_READY, uefiVerified=True, addresses=result["addresses"], lastError=""
        )
        return True


def advance(
    journal: Journal,
    ssh_factory: SshFactory = SSH,
    clock: Callable[[], float] = time.time,
    *,
    skip_uefi: bool = False,
) -> bool:
    provisioner = Provisioner(journal, clock, skip_uefi)
    provisioner.validate_checkpoint()
    if provisioner.phase == Phase.OS_READY:
        return True
    host = {
        "spec": provisioner.spec,
        "metadata": {"uid": journal.request["uid"]},
        "status": journal.status,
    }
    with tempfile.TemporaryDirectory(prefix="baremetal-") as directory:
        return provisioner.step(ssh_factory(host, directory))


def begin_firmware_retry(
    journal: Journal, generation: int, clock: Callable[[], float] = time.time
) -> None:
    """Consume an operator attempt once, without permitting installation phases."""
    provisioner = Provisioner(journal, clock)
    validate_spec(provisioner.spec)
    status = journal.status
    if status.get("fingerprint") != fingerprint(provisioner.spec):
        raise ProvisioningError("firmware retry is not bound to the installed profile")
    previous = status.get("firmwareRetryGeneration", 0)
    if generation < 1 or generation > 16 or generation < previous:
        raise ProvisioningError("invalid firmware retry generation")
    if not provisioner.uefi or provisioner.phase not in FIRMWARE_PHASES | {Phase.OS_READY}:
        raise ProvisioningError("firmware retry refuses OS installation phases")
    if generation == previous:
        return  # A restart cannot unblock a failed attempt a second time.
    if generation != previous + 1 or not status.get("terminalError"):
        raise ProvisioningError(
            "firmware retry requires the next generation and a terminal failure"
        )
    if provisioner.phase not in FIRMWARE_PHASES or status.get("uefiVerified"):
        raise ProvisioningError("firmware retry requires incomplete firmware verification")
    if not status.get("installedBootId"):
        raise ProvisioningError("firmware retry requires the retained installed boot identity")
    failures = [
        *status.get("firmwareFailures", []),
        {
            "generation": previous,
            "phase": provisioner.phase,
            "error": status.get("lastError", ""),
            "at": clock(),
        },
    ]
    journal.save(
        firmwareRetryGeneration=generation,
        firmwareFailures=failures,
        uefiStartedAt=clock(),
        terminalError=False,
        lastError="",
    )


def record_error(journal: Journal | None, error: Exception) -> bool:
    """Record a sanitized diagnostic and return whether the operation must stop."""
    if journal is not None and journal.status.get("terminalError"):
        # Restarting a blocked Job must preserve the failure that requires
        # inspection, rather than replacing it with the blocked-state message.
        print(
            canonical({"error": journal.status.get("lastError", "installation is blocked")}),
            flush=True,
        )
        return True
    terminal = isinstance(error, (ValueError, KeyError, TypeError))
    message = (
        str(error)
        if isinstance(error, (ProvisioningError, RetryableError))
        else type(error).__name__
    )
    print(canonical({"error": message}), flush=True)
    if journal is not None:
        try:
            journal.save(lastError=message, terminalError=terminal)
        except (ValueError, RuntimeError, OSError):
            pass  # No further host work is done before a fresh checkpoint read.
    return terminal


def main() -> None:
    os.umask(0o077)
    policy = os.environ.get("SKIP_UEFI", "false")
    if policy not in ("false", "true"):
        raise ProvisioningError("invalid UEFI skip policy")
    raw = Path("/etc/provisioner/request.json").read_bytes()
    request = json_object(json.loads(raw), "Request")
    request_hash = hashlib.sha256(raw).hexdigest()
    account = Path("/var/run/secrets/kubernetes.io/serviceaccount")
    service_host = os.environ["KUBERNETES_SERVICE_HOST"]
    if ":" in service_host:
        service_host = "[" + service_host + "]"
    server = (
        "https://" + service_host + ":" + os.environ.get("KUBERNETES_SERVICE_PORT_HTTPS", "443")
    )
    api = Kubernetes(
        server,
        ssl.create_default_context(cafile=str(account / "ca.crt")),
        lambda: (account / "token").read_text().strip(),
    )
    # The Kubernetes Job deadline bounds discovery and staging as well.
    while True:
        journal = None
        try:
            journal = Journal(
                api, os.environ["NAMESPACE"], os.environ["STATE_CONFIG_MAP"], request, request_hash
            )
            if os.environ.get("FIRMWARE_RETRY_GENERATION"):
                begin_firmware_retry(journal, int(os.environ["FIRMWARE_RETRY_GENERATION"]))
            if advance(journal, skip_uefi=policy == "true"):
                return
        except (
            ValueError,
            RuntimeError,
            KeyError,
            TypeError,
            OSError,
            subprocess.SubprocessError,
        ) as error:
            if record_error(journal, error):
                raise SystemExit(1) from None
        time.sleep(POLL_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
