"""Opt-in setup_var.efi qualification in a fresh disposable QEMU/OVMF VM.

Requires qemu-system-x86_64, sgdisk and optional pyfatfs image tooling.
Firmware templates and checksum-pinned binaries are supplied read-only.
The test creates its own disk and NVRAM; it never touches host firmware.
"""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import baremetal_fixtures as fixtures

boot = fixtures.uefi_agent.efi_boot
OFFSET, SIZE = 2048 * 512, 64 * 1024**2


def seed(root, artifacts):
    from pyfatfs.PyFat import PyFat
    from pyfatfs.PyFatFS import PyFatFS

    partition = root / "partition.img"
    partition.touch()
    fat = PyFat()
    fat.mkfs(str(partition), fat_type=PyFat.FAT_TYPE_FAT32, size=SIZE)
    fat.close()
    profile = {
        "variables": [
            {
                "name": "Setup",
                "parameters": [
                    {"offset": 1, "width": 1, "value": 1},
                    {"offset": 4, "width": 4, "value": 99},
                ],
            }
        ]
    }
    intent = {"directory": "nebula-fixture", "returnBoot": "0001"}
    # Fresh standard OVMF uses 0000=UiApp, 0001=disk, 0002=built-in shell.
    # bcfg creates 0003 for this test; the serial trace verifies both entries.
    startup = r"""@echo -off
map -r
if exist fs0:\EFI\nebula-fixture\status.log then
 fs0:\EFI\nebula-fixture\setup_var.efi Setup:0x1(1) Setup:0x4(4) > fs0:\readback.log
 dmpstore Setup -guid 00000000-0000-0000-0000-aaaaaaaaaaaa > fs0:\layout.log
 dmpstore BootCurrent > fs0:\return.log
 fs0:\EFI\nebula-fixture\Shell.efi -startup -nointerrupt -nomap -noversion -noconsolein -exit
 fs0:\EFI\nebula-fixture\setup_var.efi Setup:0x1(1) Setup:0x4(4) > fs0:\second.log
 reset -s
endif
setvar Setup -guid 00000000-0000-0000-0000-aaaaaaaaaaaa -nv -bs -rt =Ha5ffa5a501000000a5a5a5a5a5a5a5a5
bcfg boot addp 0 fs0:\EFI\nebula-fixture\Shell.efi "nebula-fixture"
bcfg boot -opt 0 fs0:\EFI\nebula-fixture\options.bin
setvar BootNext -guid 8be4df61-93ca-11d2-aa0d-00e098032b8c -nv -bs -rt =H0300
reset -w
"""
    with PyFatFS(str(partition)) as filesystem:
        for directory in ("/EFI", "/EFI/BOOT", "/EFI/nebula-fixture"):
            filesystem.makedirs(directory, recreate=True)
        filesystem.writebytes("/EFI/BOOT/BOOTX64.EFI", (artifacts / "Shell.efi").read_bytes())
        for name in boot.ARTIFACTS:
            filesystem.writebytes("/EFI/nebula-fixture/" + name, (artifacts / name).read_bytes())
        filesystem.writebytes(
            "/EFI/BOOT/startup.nsh", startup.replace("\n", "\r\n").encode("ascii")
        )
        filesystem.writebytes(
            "/EFI/nebula-fixture/startup.nsh", boot.script(profile, intent).encode("ascii")
        )
        filesystem.writebytes("/EFI/nebula-fixture/once.flag", b"fixture")
        filesystem.writebytes(
            "/EFI/nebula-fixture/options.bin",
            "Shell.efi -startup -nointerrupt -nomap -noversion -noconsolein -exit\0".encode(
                "utf-16-le"
            ),
        )
    disk = root / "disk.img"
    with disk.open("wb") as output:
        output.truncate(96 * 1024**2)
    subprocess.run(
        ["sgdisk", "-n", "1:2048:+64M", "-t", "1:ef00", str(disk)], check=True, capture_output=True
    )
    with disk.open("r+b") as output:
        output.seek(OFFSET)
        output.write(partition.read_bytes())


def verify(root):
    from pyfatfs.PyFatFS import PyFatFS

    partition = root / "result.img"
    partition.write_bytes((root / "disk.img").read_bytes()[OFFSET : OFFSET + SIZE])
    with PyFatFS(str(partition)) as filesystem:

        def read(directory, name):
            actual = next(n for n in filesystem.listdir(directory) if n.lower() == name)
            return filesystem.readbytes(directory.rstrip("/") + "/" + actual).decode("utf-16")

        directory = "/EFI/nebula-fixture"
        status = read(directory, "status.log")
        assert "marker=nebula-fixture" in status
        assert re.search(r"(?m)^applyStatus=0x0\s*$", status), status
        assert re.search(r"(?m)^returnStatus=0x0\s*$", status), status
        assert "once.flag" not in [n.lower() for n in filesystem.listdir(directory)]
        first, second = read("/", "readback.log"), read("/", "second.log")
        assert first == second
        assert "Setup:0x1=0x01" in first and "Setup:0x4(4)=0x00000063" in first
        assert "A5 01 A5 A5 63 00 00 00-A5 A5 A5 A5 A5 A5 A5 A5" in read("/", "layout.log")
        assert "01 00" in read("/", "return.log")
    serial = (root / "serial.log").read_text(errors="replace")
    assert 'starting Boot0003 "nebula-fixture"' in serial
    assert serial.count('starting Boot0001 "UEFI QEMU HARDDISK') == 2
    return {"efiStatus": "success", "exactBytes": True, "returnBoot": "0001", "guardConsumed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--firmware-code", required=True, type=Path)
    parser.add_argument("--firmware-vars", required=True, type=Path)
    parser.add_argument("--qemu", default="qemu-system-x86_64")
    args = parser.parse_args()
    for name, (_, digest) in boot.ARTIFACTS.items():
        if hashlib.sha256((args.artifacts / name).read_bytes()).hexdigest() != digest:
            raise ValueError("EFI test artifact checksum mismatch: " + name)
    root = Path(tempfile.mkdtemp(prefix="nebula-efi-qualification-"))
    print("Disposable VM evidence:", root, flush=True)
    seed(root, args.artifacts)
    shutil.copy(args.firmware_vars, root / "vars.fd")
    process = subprocess.Popen(
        [
            args.qemu,
            "-machine",
            "q35,accel=tcg",
            "-m",
            "256",
            "-drive",
            f"if=pflash,format=raw,readonly=on,file={args.firmware_code.resolve()}",
            "-drive",
            f"if=pflash,format=raw,file={root}/vars.fd",
            "-drive",
            f"format=raw,file={root}/disk.img",
            "-display",
            "none",
            "-serial",
            f"file:{root}/serial.log",
            "-monitor",
            "none",
            "-net",
            "none",
        ]
    )
    try:
        if process.wait(timeout=180):
            raise ValueError("EFI test VM failed")
    finally:
        if process.poll() is None:
            process.kill()
            process.wait()
    print(json.dumps(verify(root)), flush=True)


if __name__ == "__main__":
    main()
