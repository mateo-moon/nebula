"""One-shot EFI shell execution of checksum-pinned setup_var.efi.

Only BootNext and an owned Boot#### entry are written from Linux. Setup
variables are changed by the EFI application, with results retained on disk.
"""

from __future__ import annotations

import hashlib
import re
import shutil
from pathlib import Path
from typing import Callable

from models import EfiBootIntent, FirmwareProfile, FirmwareTransaction
from runtime import ProvisioningError, command

ESP = Path("/boot/efi")
VARIABLES = Path("/sys/firmware/efi/efivars")
GLOBAL_GUID = "8be4df61-93ca-11d2-aa0d-00e098032b8c"
ARTIFACTS = {
    "setup_var.efi": (
        "https://github.com/datasone/setup_var.efi/releases/download/0.3.1/setup_var.efi",
        "cbe5777b61276d3f3506a28b34845326e92f6c171bff59177e3912fe20f49840",
    ),
    "Shell.efi": (
        "https://github.com/pbatard/UEFI-Shell/releases/download/26H2/shellx64.efi",
        "4922d9885ac92d8ab58e5da4eb8ad6cbfbe651ea9cdc03a1ba67355e5ede83b1",
    ),
}


def global_value(name: str) -> bytes | None:
    path = VARIABLES / (name + "-" + GLOBAL_GUID)
    if path.is_symlink():
        raise ProvisioningError("EFI boot variable is a symlink")
    if not path.exists():
        return None
    blob = path.read_bytes()
    if len(blob) < 4:
        raise ProvisioningError("EFI boot variable is truncated")
    return blob[4:]


def boot_number(name: str) -> str:
    value = global_value(name)
    if value is None or len(value) != 2:
        raise ProvisioningError("EFI " + name + " is unavailable")
    return f"{int.from_bytes(value, 'little'):04X}"


def esp_identity() -> tuple[str, str, str]:
    mount = command(
        ["findmnt", "-n", "-o", "SOURCE,FSTYPE,OPTIONS", "--mountpoint", str(ESP)]
    ).split()
    if len(mount) != 3 or mount[1] != "vfat" or "rw" not in mount[2].split(","):
        raise ProvisioningError("UEFI execution requires an existing writable FAT ESP")
    source = str(Path(mount[0]).resolve(strict=True))
    fields = command(["lsblk", "-dnro", "PKNAME,PARTUUID,PARTTYPE", source]).split()
    if len(fields) != 3 or fields[2].lower() != "c12a7328-f81f-11d2-ba4b-00a0c93ec93b":
        raise ProvisioningError("ESP must be a direct GPT EFI partition")
    partition = (Path("/sys/class/block") / Path(source).name / "partition").read_text().strip()
    if not partition.isdecimal() or not re.fullmatch(r"[a-fA-F0-9-]{36}", fields[1]):
        raise ProvisioningError("ESP partition identity is invalid")
    return "/dev/" + fields[0], partition, fields[1].lower()


def script(profile: FirmwareProfile, intent: EfiBootIntent) -> str:
    path = "\\EFI\\" + intent["directory"]
    arguments = [
        f"{v['name']}:0x{p['offset']:X}({p['width']})=0x{p['value']:X}"
        for v in profile["variables"]
        for p in v["parameters"]
    ]
    return_value = int(intent["returnBoot"], 16).to_bytes(2, "little").hex()
    lines = [
        "@echo -off",
        "map -r",
        "for %f in " + " ".join(f"fs{i}" for i in range(16)),
        f"  if exist %f:{path}\\setup_var.efi then",
        # Consume a separate guard, keeping this script in place so another
        # selection cannot fall back to an unrelated startup.nsh.
        f"    if not exist %f:{path}\\once.flag then",
        "      exit 1",
        "    endif",
        f"    rm %f:{path}\\once.flag",
        "    if %lasterror% ne 0 then",
        "      exit 1",
        "    endif",
        f"    echo marker={intent['directory']} > %f:{path}\\status.log",
        f"    setvar BootNext -guid {GLOBAL_GUID} -nv -bs -rt =H{return_value}",
        "    set returnStatus %lasterror%",
        f"    echo returnStatus=%returnStatus% >> %f:{path}\\status.log",
        "    if %returnStatus% ne 0 then",
        "      exit 1",
        "    endif",
        f"    %f:{path}\\setup_var.efi --write_on_demand {' '.join(arguments)} > %f:{path}\\apply.log",
        "    set applyStatus %lasterror%",
        f"    echo applyStatus=%applyStatus% >> %f:{path}\\status.log",
        "    reset -w",
        "    exit 1",
        "  endif",
        "endfor",
        "exit 1",
    ]
    return "\r\n".join(lines) + "\r\n"


def fetch_artifact(destination: Path) -> None:
    url, digest = ARTIFACTS[destination.name]
    if destination.is_symlink():
        raise ProvisioningError("EFI artifact path is a symlink")
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == digest:
        return
    temporary = destination.with_suffix(".download")
    if temporary.exists() or temporary.is_symlink():
        raise ProvisioningError("Unexpected interrupted EFI artifact download")
    command(
        [
            "curl",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "20",
            "--max-time",
            "120",
            "--max-filesize",
            str(8 * 1024**2),
            "--output",
            str(temporary),
            url,
        ]
    )
    if (
        temporary.stat().st_size > 8 * 1024**2
        or hashlib.sha256(temporary.read_bytes()).hexdigest() != digest
    ):
        temporary.unlink()
        raise ProvisioningError("EFI artifact checksum mismatch")
    temporary.replace(destination)


def owned_entry(intent: EfiBootIntent) -> bytes | None:
    raw = global_value("Boot" + intent["bootNumber"])
    if raw is None:
        return None
    # An entry created before a lost SSH response can be recovered using its
    # exact private label, GPT identity and loader. Never delete by number alone.
    listing = command(["efibootmgr", "--verbose"])
    line = next(
        (s for s in listing.splitlines() if s.startswith("Boot" + intent["bootNumber"])), ""
    )
    if not all(
        s.lower() in line.lower()
        for s in (
            intent["directory"],
            intent["partUuid"],
            "\\EFI\\" + intent["directory"] + "\\Shell.efi",
        )
    ):
        raise ProvisioningError("EFI boot entry ownership changed")
    if intent.get("entryHash") and hashlib.sha256(raw).hexdigest() != intent["entryHash"]:
        raise ProvisioningError("EFI boot entry changed after staging")
    return raw


def new_intent(
    state: FirmwareTransaction, part_uuid: str, save: Callable[[FirmwareTransaction], None]
) -> None:
    number = next((f"{i:04X}" for i in range(65536) if global_value(f"Boot{i:04X}") is None), None)
    if number is None:
        raise ProvisioningError("No free EFI boot entry")
    directory = (
        "nebula-"
        + hashlib.sha256(
            (state["uid"] + ":" + str(state.get("generation", 0))).encode()
        ).hexdigest()[:20]
    )
    if (ESP / "EFI" / directory).exists():
        raise ProvisioningError("EFI staging directory already exists without an ownership receipt")
    state["efiBoot"] = {
        "directory": directory,
        "bootNumber": number,
        "returnBoot": boot_number("BootCurrent"),
        "partUuid": part_uuid,
        "bootOrder": (global_value("BootOrder") or b"").hex(),
    }
    save(state)  # Persist ownership before creating files or an entry.


def prepare(
    profile: FirmwareProfile,
    state: FirmwareTransaction,
    save: Callable[[FirmwareTransaction], None],
) -> None:
    if global_value("SecureBoot") != b"\x00":
        raise ProvisioningError(
            "setup_var.efi requires Secure Boot disabled; refusing to change trust policy"
        )
    if shutil.which("efibootmgr") is None:
        raise ProvisioningError("UEFI execution requires efibootmgr on the installed OS")
    disk, partition, part_uuid = esp_identity()
    if global_value("BootNext") is not None:
        raise ProvisioningError("A pending BootNext already exists; refusing to replace it")
    if "efiBoot" not in state:
        new_intent(state, part_uuid, save)
    intent = state["efiBoot"]
    if intent["partUuid"] != part_uuid:
        raise ProvisioningError("ESP identity changed during EFI preparation")
    path = ESP / "EFI" / intent["directory"]
    if path.is_symlink() or (ESP / "EFI").is_symlink():
        raise ProvisioningError("EFI staging directory is a symlink")
    path.mkdir(exist_ok=True)
    for name in ARTIFACTS:
        fetch_artifact(path / name)
    startup = path / "startup.nsh"
    if any((path / name).is_symlink() for name in ("startup.nsh", "once.flag", "options.bin")):
        raise ProvisioningError("EFI startup script is a symlink")
    startup.write_bytes(script(profile, intent).encode("ascii"))
    (path / "once.flag").write_text(intent["directory"])
    options = path / "options.bin"
    options.write_bytes(
        "Shell.efi -startup -nointerrupt -nomap -noversion -noconsolein -exit\0".encode("utf-16-le")
    )
    if owned_entry(intent) is None:
        command(
            [
                "efibootmgr",
                "--create-only",
                "--disk",
                disk,
                "--part",
                partition,
                "--bootnum",
                intent["bootNumber"],
                "--label",
                intent["directory"],
                "--loader",
                "\\EFI\\" + intent["directory"] + "\\Shell.efi",
                "--append-binary-args",
                str(options),
            ]
        )
    raw = owned_entry(intent)
    if raw is None:
        raise ProvisioningError("EFI boot entry was not created")
    intent["entryHash"] = hashlib.sha256(raw).hexdigest()
    if (global_value("BootOrder") or b"").hex() != intent["bootOrder"]:
        raise ProvisioningError("EFI preparation unexpectedly changed BootOrder")
    command(["sync", "-f", str(ESP)])
    save(state)


def arm(intent: EfiBootIntent) -> None:
    if esp_identity()[2] != intent["partUuid"] or owned_entry(intent) is None:
        raise ProvisioningError("EFI boot intent is no longer bound to the installed ESP")
    expected = int(intent["bootNumber"], 16).to_bytes(2, "little")
    actual = global_value("BootNext")
    if actual is not None and actual != expected:
        raise ProvisioningError("BootNext belongs to another operation")
    if actual is None:
        command(["efibootmgr", "--bootnext", intent["bootNumber"]])
    if global_value("BootNext") != expected:
        raise ProvisioningError("EFI BootNext did not persist")


def execution_result(intent: EfiBootIntent) -> None:
    if esp_identity()[2] != intent["partUuid"]:
        raise ProvisioningError("ESP changed after EFI execution")
    path = ESP / "EFI" / intent["directory"]
    status = (path / "status.log").read_bytes().decode("utf-16", errors="replace")
    if "marker=" + intent["directory"] not in status:
        raise ProvisioningError("EFI execution receipt is missing or belongs to another operation")
    if not re.search(r"(?m)^applyStatus=(?:0x)?0\s*$", status):
        output = (
            (path / "apply.log").read_bytes().decode("utf-16", errors="replace")
            if (path / "apply.log").exists()
            else ""
        )
        codes = [
            code
            for code in (
                "WRITE_PROTECTED",
                "SECURITY_VIOLATION",
                "ACCESS_DENIED",
                "NOT_FOUND",
                "INVALID_PARAMETER",
                "ABORTED",
            )
            if code in output
        ]
        raise ProvisioningError(
            "setup_var.efi failed: " + (", ".join(codes) or "missing or unsuccessful EFI result")
        )
    if not re.search(r"(?m)^returnStatus=(?:0x)?0\s*$", status):
        raise ProvisioningError("EFI return boot was not armed successfully")


def cleanup(intent: EfiBootIntent, archive: Path) -> None:
    if esp_identity()[2] != intent["partUuid"]:
        raise ProvisioningError("ESP changed; refusing firmware cleanup")
    path = ESP / "EFI" / intent["directory"]
    archive.mkdir(mode=0o700, exist_ok=True)
    for name in ("status.log", "apply.log"):
        source = path / name
        if source.exists() and not source.is_symlink():
            (archive / name).write_bytes(source.read_bytes())
            (archive / name).chmod(0o600)
    owned_entry(intent)
    if global_value("BootNext") == int(intent["bootNumber"], 16).to_bytes(2, "little"):
        command(["efibootmgr", "--delete-bootnext"])
    if owned_entry(intent) is not None:
        command(["efibootmgr", "--bootnum", intent["bootNumber"], "--delete-bootnum"])
    if path.exists() and not path.is_symlink():
        shutil.rmtree(path)
    command(["sync", "-f", str(ESP)])
