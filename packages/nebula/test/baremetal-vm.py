"""Opt-in SSH -> kexec -> install -> firmware reboot on disposable QEMU disks.

Supply checksum-pinned Debian netboot artifacts. For UEFI also supply read-only
firmware code and a variables template; only a private copy of NVRAM is written.
The initial OS is a legacy fixture. Reinstallation uses the actual host agent.
"""

import argparse
import copy
import gzip
import hashlib
import json
import os
import shlex
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import baremetal_fixtures as fixtures
from agent import build_agent

installer = fixtures.installer
BASE = "https://deb.debian.org/debian/dists/trixie/main/installer-amd64/current/images/netboot/debian-installer/amd64/"
PINS = {
    "linux": "2b2358b37674d2505350528875bb17afae2a36522a9e8a9417eaca65a7da0e08",
    "initrd.gz": "57303d157cffce3fa402301667fbc9b2280aa7372082b081e777375ae49da5f2",
}


def run_test(options):
    artifacts = options.artifacts.resolve()
    for name, digest in PINS.items():
        if hashlib.sha256((artifacts / name).read_bytes()).hexdigest() != digest:
            raise ValueError("VM test installer checksum mismatch: " + name)
    if bool(options.firmware_code) != bool(options.firmware_vars):
        raise ValueError("UEFI requires both firmware code and a variables template")
    uefi = bool(options.firmware_code)
    root = Path(tempfile.mkdtemp(prefix="nebula-kexec-uefi-" if uefi else "nebula-kexec-bios-"))
    print("VM evidence directory:", root, flush=True)
    with socket.socket() as port_socket:
        port_socket.bind(("127.0.0.1", 0))
        port = port_socket.getsockname()[1]
    spec = copy.deepcopy(fixtures.SPEC)
    spec["address"] = "192.0.2.15"
    spec["hostname"] = "bm-192-0-2-15"
    spec["installation"].update(
        {
            "dualStack": False,
            "rootSizeGiB": 8,
            "disk": {"minSizeGiB": 16},
            "kernel": {"url": BASE + "linux", "sha256": PINS["linux"]},
            "initrd": {"url": BASE + "initrd.gz", "sha256": PINS["initrd.gz"]},
        }
    )
    facts = {
        "bootId": "before-vm-install",
        # The seed is deliberately a legacy OS fixture, without the new receipt.
        "uefi": False,
        "disk": {"byId": "/dev/disk/by-id/virtio-nebula-test"},
        "network": {
            "mac": "52:54:00:12:34:56",
            "addresses": ["192.0.2.15/24"],
            "dns": ["192.0.2.3"],
            "routes": [{"destination": "0.0.0.0/0", "gateway": "192.0.2.2"}],
        },
    }
    for name in ("worker-key", "ssh_host_ed25519_key"):
        subprocess.run(
            ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / name)], check=True
        )
    public_key = (root / "worker-key.pub").read_text().strip()
    receipt = {
        "uid": "vm-seed",
        "fingerprint": installer.fingerprint(spec),
        "hostname": spec["hostname"],
        "sourceBootId": facts["bootId"],
    }
    files = installer.render_files(spec, facts, public_key, receipt)
    if uefi:
        # Only the legacy seed recipe differs. The actual reinstall below uses
        # the unmodified production agent and its discovered firmware facts.
        files["preseed.cfg"] = files["preseed.cfg"].replace(
            b"1 1 1 free $iflabel{ gpt } method{ biosgrub } . ",
            b"538 538 538 free $iflabel{ gpt } $reusemethod{ } method{ efi } format{ } . ",
        )
    for name in ("ssh_host_ed25519_key", "ssh_host_ed25519_key.pub"):
        files["nebula/hostkeys/" + name] = (root / name).read_bytes()
    (root / "seeded-initrd").write_bytes(
        (artifacts / "initrd.gz").read_bytes() + gzip.compress(installer.cpio(files), mtime=0)
    )
    subprocess.run(
        ["qemu-img", "create", "-f", "qcow2", str(root / "disk.qcow2"), "32G"],
        check=True,
        stdout=subprocess.DEVNULL,
    )
    accelerator = "kvm" if os.access("/dev/kvm", os.R_OK | os.W_OK) else "tcg,thread=multi"
    base = [
        "qemu-system-x86_64",
        "-machine",
        "q35",
        "-accel",
        accelerator,
        "-cpu",
        "max",
        "-smp",
        "2",
        "-m",
        "3072",
        "-drive",
        f"file={root}/disk.qcow2,format=qcow2,if=none,id=disk0",
        "-device",
        "virtio-blk-pci,drive=disk0,serial=nebula-test",
        "-netdev",
        f"user,id=net0,net=192.0.2.0/24,host=192.0.2.2,dns=192.0.2.3,dhcpstart=192.0.2.15,ipv6=off,hostfwd=tcp:127.0.0.1:{port}-:22",
        "-device",
        "virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56",
        "-display",
        "none",
        "-qmp",
        f"unix:{root}/qmp.sock,server=on,wait=off",
    ]
    if uefi:
        shutil.copyfile(options.firmware_vars.resolve(), root / "vars.fd")
        base += [
            "-drive",
            f"if=pflash,unit=0,format=raw,readonly=on,file={options.firmware_code.resolve()}",
            "-drive",
            f"if=pflash,unit=1,format=raw,file={root}/vars.fd",
        ]
    (root / "launch.json").write_text(json.dumps({"base": base, "spec": spec, "uefi": uefi}))
    first = subprocess.Popen(
        base
        + [
            "-serial",
            f"file:{root}/first-install.log",
            "-no-reboot",
            "-kernel",
            str(artifacts / "linux"),
            "-initrd",
            str(root / "seeded-initrd"),
            "-append",
            "auto=true priority=critical --- console=ttyS0,115200n8",
        ],
        stderr=(root / "qemu-first.log").open("w"),
    )
    try:
        print("Booting legacy source fixture on a new disposable disk", flush=True)
        first.wait(timeout=1800)
        if first.returncode != 0:
            raise RuntimeError("initial VM installation failed")
    finally:
        if first.poll() is None:
            first.terminate()
            first.wait(timeout=30)
    host_key = " ".join((root / "ssh_host_ed25519_key.pub").read_text().split()[:2])
    (root / "known_hosts").write_text(spec["hostname"] + " " + host_key + "\n")
    ssh = [
        "ssh",
        "-F",
        "/dev/null",
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "ServerAliveInterval=5",
        "-o",
        "ServerAliveCountMax=2",
        "-o",
        "StrictHostKeyChecking=yes",
        "-o",
        "HostKeyAlias=" + spec["hostname"],
        "-o",
        "UserKnownHostsFile=" + str(root / "known_hosts"),
        "-o",
        "GlobalKnownHostsFile=/dev/null",
        "-i",
        str(root / "worker-key"),
        "-p",
        str(port),
        "root@127.0.0.1",
    ]
    (root / "ssh.json").write_text(json.dumps(ssh))
    here = Path(__file__).resolve().parents[1] / "src/modules/infra/k0s/baremetal"

    def shell(script, check=True):
        return subprocess.run(
            ssh + [script], text=True, capture_output=True, timeout=90, check=check
        )

    def call(action, uid, **extra):
        # Read the current runtime at each call, including when debugging a VM.
        try:
            result = subprocess.run(
                ssh + [shlex.join(["python3", "-I", "-B", "-c", build_agent(here), action])],
                text=True,
                capture_output=True,
                timeout=900 if action in ("probe", "stage") else 45,
                input=installer.canonical({"uid": uid, "spec": spec, **extra}),
            )
        except subprocess.TimeoutExpired:
            # A source SSH connection can disappear mid-command during kexec.
            # Retry verification without printing the embedded agent or payload.
            raise RuntimeError("VM SSH transport timed out during " + action) from None
        if result.returncode:
            raise RuntimeError("VM agent failed: " + (result.stdout + result.stderr)[-1500:])
        return json.loads(result.stdout)

    def wait_verified(uid):
        deadline = time.monotonic() + 1800
        last_error = "no response"
        while time.monotonic() < deadline:
            try:
                result = call("verify", uid)
                if result.get("verified"):
                    return result
            except RuntimeError as error:
                last_error = str(error)
            time.sleep(5)
        raise RuntimeError("VM did not return with the expected receipt: " + last_error)

    second = subprocess.Popen(
        base + ["-serial", f"file:{root}/ssh-reinstall.log"],
        stderr=(root / "qemu-second.log").open("w"),
    )
    try:
        wait_verified("vm-seed")
        print("Initial OS, pinned SSH, static networking and LVM verified", flush=True)
        shell("rm /var/lib/nebula-baremetal/installed.json")
        if uefi:
            # A different loader survives in NVRAM while reinstall erases its
            # files. Its forced ID also prevents accidental same-ID coverage.
            shell(
                r"""set -eu
cp -r /boot/efi/EFI/debian /boot/efi/EFI/nebula-source
efibootmgr --create-only --bootnum 0077 --disk /dev/vda --part 1 --label nebula-source --loader '\EFI\nebula-source\grubx64.efi'
python3 - <<'INNER'
import struct,subprocess
from pathlib import Path
v=Path('/sys/firmware/efi/efivars')
g='-8be4df61-93ca-11d2-aa0d-00e098032b8c'
for p in v.glob('Boot????'+g):
 raw=p.read_bytes()[4:]
 if raw[6:6+len('debian'.encode('utf-16-le'))].decode('utf-16-le').lower()=='debian':
  subprocess.run(['efibootmgr','--bootnum',p.name[4:8],'--delete-bootnum'],check=True)
raw=(v/('BootOrder'+g)).read_bytes()[4:]
order=[f'{int.from_bytes(raw[i:i+2],"little"):04X}' for i in range(0,len(raw),2)]
# Network/firmware entries precede the old OS; BootNext selects the source once.
order=[n for n in order if n!='0077']+['0077']
subprocess.run(['efibootmgr','--bootorder',','.join(order),'--bootnext','0077'],check=True)
INNER
systemctl reboot
""",
                check=False,
            )
            deadline = time.monotonic() + 300
            while time.monotonic() < deadline:
                response = shell("efibootmgr", check=False)
                if response.returncode == 0 and "BootCurrent: 0077" in response.stdout:
                    break
                time.sleep(3)
            else:
                raise RuntimeError("UEFI did not boot the distinct legacy source loader")
        (root / "source-ready").touch()
        if options.pause_before_reinstall:
            print("Waiting for", root / "continue-test", flush=True)
            deadline = time.monotonic() + 1800
            while not (root / "continue-test").exists():
                if time.monotonic() > deadline:
                    raise RuntimeError("VM debugging pause timed out")
                time.sleep(3)
        discovered = call("probe", "vm-ssh-reinstall")
        if bool(discovered["uefi"]) != uefi:
            raise RuntimeError("VM source firmware mode differs from the requested test")
        (root / "source-facts.json").write_text(json.dumps(discovered, indent=2))
        call("stage", "vm-ssh-reinstall", facts=discovered, workerPublicKey=public_key)
        print("Actual SSH staging and kexec load passed", flush=True)
        call("commit", "vm-ssh-reinstall")
        result = wait_verified("vm-ssh-reinstall")
        installed = json.loads(shell("cat /var/lib/nebula-baremetal/installed.json").stdout)
        if uefi:
            firmware = shell("efibootmgr --verbose").stdout
            if "Boot0077" in firmware or "nebula-source" in firmware:
                raise RuntimeError("Stale source loader entry survived reinstall")
            (root / "firmware-after-install.txt").write_text(firmware)
            if not installed.get("bootLoader"):
                raise RuntimeError("Installed EFI loader identity was not recorded")
        (root / "installed-receipt.json").write_text(json.dumps(installed, indent=2))
        print("UEFI disk boot after kexec reinstall verified:", result, flush=True)
        first_boot = result["bootId"]
        shell("systemctl reboot", check=False)
        deadline = time.monotonic() + 300
        while time.monotonic() < deadline:
            try:
                result = call("verify", "vm-ssh-reinstall")
                if result.get("verified") and result["bootId"] != first_boot:
                    break
            except RuntimeError:
                pass
            time.sleep(3)
        else:
            raise RuntimeError("Installed OS did not pass a second ordinary firmware reboot")
        (root / "result.json").write_text(json.dumps({"uefi": uefi, "verified": result}, indent=2))
        print("Second ordinary reboot and pinned SSH verified:", result, flush=True)
    finally:
        second.terminate()
        second.wait(timeout=30)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True, type=Path)
    parser.add_argument("--firmware-code", type=Path)
    parser.add_argument("--firmware-vars", type=Path)
    parser.add_argument("--pause-before-reinstall", action="store_true")
    run_test(parser.parse_args())
