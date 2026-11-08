"""Register and verify the installed Debian loader, retiring only owned old entries.

Runs standalone in Debian Installer's target. Network entries and entries for
other disks are never deleted. Firmware boot priority selects the new OS first.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

VARIABLES = Path("/sys/firmware/efi/efivars")
MOUNTS = Path("/proc/mounts")
ESP = Path("/boot/efi")
BOOT_ID = Path("/proc/sys/kernel/random/boot_id")
GLOBAL_GUID = "8be4df61-93ca-11d2-aa0d-00e098032b8c"
ESP_TYPE = "c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
LOADERS = ("\\efi\\debian\\shimx64.efi", "\\efi\\debian\\grubx64.efi")


def command(args: list[str]) -> str:
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=30).strip()


def require_variables() -> None:
    mounted = any(
        fields[1:3] == [str(VARIABLES), "efivarfs"]
        for line in MOUNTS.read_text().splitlines()
        if len(fields := line.split()) >= 3
    )
    if not mounted or not VARIABLES.is_dir():
        raise ValueError("EFI variables are unavailable")


def value(name: str) -> bytes | None:
    path = VARIABLES / (name + "-" + GLOBAL_GUID)
    if path.is_symlink():
        raise ValueError("EFI boot variable is a symlink")
    if not path.exists():
        return None
    blob = path.read_bytes()
    if len(blob) < 4:
        raise ValueError("EFI boot variable is truncated")
    return blob[4:]


def number(data: object) -> str:
    if not isinstance(data, str) or not re.fullmatch(r"[0-9A-F]{4}", data):
        raise ValueError("Invalid firmware boot entry number")
    return data


def order() -> list[str]:
    raw = value("BootOrder") or b""
    if len(raw) % 2:
        raise ValueError("EFI BootOrder is truncated")
    result = [f"{int.from_bytes(raw[i : i + 2], 'little'):04X}" for i in range(0, len(raw), 2)]
    if len(set(result)) != len(result):
        raise ValueError("Duplicate firmware boot entry")
    return result


def entries() -> dict[str, bytes]:
    result = {}
    for path in VARIABLES.glob("Boot????-" + GLOBAL_GUID):
        if not re.fullmatch(r"[0-9A-F]{4}", path.name[4:8]):
            continue
        n = number(path.name[4:8])
        raw = value("Boot" + n)
        if raw is not None:
            result[n] = raw
    return result


def load_option(raw: bytes) -> tuple[str, str, bool] | None:
    """Decode a GPT hard-drive/file device path; never trust a display label."""
    if len(raw) < 8:
        return None
    end = next((i for i in range(6, len(raw) - 1, 2) if raw[i : i + 2] == b"\0\0"), None)
    if end is None:
        return None
    offset = end + 2
    stop = offset + int.from_bytes(raw[4:6], "little")
    if stop > len(raw):
        return None
    partition, filename = "", ""
    while offset + 4 <= stop:
        kind, subtype = raw[offset : offset + 2]
        size = int.from_bytes(raw[offset + 2 : offset + 4], "little")
        if size < 4 or offset + size > stop:
            return None
        node = raw[offset : offset + size]
        if (kind, subtype, size) == (4, 1, 42) and node[40:42] == b"\x02\x02":
            if partition:
                return None
            partition = str(uuid.UUID(bytes_le=node[24:40]))
        elif (kind, subtype) == (4, 4):
            try:
                filename += node[4:].decode("utf-16-le").rstrip("\0")
            except UnicodeDecodeError:
                return None
        elif kind == 0x7F:
            if subtype != 0xFF or size != 4 or offset + size != stop:
                return None
            return (partition, filename.lower(), bool(raw[0] & 1)) if partition else None
        offset += size
    return None


def source_entries(data: object) -> list[dict[str, str]]:
    if not isinstance(data, list):
        raise ValueError("Invalid source EFI entries")
    result: list[dict[str, str]] = []
    for entry in data:
        if not isinstance(entry, dict) or set(entry) != {"number", "sha256"}:
            raise ValueError("Invalid source EFI entry identity")
        n, digest = number(entry["number"]), entry["sha256"]
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid source EFI entry fingerprint")
        if any(item["number"] == n for item in result):
            raise ValueError("Duplicate source EFI entry")
        result.append({"number": n, "sha256": digest})
    return result


def partition_ids(devices: list[dict[str, object]]) -> list[str]:
    result: list[str] = []
    for device in devices:
        if str(device.get("parttype", "")).lower() == ESP_TYPE and device.get("partuuid"):
            result.append(str(uuid.UUID(str(device["partuuid"]))))
        children = device.get("children", [])
        if isinstance(children, list):
            result.extend(partition_ids(children))
    return result


def capture(disk: str) -> list[dict[str, str]]:
    require_variables()
    order()  # Reject malformed firmware priority before any destructive action.
    # kexec does not consume BootNext. Do not carry a conflicting one-shot boot
    # through a destructive install or silently overwrite another owner's intent.
    if value("BootNext") is not None:
        raise ValueError("Resolve pending EFI BootNext before OS installation")
    devices = json.loads(command(["lsblk", "-p", "-J", "-o", "PARTTYPE,PARTUUID", disk]))
    partitions = partition_ids(devices["blockdevices"])
    if partitions:
        visible = json.loads(command(["lsblk", "-p", "-J", "-o", "PARTTYPE,PARTUUID"]))
        all_ids = partition_ids(visible["blockdevices"])
        if any(all_ids.count(partition) != 1 for partition in partitions):
            raise ValueError("Selected ESP UUID is not unique; EFI entry ownership is ambiguous")
    return [
        {"number": n, "sha256": hashlib.sha256(raw).hexdigest()}
        for n, raw in sorted(entries().items())
        if (option := load_option(raw)) is not None and option[0] in partitions
    ]


def esp_identity() -> tuple[str, str, str]:
    mount = command(
        ["findmnt", "-n", "-o", "SOURCE,FSTYPE,OPTIONS", "--mountpoint", str(ESP)]
    ).split()
    if len(mount) != 3 or mount[1] != "vfat" or "rw" not in mount[2].split(","):
        raise ValueError("Installed OS needs a writable FAT ESP")
    source = str(Path(mount[0]).resolve(strict=True))
    fields = command(["lsblk", "-dnro", "PKNAME,PARTUUID,PARTTYPE", source]).split()
    if len(fields) != 3 or fields[2].lower() != ESP_TYPE:
        raise ValueError("Installed ESP must be a direct GPT partition")
    partition = (Path("/sys/class/block") / Path(source).name / "partition").read_text().strip()
    if not partition.isdecimal():
        raise ValueError("Installed ESP partition number is invalid")
    return "/dev/" + fields[0], partition, str(uuid.UUID(fields[1]))


def loader_file(loader: str) -> Path:
    if loader not in LOADERS:
        raise ValueError("Installed EFI entry does not target a Debian loader")
    return ESP.joinpath(*loader.lstrip("\\").split("\\"))


def select_loader(part_uuid: str) -> str | None:
    current = entries()
    candidates = [
        n
        for n, raw in current.items()
        if (option := load_option(raw)) is not None
        and option[0] == part_uuid
        and option[1] in LOADERS
        and option[2]
        and loader_file(option[1]).is_file()
    ]
    return next((n for n in [*order(), *sorted(candidates)] if n in candidates), None)


def installed_loader(disk: str, partition: str, part_uuid: str) -> str:
    n = select_loader(part_uuid)
    if n is None:
        loader = next((path for path in LOADERS if loader_file(path).is_file()), None)
        if loader is None:
            raise ValueError("Installed Debian EFI loader file is missing")
        command(
            [
                "efibootmgr",
                "--create-only",
                "--disk",
                disk,
                "--part",
                partition,
                "--label",
                "debian",
                "--loader",
                loader,
            ]
        )
        n = select_loader(part_uuid)
    if n is None:
        raise ValueError("Installed Debian EFI loader was not registered")
    return n


def loader_identity(data: object) -> dict[str, str]:
    fields = {"number", "sha256", "partUuid", "loader", "disk", "installerBootId"}
    if not isinstance(data, dict) or set(data) != fields:
        raise ValueError("Invalid installed EFI loader identity")
    identity: dict[str, str] = {}
    for key in fields:
        if not isinstance(data[key], str):
            raise ValueError("Invalid installed EFI loader identity")
        identity[key] = data[key]
    source_entries([{"number": identity["number"], "sha256": identity["sha256"]}])
    if str(uuid.UUID(identity["partUuid"])) != identity["partUuid"]:
        raise ValueError("Invalid installed ESP identity")
    if str(uuid.UUID(identity["installerBootId"])) != identity["installerBootId"]:
        raise ValueError("Invalid installer boot identity")
    if not Path(identity["disk"]).is_absolute():
        raise ValueError("Invalid installed system disk identity")
    loader_file(identity["loader"])
    return identity


def verify(identity: object, *, booted: bool = True) -> None:
    identity = loader_identity(identity)
    require_variables()
    n = number(identity["number"])
    raw = value("Boot" + n)
    option = load_option(raw) if raw is not None else None
    if (
        raw is None
        or option is None
        or not option[2]
        or hashlib.sha256(raw).hexdigest() != identity["sha256"]
        or option[:2] != (identity["partUuid"], identity["loader"])
    ):
        raise ValueError("Installed Debian EFI entry identity changed")
    disk, _, part_uuid = esp_identity()
    if (
        part_uuid != identity["partUuid"]
        or Path(identity["disk"]).resolve() != Path(disk).resolve()
        or not loader_file(identity["loader"]).is_file()
    ):
        raise ValueError("Installed Debian EFI entry does not match the OS ESP")
    if order()[:1] != [n]:
        raise ValueError("Installed Debian EFI loader is not first in boot priority")
    if booted and value("BootCurrent") != int(n, 16).to_bytes(2, "little"):
        raise ValueError("Installed OS did not boot through its recorded EFI loader")
    if booted and BOOT_ID.read_text().strip() == identity["installerBootId"]:
        raise ValueError("Installed OS is still running in the installer boot")


def configure(receipt_path: Path) -> None:
    require_variables()
    if receipt_path.is_symlink():
        raise ValueError("Installation receipt is a symlink")
    receipt = json.loads(receipt_path.read_text())
    source = source_entries(receipt["sourceBootEntries"])
    if "bootLoader" in receipt:
        verify(receipt["bootLoader"], booted=False)
        return
    disk, partition, part_uuid = esp_identity()
    if Path(receipt["systemDisk"]).resolve(strict=True) != Path(disk).resolve():
        raise ValueError("Installed ESP is not on the selected system disk")
    n = installed_loader(disk, partition, part_uuid)
    boot_next = value("BootNext")
    if boot_next is not None and boot_next != int(n, 16).to_bytes(2, "little"):
        raise ValueError("EFI BootNext conflicts with the installed Debian loader")
    current = entries()
    retired = [
        entry["number"]
        for entry in source
        if entry["number"] != n
        and entry["number"] in current
        and hashlib.sha256(current[entry["number"]]).hexdigest() == entry["sha256"]
    ]
    expected = [
        n,
        *(item for item in order() if item != n and item not in retired and item in current),
    ]
    if order() != expected:
        command(["efibootmgr", "--bootorder", ",".join(expected)])
    if order() != expected:
        raise ValueError("Installed Debian boot priority write did not persist")
    # Retire only entries captured from ESPs on the disk this install replaced,
    # and only while the complete payload still matches. GRUB may reuse IDs.
    for old in retired:
        if value("Boot" + old) != current[old]:
            raise ValueError("Old OS EFI entry ownership changed before removal")
        command(["efibootmgr", "--bootnum", old, "--delete-bootnum"])
        if value("Boot" + old) is not None:
            raise ValueError("Old OS EFI entry removal did not persist")
    if value("BootNext") != boot_next:
        raise ValueError("EFI BootNext changed during loader setup")
    raw = value("Boot" + n)
    option = load_option(raw) if raw is not None else None
    if raw is None or option is None:
        raise ValueError("Installed Debian EFI entry disappeared")
    identity = {
        "number": n,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "partUuid": part_uuid,
        "loader": option[1],
        "disk": receipt["systemDisk"],
        "installerBootId": str(uuid.UUID(BOOT_ID.read_text().strip())),
    }
    verify(identity, booted=False)
    receipt["bootLoader"] = identity
    with tempfile.NamedTemporaryFile(mode="w", dir=receipt_path.parent, delete=False) as output:
        json.dump(receipt, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    Path(output.name).replace(receipt_path)


if __name__ == "__main__":
    configure(Path(sys.argv[1]))
