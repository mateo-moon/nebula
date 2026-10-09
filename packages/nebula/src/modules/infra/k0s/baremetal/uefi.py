"""Hardware-bound preboot setup_var.efi updates with durable backups and reboot checkpoints.

Only existing NV/BS/RT variables are modified. Full originals stay in a private,
durable transaction on the installed OS; they never enter Kubernetes or logs.
"""

from __future__ import annotations

import fcntl
import json
import os
import subprocess
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import cast

import efi_boot
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
    if list(UEFI_ROOT.glob(variable["name"] + "-*")) != [path]:
        raise ProvisioningError("setup_var.efi requires an unambiguous variable name and GUID")
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


def new_transaction(
    payload: JsonObject, profile: FirmwareProfile, boot: str
) -> FirmwareTransaction:
    if boot != payload["expectedBootId"]:
        raise ProvisioningError(
            "installed host rebooted before UEFI preparation; inspect before proceeding"
        )
    variables: list[VariableBackup] = []
    for variable in profile["variables"]:
        before = read_variable(variable)
        variables.append(
            {
                "name": variable_name(variable),
                "before": before.hex(),
                "after": desired_blob(variable, before).hex(),
            }
        )
    changed = any(v["before"] != v["after"] for v in variables)
    return {
        "uid": payload["uid"],
        "fingerprint": fingerprint(payload["spec"]),
        "bootId": boot,
        "variables": variables,
        "complete": not changed,
        "changed": changed,
        "backend": "setup_var.efi",
        "generation": payload.get("firmwareRetryGeneration", 0),
    }


def verify_backups(profile: FirmwareProfile, state: FirmwareTransaction, *, desired: bool) -> None:
    for variable, saved in zip(profile["variables"], state["variables"]):
        actual = read_variable(variable).hex()
        if actual != saved["after"] and (desired or actual != saved["before"]):
            raise ProvisioningError("UEFI variable differs from its complete backed-up layout")


def retry_transaction(payload: JsonObject, state: FirmwareTransaction) -> None:
    generation = payload.get("firmwareRetryGeneration", 0)
    if state.get("backend") != "setup_var.efi":
        raise ProvisioningError(
            "Legacy UEFI operation needs inspection before switching to preboot execution"
        )
    if generation == state.get("generation", 0):
        if state.get("failed"):
            raise ProvisioningError(state["failed"])
        return
    if generation != state.get("generation", 0) + 1 or not (
        state.get("failed") or state["complete"]
    ):
        raise ProvisioningError(
            "A new EFI attempt requires the next explicit retry generation after failure"
        )
    if state.get("efiBoot") and not state.get("cleanupComplete"):
        cleanup_attempt(state)
    state["bootId"] = UEFI_BOOT_ID.read_text().strip()
    state["generation"] = generation
    state.pop("efiBoot", None)
    state.pop("failed", None)
    state.pop("rebootRequested", None)
    state.pop("cleanupComplete", None)
    save_transaction(state)


def apply(payload: JsonObject) -> JsonObject:
    with operation(payload) as (profile, state):
        boot = UEFI_BOOT_ID.read_text().strip()
        if state is None:
            state = new_transaction(payload, profile, boot)
            save_transaction(state)  # fsync every original before touching EFI boot intent.
        retry_transaction(payload, state)
        verify_backups(profile, state, desired=state["complete"])
        if not state["complete"]:
            if boot != state["bootId"] or state.get("rebootRequested"):
                raise ProvisioningError("EFI execution already started; verify its retained result")
            receipt = json.loads((UEFI_STATE / "installed.json").read_text())
            if not receipt.get("uefiStarted"):
                atomic_write(UEFI_STATE / "installed.json", {**receipt, "uefiStarted": True})
            try:
                efi_boot.prepare(profile, state, save_transaction)
            except (OSError, ProvisioningError, subprocess.SubprocessError) as error:
                failure = (
                    str(error) if isinstance(error, ProvisioningError) else "EFI preparation failed"
                )
                state["failed"] = failure
                save_transaction(state)
                try:
                    cleanup_attempt(state)
                except (OSError, ProvisioningError, subprocess.SubprocessError):
                    failure += "; EFI boot cleanup failed; inspect retained intent"
                    state["failed"] = failure
                    save_transaction(state)
                raise ProvisioningError(failure) from None
        return {
            "configured": True,
            "changed": state["changed"] and not state["complete"],
            "sourceBootId": state["bootId"],
        }


def reboot(payload: JsonObject) -> JsonObject:
    with operation(payload) as (profile, state):
        if not state or state.get("backend") != "setup_var.efi" or state.get("failed"):
            raise ProvisioningError("UEFI execution has no valid prepared operation")
        if not state["changed"] or UEFI_BOOT_ID.read_text().strip() != state["bootId"]:
            return {"scheduled": False}
        if "efiBoot" not in state or "entryHash" not in state["efiBoot"]:
            raise ProvisioningError("EFI boot intent is incomplete")
        verify_backups(profile, state, desired=False)
        loaded = Path("/sys/kernel/kexec_loaded")
        if loaded.exists() and loaded.read_text().strip() != "0":
            raise ProvisioningError(
                "a kexec image is loaded; UEFI execution requires a firmware reboot"
            )
        unit = "nebula-uefi-" + payload["uid"]
        if state.get("rebootRequested"):
            if (
                command(["systemctl", "show", "--property=LoadState", "--value", unit + ".timer"])
                != "not-found"
            ):
                return {"scheduled": True}
            raise ProvisioningError(
                "EFI reboot checkpoint exists without its timer; inspect before retrying"
            )
        efi_boot.arm(state["efiBoot"])
        state["rebootRequested"] = True
        save_transaction(state)
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


def cleanup_attempt(state: FirmwareTransaction) -> None:
    if "efiBoot" in state:
        archive = UEFI_STATE / ("efi-attempt-" + str(state.get("generation", 0)))
        efi_boot.cleanup(state["efiBoot"], archive)
    state["cleanupComplete"] = True
    save_transaction(state)


def finish_execution(profile: FirmwareProfile, state: FirmwareTransaction) -> None:
    if state.get("failed"):
        raise ProvisioningError(state["failed"])
    intent = state.get("efiBoot")
    if not intent or not state.get("rebootRequested"):
        raise ProvisioningError("UEFI verification has no armed EFI execution")
    failure = ""
    try:
        efi_boot.execution_result(intent)
        verify_backups(profile, state, desired=True)
    except (OSError, ProvisioningError) as error:
        failure = (
            str(error)
            if isinstance(error, ProvisioningError)
            else "EFI execution result is missing"
        )
    try:
        cleanup_attempt(state)
    except (OSError, ProvisioningError, subprocess.SubprocessError):
        failure = (
            failure + "; " if failure else ""
        ) + "EFI boot cleanup failed; inspect retained intent"
    if failure:
        state["failed"] = failure
        save_transaction(state)
        raise ProvisioningError(failure)
    state["complete"] = True
    save_transaction(state)


def verify(payload: JsonObject) -> JsonObject:
    with operation(payload) as (profile, state):
        if not state or state.get("backend") != "setup_var.efi":
            raise ProvisioningError("UEFI verification has no prepared setup_var.efi operation")
        boot = UEFI_BOOT_ID.read_text().strip()
        if not state["complete"] and state["changed"] and boot == state["bootId"]:
            return {"verified": False}
        if not state["complete"]:
            finish_execution(profile, state)
        verify_backups(profile, state, desired=True)
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
