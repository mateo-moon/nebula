"""Hardware-bound efivarfs updates, prepended after installer.py in the SSH agent.

Only existing NV/BS/RT variables are modified. Full originals stay in a private,
durable transaction on the installed OS; they never enter Kubernetes or logs.
"""
import array
from contextlib import contextmanager
import fcntl
import os
from pathlib import Path
import tempfile

UEFI_ROOT = Path("/sys/firmware/efi/efivars")
UEFI_DMI = Path("/sys/class/dmi/id")
UEFI_STATE = Path("/var/lib/nebula-baremetal")
UEFI_BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
# Linux x86-64 ioctl numbers; the installer already restricts host architecture.
UEFI_GETFLAGS, UEFI_SETFLAGS, UEFI_IMMUTABLE = 0x80086601, 0x40086602, 0x10


def uefi_environment(profile):
    if not UEFI_ROOT.is_dir():
        raise ValueError("UEFI runtime variables are unavailable on this boot")
    filesystem = subprocess.run(["findmnt", "-n", "-o", "FSTYPE", "--mountpoint", str(UEFI_ROOT)], capture_output=True, text=True)
    if filesystem.returncode:
        command(["mount", "-t", "efivarfs", "efivarfs", str(UEFI_ROOT)])
    elif filesystem.stdout.strip() != "efivarfs":
        raise ValueError("UEFI variable path is not an efivarfs mount")
    fields = {"boardVendor": "board_vendor", "boardName": "board_name", "biosVersion": "bios_version", "biosVendor": "bios_vendor"}
    for key, expected in profile["match"].items():
        if (UEFI_DMI / fields[key]).read_text().strip() != expected:
            raise ValueError("UEFI profile does not match " + key)


def uefi_name(variable):
    return variable["name"] + "-" + variable["guid"].lower()


def uefi_read(variable):
    path = UEFI_ROOT / uefi_name(variable)
    if path.is_symlink():
        raise ValueError("UEFI variable must not be a symlink")
    with path.open("rb") as source:
        blob = source.read(variable["payloadSize"] + 5)
    if len(blob) != variable["payloadSize"] + 4 or int.from_bytes(blob[:4], "little") != variable["attributes"]:
        raise ValueError("UEFI variable size or attributes do not match the profile")
    return blob


def uefi_desired(variable, blob):
    if len(blob) != variable["payloadSize"] + 4 or int.from_bytes(blob[:4], "little") != variable["attributes"]:
        raise ValueError("UEFI backup size or attributes do not match the profile")
    result = bytearray(blob)
    for parameter in variable["parameters"]:
        offset, width = parameter["offset"] + 4, parameter["width"]
        current = int.from_bytes(blob[offset:offset + width], "little")
        legal = current in parameter["allowedValues"] if "allowedValues" in parameter else parameter["range"]["min"] <= current <= parameter["range"]["max"]
        if not legal:
            raise ValueError("UEFI parameter has an unexpected value: " + parameter["name"])
        result[offset:offset + width] = parameter["value"].to_bytes(width, "little")
    return bytes(result)


def uefi_preflight(spec):
    profile = spec["installation"]["uefi"]
    uefi_environment(profile)
    # Validate every variable before OS installation or any firmware write.
    for variable in profile["variables"]:
        uefi_desired(variable, uefi_read(variable))
    return {"matched": True}


def uefi_flags(path):
    with path.open("rb") as source:
        flags = array.array("L", [0])
        fcntl.ioctl(source.fileno(), UEFI_GETFLAGS, flags, True)
        return flags[0]


def uefi_write(variable, before, desired, original_flags):
    path = UEFI_ROOT / uefi_name(variable)
    actual = uefi_read(variable)
    if actual not in (before, desired):
        raise ValueError("UEFI variable changed after its backup; refusing to overwrite it")
    with path.open("rb") as attributes:
        try:
            if actual != desired:
                fcntl.ioctl(attributes.fileno(), UEFI_SETFLAGS, array.array("L", [original_flags & ~UEFI_IMMUTABLE]))
                # No truncation, creation, deletion, buffered writes or partial-write retry.
                descriptor = os.open(path, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
                try:
                    if os.write(descriptor, desired) != len(desired):
                        raise ValueError("UEFI write was incomplete; inspect the retained backup")
                finally:
                    os.close(descriptor)
                if uefi_read(variable) != desired:
                    raise ValueError("UEFI read-back differs from the requested update")
        finally:
            # Also repair an interrupted attempt that wrote data but lost its SSH session.
            fcntl.ioctl(attributes.fileno(), UEFI_SETFLAGS, array.array("L", [original_flags]))


def uefi_atomic_write(destination, state):
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


def uefi_save(state):
    uefi_atomic_write(UEFI_STATE / "uefi-operation.json", state)


@contextmanager
def uefi_operation(payload):
    if Path("/var/lib/k0s").exists() or Path("/etc/kubernetes/kubelet.conf").exists():
        raise ValueError("UEFI provisioning refuses an already enrolled worker")
    profile = payload["spec"]["installation"]["uefi"]
    uefi_environment(profile)
    os.chmod(UEFI_STATE, 0o700)
    with (UEFI_STATE / "uefi.lock").open("a") as lock:
        os.chmod(lock.name, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        receipt = json.loads((UEFI_STATE / "installed.json").read_text())
        if receipt["uid"] != payload["uid"] or receipt["fingerprint"] != fingerprint(payload["spec"]):
            raise ValueError("UEFI operation is not bound to this installed worker")
        path = UEFI_STATE / "uefi-operation.json"
        state = json.loads(path.read_text()) if path.exists() else None
        if state is None and receipt.get("uefiStarted"):
            raise ValueError("UEFI backup is missing; restore the retained operation before proceeding")
        if state:
            if state["uid"] != payload["uid"] or state["fingerprint"] != fingerprint(payload["spec"]):
                raise ValueError("UEFI backup belongs to another operation")
            if len(state["variables"]) != len(profile["variables"]):
                raise ValueError("UEFI backup is incomplete")
            for variable, saved in zip(profile["variables"], state["variables"]):
                if saved["name"] != uefi_name(variable) or uefi_desired(variable, bytes.fromhex(saved["before"])) != bytes.fromhex(saved["after"]):
                    raise ValueError("UEFI backup does not match the profile")
        yield profile, state


def uefi_values_ready(profile):
    for variable in profile["variables"]:
        actual = uefi_read(variable)
        if actual != uefi_desired(variable, actual):
            raise ValueError("UEFI parameters did not persist; inspect firmware or power-cycle requirements")


def uefi_apply(payload):
    with uefi_operation(payload) as (profile, state):
        boot = UEFI_BOOT_ID.read_text().strip()
        if state is None:
            if boot != payload["expectedBootId"]:
                raise ValueError("installed host rebooted before UEFI configuration; inspect before writing")
            variables = []
            for variable in profile["variables"]:
                before = uefi_read(variable)
                variables.append({"name": uefi_name(variable), "before": before.hex(), "after": uefi_desired(variable, before).hex(),
                                  "flags": uefi_flags(UEFI_ROOT / uefi_name(variable))})
            state = {"uid": payload["uid"], "fingerprint": fingerprint(payload["spec"]), "bootId": boot,
                     "variables": variables, "complete": False, "changed": any(v["before"] != v["after"] for v in variables)}
            uefi_save(state)  # fsync every original before touching any variable.
        if not state["complete"]:
            if boot != state["bootId"]:
                raise ValueError("reboot during incomplete UEFI update; inspect the retained backup")
            # A lost transaction must not make a just-written value look like
            # preexisting configuration that needs no firmware reboot.
            receipt = json.loads((UEFI_STATE / "installed.json").read_text())
            if not receipt.get("uefiStarted"):
                uefi_atomic_write(UEFI_STATE / "installed.json", {**receipt, "uefiStarted": True})
            for variable, saved in zip(profile["variables"], state["variables"]):
                uefi_write(variable, bytes.fromhex(saved["before"]), bytes.fromhex(saved["after"]), saved["flags"])
            state["complete"] = True
            uefi_save(state)
        uefi_values_ready(profile)
        return {"configured": True, "changed": state["changed"], "sourceBootId": state["bootId"]}


def uefi_reboot(payload):
    with uefi_operation(payload) as (profile, state):
        if not state or not state["complete"]:
            raise ValueError("UEFI configuration is incomplete; refusing to reboot")
        uefi_values_ready(profile)
        if not state["changed"] or UEFI_BOOT_ID.read_text().strip() != state["bootId"]:
            return {"scheduled": False}
        loaded = Path("/sys/kernel/kexec_loaded")
        if loaded.exists() and loaded.read_text().strip() != "0":
            raise ValueError("a kexec image is loaded; UEFI activation requires a firmware reboot")
        unit = "nebula-uefi-" + payload["uid"]
        if subprocess.run(["systemctl", "is-active", "--quiet", unit + ".timer"]).returncode == 0:
            return {"scheduled": True}
        if state.get("rebootRequested") and command(["systemctl", "show", "--property=LoadState", "--value", unit + ".timer"]) != "not-found":
            # Shutdown can leave SSH reachable while another service drains.
            # Wait for this request until the management deadline; never enqueue another.
            return {"scheduled": True}
        state["rebootRequested"] = True
        uefi_save(state)
        # Explicit reboot.target performs normal shutdown and firmware boot; no kexec/soft-reboot selection.
        command(["systemd-run", "--unit=" + unit, "--on-active=5s", "systemctl", "--no-block",
                 "--job-mode=replace-irreversibly", "start", "reboot.target"])
        return {"scheduled": True}


def uefi_verify(payload):
    with uefi_operation(payload) as (profile, state):
        if not state or not state["complete"]:
            raise ValueError("UEFI verification has no completed operation")
        boot = UEFI_BOOT_ID.read_text().strip()
        if state["changed"] and boot == state["bootId"]:
            return {"verified": False}
        uefi_values_ready(profile)
        checks = profile.get("verification", {})
        if checks.get("cpuFlags"):
            processors = [set(line.split(":", 1)[1].split()) for line in Path("/proc/cpuinfo").read_text().splitlines() if line.startswith("flags")]
            if not processors or any(not set(checks["cpuFlags"]) <= flags for flags in processors):
                raise ValueError("UEFI CPU capability verification failed")
        for check in checks.get("moduleParameters", []):
            command(["modprobe", check["module"]])
            actual = (Path("/sys/module") / check["module"] / "parameters" / check["parameter"]).read_text().strip()
            if actual != check["value"]:
                raise ValueError("UEFI kernel module verification failed: " + check["module"] + "/" + check["parameter"])
        return {"verified": True, "bootId": boot}
