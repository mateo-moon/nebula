"""Hardware-bound efivarfs updates with durable backups and reboot checkpoints.

Only existing NV/BS/RT variables are modified. Full originals stay in a private,
durable transaction on the installed OS; they never enter Kubernetes or logs.
"""

from __future__ import annotations

import array
import errno
import fcntl
import json
import os
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import cast

from models import (
    FirmwareProfile,
    FirmwareTransaction,
    JsonObject,
    UefiVariable,
    VariableBackup,
    WorkerSpec,
)
from runtime import ProvisioningError, canonical, command, fingerprint

UEFI_ROOT = Path("/sys/firmware/efi/efivars")
UEFI_DMI = Path("/sys/class/dmi/id")
UEFI_STATE = Path("/var/lib/nebula-baremetal")
UEFI_BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
# Linux x86-64 ioctl numbers; the installer already restricts host architecture.
UEFI_GETFLAGS, UEFI_SETFLAGS, UEFI_IMMUTABLE = 0x80086601, 0x40086602, 0x10


def verify_environment(profile: FirmwareProfile) -> None:
    if not UEFI_ROOT.is_dir():
        raise ProvisioningError("UEFI runtime variables are unavailable on this boot")
    filesystem = subprocess.run(
        ["findmnt", "-n", "-o", "FSTYPE", "--mountpoint", str(UEFI_ROOT)],
        capture_output=True,
        text=True,
    )
    if filesystem.returncode:
        command(["mount", "-t", "efivarfs", "efivarfs", str(UEFI_ROOT)])
    elif filesystem.stdout.strip() != "efivarfs":
        raise ProvisioningError("UEFI variable path is not an efivarfs mount")
    fields = {
        "boardVendor": "board_vendor",
        "boardName": "board_name",
        "biosVersion": "bios_version",
        "biosVendor": "bios_vendor",
    }
    for key, expected in profile["match"].items():
        if (UEFI_DMI / fields[key]).read_text().strip() != expected:
            raise ProvisioningError("UEFI profile does not match " + key)


def variable_name(variable: UefiVariable) -> str:
    return variable["name"] + "-" + variable["guid"].lower()


def read_variable(variable: UefiVariable) -> bytes:
    path = UEFI_ROOT / variable_name(variable)
    if path.is_symlink():
        raise ProvisioningError("UEFI variable must not be a symlink")
    with path.open("rb") as source:
        blob = source.read(variable["payloadSize"] + 5)
    if (
        len(blob) != variable["payloadSize"] + 4
        or int.from_bytes(blob[:4], "little") != variable["attributes"]
    ):
        raise ProvisioningError("UEFI variable size or attributes do not match the profile")
    return blob


def desired_blob(variable: UefiVariable, blob: bytes) -> bytes:
    if (
        len(blob) != variable["payloadSize"] + 4
        or int.from_bytes(blob[:4], "little") != variable["attributes"]
    ):
        raise ProvisioningError("UEFI backup size or attributes do not match the profile")
    result = bytearray(blob)
    for parameter in variable["parameters"]:
        offset, width = parameter["offset"] + 4, parameter["width"]
        current = int.from_bytes(blob[offset : offset + width], "little")
        legal = (
            current in parameter["allowedValues"]
            if "allowedValues" in parameter
            else parameter["range"]["min"] <= current <= parameter["range"]["max"]
        )
        if not legal:
            raise ProvisioningError("UEFI parameter has an unexpected value: " + parameter["name"])
        result[offset : offset + width] = parameter["value"].to_bytes(width, "little")
    return bytes(result)


def preflight(spec: WorkerSpec) -> None:
    profile = spec["installation"]["uefi"]
    verify_environment(profile)
    # Validate every variable before OS installation or any firmware write.
    for variable in profile["variables"]:
        desired_blob(variable, read_variable(variable))


def variable_flags(path: Path) -> int:
    with path.open("rb") as source:
        flags = array.array("L", [0])
        fcntl.ioctl(source.fileno(), UEFI_GETFLAGS, flags, True)
        return flags[0]


@contextmanager
def firmware_io(stage: str) -> Iterator[None]:
    """Expose the failing operation and errno, never paths or variable contents."""
    try:
        yield
    except OSError as error:
        code = errno.errorcode.get(error.errno or 0, "UNKNOWN")
        raise ProvisioningError(f"UEFI {stage} failed: {code} (errno {error.errno})") from None


def write_variable(
    variable: UefiVariable, before: bytes, desired: bytes, original_flags: int
) -> None:
    path = UEFI_ROOT / variable_name(variable)
    actual = read_variable(variable)
    if actual not in (before, desired):
        raise ProvisioningError("UEFI variable changed after its backup; refusing to overwrite it")
    with path.open("rb") as attributes:
        failure = None
        try:
            if actual != desired:
                with firmware_io("clear immutable flag"):
                    fcntl.ioctl(
                        attributes.fileno(),
                        UEFI_SETFLAGS,
                        array.array("L", [original_flags & ~UEFI_IMMUTABLE]),
                    )
                # No truncation, creation, deletion, buffered writes or partial-write retry.
                with firmware_io("open variable for writing"):
                    descriptor = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                try:
                    with firmware_io("write variable"):
                        if os.write(descriptor, desired) != len(desired):
                            raise ProvisioningError(
                                "UEFI write was incomplete; inspect the retained backup"
                            )
                finally:
                    os.close(descriptor)
                with firmware_io("read back variable"):
                    if read_variable(variable) != desired:
                        raise ProvisioningError("UEFI read-back differs from the requested update")
        except ProvisioningError as error:
            failure = error
            raise
        finally:
            # Also repair an interrupted attempt that wrote data but lost its SSH session.
            try:
                with firmware_io("restore immutable flag"):
                    fcntl.ioctl(
                        attributes.fileno(), UEFI_SETFLAGS, array.array("L", [original_flags])
                    )
            except ProvisioningError as restoration:
                if failure is not None:
                    raise ProvisioningError(f"{failure}; {restoration}") from None
                raise


def atomic_write(destination: Path, state: object) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=".uefi-", dir=UEFI_STATE)
    try:
        with os.fdopen(descriptor, "w") as output:
            output.write(canonical(state))
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, destination)
        directory = os.open(UEFI_STATE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def save_transaction(state: FirmwareTransaction) -> None:
    atomic_write(UEFI_STATE / "uefi-operation.json", state)


@contextmanager
def operation(
    payload: JsonObject,
) -> Iterator[tuple[FirmwareProfile, FirmwareTransaction | None]]:
    if Path("/var/lib/k0s").exists() or Path("/etc/kubernetes/kubelet.conf").exists():
        raise ProvisioningError("UEFI provisioning refuses an already enrolled worker")
    profile = payload["spec"]["installation"]["uefi"]
    verify_environment(profile)
    os.chmod(UEFI_STATE, 0o700)
    with (UEFI_STATE / "uefi.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        receipt = json.loads((UEFI_STATE / "installed.json").read_text())
        if receipt["uid"] != payload["uid"] or receipt["fingerprint"] != fingerprint(
            payload["spec"]
        ):
            raise ProvisioningError("UEFI operation is not bound to this installed worker")
        path = UEFI_STATE / "uefi-operation.json"
        state = cast(FirmwareTransaction, json.loads(path.read_text())) if path.exists() else None
        if state is None and receipt.get("uefiStarted"):
            raise ProvisioningError(
                "UEFI backup is missing; restore the retained operation before proceeding"
            )
        if state:
            if state["uid"] != payload["uid"] or state["fingerprint"] != fingerprint(
                payload["spec"]
            ):
                raise ProvisioningError("UEFI backup belongs to another operation")
            if len(state["variables"]) != len(profile["variables"]):
                raise ProvisioningError("UEFI backup is incomplete")
            for variable, saved in zip(profile["variables"], state["variables"]):
                if saved["name"] != variable_name(variable) or desired_blob(
                    variable, bytes.fromhex(saved["before"])
                ) != bytes.fromhex(saved["after"]):
                    raise ProvisioningError("UEFI backup does not match the profile")
        yield profile, state


def verify_values(profile: FirmwareProfile) -> None:
    for variable in profile["variables"]:
        actual = read_variable(variable)
        if actual != desired_blob(variable, actual):
            raise ProvisioningError(
                "UEFI parameters did not persist; inspect firmware or power-cycle requirements"
            )


def apply(payload: JsonObject) -> JsonObject:
    with operation(payload) as (profile, state):
        boot = UEFI_BOOT_ID.read_text().strip()
        if state is None:
            if boot != payload["expectedBootId"]:
                raise ProvisioningError(
                    "installed host rebooted before UEFI configuration; inspect before writing"
                )
            variables: list[VariableBackup] = []
            for variable in profile["variables"]:
                before = read_variable(variable)
                variables.append(
                    {
                        "name": variable_name(variable),
                        "before": before.hex(),
                        "after": desired_blob(variable, before).hex(),
                        "flags": variable_flags(UEFI_ROOT / variable_name(variable)),
                    }
                )
            state = {
                "uid": payload["uid"],
                "fingerprint": fingerprint(payload["spec"]),
                "bootId": boot,
                "variables": variables,
                "complete": False,
                "changed": any(v["before"] != v["after"] for v in variables),
            }
            save_transaction(state)  # fsync every original before touching any variable.
        if not state["complete"]:
            if boot != state["bootId"]:
                raise ProvisioningError(
                    "reboot during incomplete UEFI update; inspect the retained backup"
                )
            # A lost transaction must not make a just-written value look like
            # preexisting configuration that needs no firmware reboot.
            receipt = json.loads((UEFI_STATE / "installed.json").read_text())
            if not receipt.get("uefiStarted"):
                atomic_write(UEFI_STATE / "installed.json", {**receipt, "uefiStarted": True})
            for variable, saved in zip(profile["variables"], state["variables"]):
                write_variable(
                    variable,
                    bytes.fromhex(saved["before"]),
                    bytes.fromhex(saved["after"]),
                    saved["flags"],
                )
            state["complete"] = True
            save_transaction(state)
        verify_values(profile)
        return {"configured": True, "changed": state["changed"], "sourceBootId": state["bootId"]}


def reboot(payload: JsonObject) -> JsonObject:
    with operation(payload) as (profile, state):
        if not state or not state["complete"]:
            raise ProvisioningError("UEFI configuration is incomplete; refusing to reboot")
        verify_values(profile)
        if not state["changed"] or UEFI_BOOT_ID.read_text().strip() != state["bootId"]:
            return {"scheduled": False}
        loaded = Path("/sys/kernel/kexec_loaded")
        if loaded.exists() and loaded.read_text().strip() != "0":
            raise ProvisioningError(
                "a kexec image is loaded; UEFI activation requires a firmware reboot"
            )
        unit = "nebula-uefi-" + payload["uid"]
        if subprocess.run(["systemctl", "is-active", "--quiet", unit + ".timer"]).returncode == 0:
            return {"scheduled": True}
        if (
            state.get("rebootRequested")
            and command(["systemctl", "show", "--property=LoadState", "--value", unit + ".timer"])
            != "not-found"
        ):
            # Shutdown can leave SSH reachable while another service drains.
            # Wait for this request until the management deadline; never enqueue another.
            return {"scheduled": True}
        state["rebootRequested"] = True
        save_transaction(state)
        # Explicit reboot.target performs normal shutdown and firmware boot; no kexec/soft-reboot selection.
        command(
            [
                "systemd-run",
                "--unit=" + unit,
                "--on-active=5s",
                "systemctl",
                "--no-block",
                "--job-mode=replace-irreversibly",
                "start",
                "reboot.target",
            ]
        )
        return {"scheduled": True}


def verify(payload: JsonObject) -> JsonObject:
    with operation(payload) as (profile, state):
        if not state or not state["complete"]:
            raise ProvisioningError("UEFI verification has no completed operation")
        boot = UEFI_BOOT_ID.read_text().strip()
        if state["changed"] and boot == state["bootId"]:
            return {"verified": False}
        verify_values(profile)
        checks = profile.get("verification", {})
        if checks.get("cpuFlags"):
            processors = [
                set(line.split(":", 1)[1].split())
                for line in Path("/proc/cpuinfo").read_text().splitlines()
                if line.startswith("flags")
            ]
            if not processors or any(not set(checks["cpuFlags"]) <= flags for flags in processors):
                raise ProvisioningError("UEFI CPU capability verification failed")
        for check in checks.get("moduleParameters", []):
            command(["modprobe", check["module"]])
            actual = (
                (Path("/sys/module") / check["module"] / "parameters" / check["parameter"])
                .read_text()
                .strip()
            )
            if actual != check["value"]:
                raise ProvisioningError(
                    "UEFI kernel module verification failed: "
                    + check["module"]
                    + "/"
                    + check["parameter"]
                )
        return {"verified": True, "bootId": boot}
