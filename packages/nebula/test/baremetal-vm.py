"""Opt-in destructive test restricted to a newly created disposable QEMU disk.

python3 -B test/baremetal-vm.py --artifacts /path/to/verified-debian-netboot
The directory must contain `linux` and `initrd.gz` matching the pins below.
Installs once from netboot, then tests the actual SSH -> kexec -> reinstall flow.
"""
import argparse
from contextlib import contextmanager
import gzip
import hashlib
import json
from pathlib import Path
import runpy
import shlex
import shutil
import socket
import subprocess
import tempfile
import time

fixtures = runpy.run_path(str(Path(__file__).with_name("baremetal-runtime.py")))
installer = fixtures["installer"]
BASE = "https://deb.debian.org/debian/dists/trixie/main/installer-amd64/current/images/netboot/debian-installer/amd64/"
PINS = {"linux": "2b2358b37674d2505350528875bb17afae2a36522a9e8a9417eaca65a7da0e08",
        "initrd.gz": "57303d157cffce3fa402301667fbc9b2280aa7372082b081e777375ae49da5f2"}


@contextmanager
def evidence_directory():
    root = Path(tempfile.mkdtemp(prefix="nebula-baremetal-vm-"))
    try:
        yield root
    except BaseException:
        print("Failed VM evidence retained in:", root, flush=True)
        raise
    else:
        shutil.rmtree(root)


def run_test(artifacts):
    for name, digest in PINS.items():
        if hashlib.sha256((artifacts / name).read_bytes()).hexdigest() != digest:
            raise ValueError("VM test installer checksum mismatch: " + name)
    with evidence_directory() as root:
        print("VM evidence directory:", root, flush=True)
        with socket.socket() as port_socket:
            port_socket.bind(("127.0.0.1", 0))
            port = port_socket.getsockname()[1]
        spec = fixtures["SPEC"]
        spec["installation"].update({"dualStack": False, "rootSizeGiB": 8, "disk": {"minSizeGiB": 16},
                                    "kernel": {"url": BASE + "linux", "sha256": PINS["linux"]},
                                    "initrd": {"url": BASE + "initrd.gz", "sha256": PINS["initrd.gz"]}})
        facts = {"bootId": "before-vm-install", "uefi": False, "disk": {"byId": "/dev/disk/by-id/virtio-nebula-test"},
                 "network": {"mac": "52:54:00:12:34:56", "addresses": ["192.0.2.15/24"], "dns": ["192.0.2.3"],
                             "routes": [{"destination": "0.0.0.0/0", "gateway": "192.0.2.2"}]}}
        for name in ("worker-key", "ssh_host_ed25519_key"):
            subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", str(root / name)], check=True)
        public_key = (root / "worker-key.pub").read_text().strip()
        receipt = {"uid": "vm-seed", "fingerprint": installer.fingerprint(spec), "hostname": spec["hostname"], "sourceBootId": facts["bootId"]}
        files = installer.render_files(spec, facts, public_key, receipt)
        for name in ("ssh_host_ed25519_key", "ssh_host_ed25519_key.pub"):
            files["nebula/hostkeys/" + name] = (root / name).read_bytes()
        (root / "seeded-initrd").write_bytes((artifacts / "initrd.gz").read_bytes() + gzip.compress(installer.cpio(files), mtime=0))
        subprocess.run(["qemu-img", "create", "-f", "qcow2", str(root / "disk.qcow2"), "32G"], check=True, stdout=subprocess.DEVNULL)
        base = ["qemu-system-x86_64", "-accel", "tcg", "-cpu", "max", "-smp", "2", "-m", "3072",
                "-drive", f"file={root}/disk.qcow2,format=qcow2,if=none,id=disk0",
                "-device", "virtio-blk-pci,drive=disk0,serial=nebula-test",
                "-netdev", f"user,id=net0,net=192.0.2.0/24,host=192.0.2.2,dns=192.0.2.3,dhcpstart=192.0.2.15,ipv6=off,hostfwd=tcp:127.0.0.1:{port}-:22",
                "-device", "virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56", "-display", "none", "-monitor", "none"]
        first = subprocess.Popen(base + ["-serial", f"file:{root}/first-install.log", "-no-reboot", "-kernel", str(artifacts / "linux"),
                                        "-initrd", str(root / "seeded-initrd"), "-append", "auto=true priority=critical --- console=ttyS0,115200n8"])
        try:
            print("Booting unattended installer on a new disposable disk", flush=True)
            first.wait(timeout=1200)
            if first.returncode != 0:
                raise RuntimeError("initial VM installation failed")
        finally:
            if first.poll() is None:
                first.terminate()
                first.wait(timeout=30)
        host_key = " ".join((root / "ssh_host_ed25519_key.pub").read_text().split()[:2])
        (root / "known_hosts").write_text(spec["hostname"] + " " + host_key + "\n")
        ssh = ["ssh", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes",
               "-o", "HostKeyAlias=" + spec["hostname"], "-o", "UserKnownHostsFile=" + str(root / "known_hosts"),
               "-o", "GlobalKnownHostsFile=/dev/null", "-i", str(root / "worker-key"), "-p", str(port), "root@127.0.0.1"]
        here = Path(__file__).resolve().parents[1] / "src/modules/infra/k0s/baremetal"
        agent = "\n".join((here / name).read_text() for name in ("installer.py", "uefi.py", "host.py"))

        def call(action, uid, **extra):
            result = subprocess.run(ssh + [shlex.join(["python3", "-c", agent, action])], text=True, capture_output=True, timeout=900,
                                    input=installer.canonical({"uid": uid, "spec": spec, **extra}))
            if result.returncode:
                raise RuntimeError("VM agent failed: " + (result.stdout + result.stderr)[-1000:])
            return json.loads(result.stdout)

        def wait_verified(uid):
            deadline = time.monotonic() + 1200
            last_error = "no response"
            while time.monotonic() < deadline:
                try:
                    result = call("verify", uid)
                    if result.get("verified"):
                        return result
                except RuntimeError as error:
                    last_error = str(error)
                time.sleep(10)
            raise RuntimeError("VM did not return with the expected installed receipt: " + last_error)

        second = subprocess.Popen(base + ["-serial", f"file:{root}/ssh-reinstall.log"])
        try:
            wait_verified("vm-seed")
            print("Initial OS, SSH identity, static networking and LVM verified", flush=True)
            # This disk was created above exclusively for this test. Convert the
            # initial fixture into an unused source OS for the real SSH install.
            subprocess.run(ssh + ["rm /var/lib/nebula-baremetal/installed.json"], check=True, capture_output=True)
            discovered = call("probe", "vm-ssh-reinstall")
            call("stage", "vm-ssh-reinstall", facts=discovered, workerPublicKey=public_key)
            print("Actual SSH staging and kexec load passed", flush=True)
            call("commit", "vm-ssh-reinstall")
            result = wait_verified("vm-ssh-reinstall")
            print("SSH-only OS reinstall verified:", result, flush=True)
        finally:
            second.terminate()
            second.wait(timeout=30)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--artifacts", required=True, type=Path)
    run_test(parser.parse_args().artifacts)
