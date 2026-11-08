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
        n = path.name[4:8]
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


def partitions(disk: str = "") -> list[str]:
    args = ["lsblk", "--list", "--json", "--output", "PARTTYPE,PARTUUID"]
    devices = json.loads(command([*args, disk] if disk else args))["blockdevices"]
    return [
        str(uuid.UUID(device["partuuid"]))
        for device in devices
        if (device["parttype"] or "").lower() == ESP_TYPE
    ]


def capture(disk: str) -> list[dict[str, str]]:
    require_variables()
    order()  # Reject malformed firmware priority before any destructive action.
    if value("BootNext") is not None:
        raise ValueError("Resolve pending EFI BootNext before OS installation")
    selected = partitions(disk)
    if selected:
        visible = partitions()
        if any(visible.count(partition) != 1 for partition in selected):
            raise ValueError("Selected ESP UUID is not unique; EFI entry ownership is ambiguous")
    return [
        {"number": n, "sha256": hashlib.sha256(raw).hexdigest()}
        for n, raw in sorted(entries().items())
        if (option := load_option(raw)) is not None and option[0] in selected
    ]


def esp_identity() -> tuple[str, str]:
    mount = command(["findmnt", "-n", "-o", "SOURCE,FSTYPE", "--mountpoint", str(ESP)]).split()
    if len(mount) != 2 or mount[1] != "vfat":
        raise ValueError("Installed OS needs a mounted FAT ESP")
    source = str(Path(mount[0]).resolve(strict=True))
    fields = command(["lsblk", "-dnro", "PKNAME,PARTUUID,PARTTYPE", source]).split()
    if len(fields) != 3 or fields[2].lower() != ESP_TYPE:
        raise ValueError("Installed ESP must be a direct GPT partition")
    return "/dev/" + fields[0], str(uuid.UUID(fields[1]))


def loader_file(loader: str) -> Path:
    if loader not in LOADERS:
        raise ValueError("Installed EFI entry does not target a Debian loader")
    return ESP.joinpath(*loader.lstrip("\\").split("\\"))


def installed_loader(part_uuid: str, current: dict[str, bytes]) -> tuple[str, bytes, str]:
    # GRUB owns registration. Check its result instead of implementing a second
    # installer or inferring ownership from a display label.
    for n in [*order(), *sorted(current)]:
        raw = current.get(n)
        option = load_option(raw) if raw is not None else None
        if (
            raw is not None
            and option is not None
            and option[0] == part_uuid
            and option[1] in LOADERS
            and option[2]
            and loader_file(option[1]).is_file()
        ):
            return n, raw, option[1]
    raise ValueError("GRUB did not register a valid Debian EFI loader for the installed ESP")


def verify(identity: dict[str, str], *, booted: bool = True) -> None:
    require_variables()
    n = identity["number"]
    raw = entries().get(n)
    if (
        raw is None
        or load_option(raw) != (identity["partUuid"], identity["loader"], True)
        or hashlib.sha256(raw).hexdigest() != identity["sha256"]
    ):
        raise ValueError("Installed Debian EFI entry identity changed")
    disk, part_uuid = esp_identity()
    if (
        part_uuid != identity["partUuid"]
        or Path(identity["disk"]).resolve() != Path(disk).resolve()
        or not loader_file(identity["loader"]).is_file()
    ):
        raise ValueError("Installed Debian EFI entry does not match the OS ESP")
    if order()[:1] != [n]:
        raise ValueError("Installed Debian EFI loader is not first in boot priority")
    if booted:
        if value("BootCurrent") != int(n, 16).to_bytes(2, "little"):
            raise ValueError("Installed OS did not boot through its recorded EFI loader")
        if uuid.UUID(BOOT_ID.read_text().strip()) == uuid.UUID(identity["installerBootId"]):
            raise ValueError("Installed OS is still running in the installer boot")


def configure(receipt_path: Path) -> None:
    require_variables()
    if receipt_path.is_symlink():
        raise ValueError("Installation receipt is a symlink")
    receipt = json.loads(receipt_path.read_text())
    source = receipt["sourceBootEntries"]
    if "bootLoader" in receipt:
        verify(receipt["bootLoader"], booted=False)
        return
    disk, part_uuid = esp_identity()
    if Path(receipt["systemDisk"]).resolve(strict=True) != Path(disk).resolve():
        raise ValueError("Installed ESP is not on the selected system disk")
    current = entries()
    n, raw, loader = installed_loader(part_uuid, current)
    boot_next = value("BootNext")
    if boot_next is not None and boot_next != int(n, 16).to_bytes(2, "little"):
        raise ValueError("EFI BootNext conflicts with the installed Debian loader")
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
    identity = {
        "number": n,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "partUuid": part_uuid,
        "loader": loader,
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
