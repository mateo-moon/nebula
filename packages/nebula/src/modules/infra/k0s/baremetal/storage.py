"""Disk discovery and explicitly bounded cleanup from a rescue OS.

Inspection is read-only. Cleanup runs only after the installation checkpoint,
with the replacement kernel already loaded, and never on a disk-backed root.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path

from models import JsonObject
from runtime import ProvisioningError, command, json_command


def descendants(items: list[JsonObject]) -> Iterator[JsonObject]:
    for item in items:
        yield item
        yield from descendants(item.get("children", []))


def inventory() -> list[JsonObject]:
    devices = list(
        json_command(
            ["lsblk", "-b", "-p", "-J", "-o", "NAME,PATH,TYPE,SIZE,RO,RM,SERIAL,MOUNTPOINTS,FSTYPE"]
        )["blockdevices"]
    )
    for device in descendants(devices):
        if device.get("fstype") == "linux_raid_member":
            metadata = dict(
                line.split("=", 1)
                for line in command(["mdadm", "--examine", "--export", device["path"]]).splitlines()
                if "=" in line
            )
            if not metadata.get("MD_UUID") or not metadata.get("MD_DEVICES", "").isdigit():
                raise ProvisioningError(
                    "MD member metadata is incomplete; a qualified disk profile is required"
                )
            device["raidUuid"] = metadata["MD_UUID"]
            device["raidDevices"] = int(metadata["MD_DEVICES"])
    return devices


def stable_disk(disk: JsonObject) -> JsonObject:
    ids = sorted(
        path
        for path in Path("/dev/disk/by-id").iterdir()
        if str(path.resolve()) == disk["path"] and "-part" not in path.name
    )
    if not ids:
        raise ProvisioningError("selected disk needs a stable /dev/disk/by-id identity")
    return {**disk, "byId": str(ids[0])}


def workload_disks(serials: list[str]) -> list[JsonObject]:
    disks = [disk for disk in inventory() if disk["type"] == "disk"]
    return [
        stable_disk({key: disk[key] for key in ("path", "serial", "size")})
        for disk in select_erase_disks(disks, serials)
    ]


def verify_volume_group(name: str, expected_serials: set[str]) -> None:
    report = json_command(["pvs", "--readonly", "--reportformat", "json", "-o", "pv_name,vg_name"])
    serials: set[str] = set()
    for pv in report["report"][0]["pv"]:
        if pv["vg_name"].strip() == name:
            devices = json_command(
                ["lsblk", "-s", "-p", "-J", "-o", "NAME,TYPE,SERIAL", pv["pv_name"].strip()]
            )["blockdevices"]
            serials.update(
                device["serial"].strip()
                for device in descendants(devices)
                if device["type"] == "disk"
            )
    if serials != expected_serials:
        raise ProvisioningError("workload volume group does not contain exactly the declared disks")


def root_devices() -> list[JsonObject]:
    root = json_command(["findmnt", "-J", "-o", "SOURCE,FSTYPE", "/"])["filesystems"][0]
    if root["fstype"] in ("overlay", "tmpfs", "ramfs"):
        return []
    if not str(root["source"]).startswith("/dev/"):
        raise ProvisioningError("unsupported root filesystem; use a RAM/rescue OS")
    return list(
        descendants(
            json_command(["lsblk", "-s", "-p", "-J", "-o", "NAME,PATH,TYPE", root["source"]])[
                "blockdevices"
            ]
        )
    )


@dataclass(frozen=True)
class CleanupPlan:
    disks: tuple[str, ...]
    partitions: tuple[str, ...]
    arrays: tuple[str, ...]


def select_erase_disks(disks: list[JsonObject], serials: list[str]) -> list[JsonObject]:
    selected: list[JsonObject] = []
    for serial in serials:
        matches = [disk for disk in disks if (disk.get("serial") or "").strip() == serial]
        if len(matches) != 1 or matches[0].get("ro") or matches[0].get("rm"):
            raise ProvisioningError("erase serial must resolve to one writable fixed disk")
        selected.append(matches[0])
    return selected


def validate_array_members(disks: list[JsonObject], selected_paths: set[str]) -> None:
    members: dict[str, set[str]] = {}
    expected: dict[str, set[int]] = {}
    for disk in disks:
        for child in descendants(disk.get("children", [])):
            if child.get("raidUuid"):
                key = child["raidUuid"]
                members.setdefault(key, set()).add(disk["path"])
                expected.setdefault(key, set()).add(child["raidDevices"])
            if child["type"].startswith("raid"):
                members.setdefault(child["path"], set()).add(disk["path"])
    for key, parents in members.items():
        if parents & selected_paths and not parents <= selected_paths:
            raise ProvisioningError("MD array contains a disk outside eraseSerials")
        if parents & selected_paths and key in expected and expected[key] != {len(parents)}:
            raise ProvisioningError(
                "MD array has missing or inconsistent members; refusing disk cleanup"
            )


def cleanup_plan(devices: list[JsonObject], serials: list[str]) -> CleanupPlan:
    """Every disk must resolve uniquely; shared or mounted storage fails closed."""
    disks = [device for device in devices if device["type"] == "disk"]
    selected = select_erase_disks(disks, serials)
    paths = {disk["path"] for disk in selected}
    validate_array_members(disks, paths)
    partitions, arrays = set(), set()
    for child in descendants(selected):
        if child.get("fstype") in ("LVM2_member", "crypto_LUKS", "mpath_member"):
            raise ProvisioningError("erase refuses LVM, encrypted and multipath signatures")
        if any(child.get("mountpoints") or []):
            raise ProvisioningError(
                "erase disk or its dependent storage is mounted or used as swap"
            )
        kind = child["type"]
        if kind.startswith("raid"):
            if child.get("children"):
                raise ProvisioningError("nested storage on an MD array is unsupported")
            arrays.add(child["path"])
        elif kind == "part":
            partitions.add(child["path"])
        elif kind != "disk":
            raise ProvisioningError("erase supports plain partitions and MD arrays only")
    return CleanupPlan(tuple(sorted(paths)), tuple(sorted(partitions)), tuple(sorted(arrays)))


def reject_unapproved_holders(devices: list[JsonObject], selected_path: str) -> None:
    for device in devices:
        if device["path"] == selected_path:
            for child in descendants(device.get("children", [])):
                if child["type"].startswith("raid") or child["type"] in ("crypt", "mpath"):
                    raise ProvisioningError(
                        "selected disk has RAID/encrypted/multipath holders; explicit rescue cleanup is required"
                    )


def erase_from_rescue(serials: list[str]) -> None:
    # Re-discover immediately before mutation. No stale /dev/nvme numbering or
    # array name from staging authorizes a write after the hardware changes.
    if root_devices():
        raise ProvisioningError("explicit disk cleanup requires a RAM/rescue OS")
    if Path("/sys/kernel/kexec_loaded").read_text().strip() != "1":
        raise ProvisioningError("refusing disk cleanup without a loaded replacement kernel")
    plan = cleanup_plan(inventory(), serials)
    for array in plan.arrays:
        command(["mdadm", "--stop", array])
    for device in (*plan.partitions, *plan.disks):
        command(["wipefs", "--all", device])
    command(["udevadm", "settle"])
