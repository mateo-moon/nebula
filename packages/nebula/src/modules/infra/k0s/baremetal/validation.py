"""Validate provisioning profiles before any host side effects."""

import ipaddress
import re
from urllib.parse import urlparse

from models import (
    Artifact,
    DiskPolicy,
    FirmwareChecks,
    FirmwareProfile,
    Installation,
    UefiVariable,
    WorkerSpec,
)
from runtime import ProvisioningError


def require_uefi(ok: object, message: str) -> None:
    if not ok:
        raise ProvisioningError("UEFI: " + message)


def unsigned_integer(value: object, maximum: int) -> bool:
    return type(value) is int and 0 <= value <= maximum


def validate_variable(variable: UefiVariable) -> None:
    require_uefi(
        re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]{0,127}", variable["name"]), "invalid variable name"
    )
    require_uefi(
        re.fullmatch(r"[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}", variable["guid"]),
        "invalid variable GUID",
    )
    require_uefi(
        unsigned_integer(variable["payloadSize"], 65536)
        and variable["payloadSize"] > 0
        and variable["attributes"] == 7,
        "require an exact payload size and NV/BS/RT attributes (7)",
    )
    require_uefi(
        isinstance(variable["parameters"], list) and 1 <= len(variable["parameters"]) <= 64,
        "declare 1–64 parameters",
    )
    occupied: set[int] = set()
    names: set[str] = set()
    for parameter in variable["parameters"]:
        require_uefi(
            re.fullmatch(r"[ -~]{1,128}", parameter["name"]) and parameter["name"] not in names,
            "invalid or duplicate parameter name",
        )
        names.add(parameter["name"])
        offset, width, desired = parameter["offset"], parameter["width"], parameter["value"]
        require_uefi(
            type(width) is int
            and width in (1, 2, 4)
            and unsigned_integer(offset, variable["payloadSize"])
            and offset + width <= variable["payloadSize"],
            "parameter exceeds variable payload",
        )
        positions = set(range(offset, offset + width))
        require_uefi(not occupied & positions, "overlapping parameters")
        occupied |= positions
        maximum = 2 ** (8 * width) - 1
        require_uefi(unsigned_integer(desired, maximum), "parameter value exceeds width")
        require_uefi(
            ("allowedValues" in parameter) != ("range" in parameter),
            "declare legal values or a legal range",
        )
        if "allowedValues" in parameter:
            values = parameter["allowedValues"]
            require_uefi(
                isinstance(values, list)
                and 1 <= len(values) <= 64
                and all(unsigned_integer(v, maximum) for v in values)
                and desired in values,
                "invalid legal values",
            )
        else:
            limits = parameter["range"]
            require_uefi(
                unsigned_integer(limits["min"], maximum)
                and unsigned_integer(limits["max"], maximum)
                and limits["min"] <= desired <= limits["max"],
                "invalid legal range",
            )


def validate_firmware_checks(checks: FirmwareChecks) -> None:
    require_uefi(
        len(checks.get("cpuFlags", [])) <= 64 and len(checks.get("moduleParameters", [])) <= 64,
        "too many verification checks",
    )
    for flag in checks.get("cpuFlags", []):
        require_uefi(re.fullmatch(r"[a-z0-9_]{1,64}", flag), "invalid CPU flag")
    for check in checks.get("moduleParameters", []):
        require_uefi(
            re.fullmatch(r"[a-zA-Z0-9_]{1,64}", check["module"])
            and re.fullmatch(r"[a-zA-Z0-9_]{1,64}", check["parameter"])
            and re.fullmatch(r"[A-Za-z0-9_,.+-]{1,128}", check["value"]),
            "invalid module parameter check",
        )


def validate_artifact(artifact: Artifact) -> None:
    url = urlparse(artifact["url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
        raise ProvisioningError("installer artifacts require credential-free HTTPS")
    if not re.fullmatch("[a-f0-9]{64}", artifact["sha256"]):
        raise ProvisioningError("installer artifacts require SHA256 pins")


def validate_uefi(profile: FirmwareProfile) -> None:
    match = profile["match"]
    for key in ("boardVendor", "boardName", "biosVersion"):
        require_uefi(
            isinstance(match.get(key), str) and re.fullmatch(r"[ -~]{1,128}", match[key]),
            "exact hardware/BIOS identity is required",
        )
    require_uefi(
        set(match) <= {"boardVendor", "boardName", "biosVersion", "biosVendor"},
        "unknown hardware identity field",
    )
    require_uefi(
        "biosVendor" not in match or re.fullmatch(r"[ -~]{1,128}", match["biosVendor"]),
        "invalid BIOS vendor",
    )
    deadline = profile.get("rebootTimeoutSeconds", 900)
    require_uefi(
        unsigned_integer(deadline, 7200) and deadline >= 60,
        "reboot deadline must be 60–7200 seconds",
    )
    variables = profile["variables"]
    require_uefi(
        isinstance(variables, list) and 1 <= len(variables) <= 16, "declare 1–16 variables"
    )
    seen = set()
    for variable in variables:
        validate_variable(variable)
        identity = (variable["name"], variable["guid"].lower())
        require_uefi(identity not in seen, "duplicate variable")
        seen.add(identity)
    validate_firmware_checks(profile.get("verification", {}))


def validate_spec(spec: WorkerSpec) -> None:
    if ipaddress.ip_address(spec["address"]).version != 4:
        raise ProvisioningError("installer requires IPv4 SSH access")
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", spec["hostname"]):
        raise ProvisioningError("invalid hostname")
    ssh = spec["ssh"]
    if ssh.get("authentication", "privateKey") not in ("privateKey", "password"):
        raise ProvisioningError("invalid SSH authentication")
    if ssh.get("authentication") == "password" and ssh["secretName"] == ssh["workerSecretName"]:
        raise ProvisioningError("password bootstrap requires a separate initial SSH Secret")
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", ssh["user"]) or not 1 <= ssh["port"] <= 65535:
        raise ProvisioningError("invalid SSH settings")
    if bool(ssh.get("knownHostsSecretName")) == bool(ssh.get("trustOnFirstUse")):
        raise ProvisioningError("select pinned host keys or explicit first-use trust")
    validate_installation(spec["installation"])


def validate_disk_policy(disk: DiskPolicy) -> None:
    serial_pattern = r"[a-zA-Z0-9_.:-]{1,128}"
    if "serial" in disk and not re.fullmatch(serial_pattern, disk["serial"]):
        raise ProvisioningError("invalid disk serial")
    if "eraseSerials" in disk:
        serials = disk["eraseSerials"]
        if (
            not 1 <= len(serials) <= 16
            or len(set(serials)) != len(serials)
            or any(not re.fullmatch(serial_pattern, serial) for serial in serials)
            or disk.get("serial") not in serials
        ):
            raise ProvisioningError(
                "eraseSerials must include unique exact serials and the OS disk"
            )
    if "workloadSerials" in disk:
        serials = disk["workloadSerials"]
        if (
            not 1 <= len(serials) <= 15
            or len(set(serials)) != len(serials)
            or disk.get("serial") in serials
            or not set(serials) <= set(disk.get("eraseSerials", []))
        ):
            raise ProvisioningError("workloadSerials must be additional erased disks")


def validate_installation(installation: Installation) -> None:
    validate_disk_policy(installation["disk"])
    if "uefi" in installation:
        validate_uefi(installation["uefi"])
    validate_artifact(installation["kernel"])
    validate_artifact(installation["initrd"])
    if not re.fullmatch(r"[a-z][a-z0-9-]*", installation["suite"]):
        raise ProvisioningError("invalid Debian suite")
    if not re.fullmatch(r"[a-zA-Z][a-zA-Z0-9_-]{0,63}", installation["volumeGroup"]):
        raise ProvisioningError("invalid volume group")
    if (
        type(installation["rootSizeGiB"]) is not int
        or type(installation["disk"]["minSizeGiB"]) is not int
        or installation["rootSizeGiB"] < 8
        or installation["disk"]["minSizeGiB"] < installation["rootSizeGiB"] + 4
    ):
        raise ProvisioningError("insufficient disk/root allocation")
    if (
        type(installation.get("timeoutSeconds", 3600)) is not int
        or installation.get("timeoutSeconds", 3600) < 300
    ):
        raise ProvisioningError("installation deadline must be at least 300 seconds")
    if not re.fullmatch(
        r"[a-z0-9][a-z0-9.-]*", installation["mirror"]["hostname"]
    ) or not re.fullmatch(r"/[A-Za-z0-9/._-]*", installation["mirror"]["directory"]):
        raise ProvisioningError("invalid Debian mirror")
    for address in installation.get("dnsServers", []):
        if ipaddress.ip_address(address).is_loopback:
            raise ProvisioningError("loopback resolvers cannot be transferred to the installer")
