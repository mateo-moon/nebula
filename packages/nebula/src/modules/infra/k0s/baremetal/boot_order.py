"""Preserve firmware boot priority across Debian bootloader registration.

Also runs standalone in the new OS during Debian Installer's late command.
Only BootOrder is changed; load options and BootNext belong to their owners.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

VARIABLES = Path("/sys/firmware/efi/efivars")
MOUNTS = Path("/proc/mounts")
GLOBAL_GUID = "8be4df61-93ca-11d2-aa0d-00e098032b8c"


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


def numbers(data: object) -> list[str]:
    if not isinstance(data, list) or any(
        not isinstance(n, str) or not re.fullmatch(r"[0-9A-F]{4}", n) for n in data
    ):
        raise ValueError("Invalid firmware boot order")
    if len(set(data)) != len(data):
        raise ValueError("Duplicate firmware boot entry")
    return list(data)


def capture() -> list[str]:
    mounted = any(
        fields[1:3] == [str(VARIABLES), "efivarfs"]
        for line in MOUNTS.read_text().splitlines()
        if len(fields := line.split()) >= 3
    )
    if not mounted or not VARIABLES.is_dir():
        raise ValueError("EFI variables are unavailable")
    raw = value("BootOrder") or b""
    if len(raw) % 2:
        raise ValueError("EFI BootOrder is truncated")
    order = numbers(
        [f"{int.from_bytes(raw[i : i + 2], 'little'):04X}" for i in range(0, len(raw), 2)]
    )
    if any(value("Boot" + n) is None for n in order):
        raise ValueError("EFI BootOrder references a missing entry")
    return order


def verify(expected: list[str]) -> None:
    # Firmware may append newly discovered devices on reboot. They cannot
    # precede or reorder the recorded choices, but do not need to block handoff.
    expected = numbers(expected)
    if not expected:
        raise ValueError("Recorded firmware boot priority is empty")
    if capture()[: len(expected)] != expected:
        raise ValueError("Firmware boot priority differs from the installation receipt")


def restore(receipt_path: Path) -> None:
    if receipt_path.is_symlink():
        raise ValueError("Installation receipt is a symlink")
    receipt = json.loads(receipt_path.read_text())
    source = numbers(receipt["sourceBootOrder"])
    if "bootOrder" in receipt:
        # A completed late command can be retried, but cannot undo operator drift.
        verify(receipt["bootOrder"])
        return
    current = capture()
    # GRUB may replace its old entry. Keep surviving original entries in their
    # original order, then append newly registered entries in GRUB's order.
    expected = [n for n in source if value("Boot" + n) is not None]
    expected += [n for n in current if n not in expected]
    if not expected:
        raise ValueError("Installer registered no firmware boot entries")
    boot_next = value("BootNext")
    if current != expected:
        subprocess.run(
            ["efibootmgr", "--bootorder", ",".join(expected)],
            check=True,
            capture_output=True,
            timeout=30,
        )
    if capture() != expected:
        raise ValueError("Firmware boot order write did not persist")
    if value("BootNext") != boot_next:
        raise ValueError("EFI BootNext changed during boot priority restoration")
    receipt["bootOrder"] = expected
    with tempfile.NamedTemporaryFile(mode="w", dir=receipt_path.parent, delete=False) as output:
        json.dump(receipt, output, sort_keys=True)
        output.flush()
        os.fsync(output.fileno())
    Path(output.name).replace(receipt_path)


if __name__ == "__main__":
    restore(Path(sys.argv[1]))
