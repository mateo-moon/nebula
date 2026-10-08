"""Executed as root over SSH, never imported for side effects.

The controller prepends installer.py when sending this agent to the host. The
staging directory and installed receipt bind an operation to one request UID.
"""
import gzip
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys


def command(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def json_command(args):
    return json.loads(command(args))


def walk_disks(items):
    for item in items:
        yield item
        yield from walk_disks(item.get("children", []))


def probe(spec):
    marker = Path("/var/lib/nebula-baremetal/installed.json")
    if marker.exists():
        return {"installed": json.loads(marker.read_text())}
    if Path("/var/lib/k0s").exists() or Path("/etc/kubernetes/kubelet.conf").exists():
        raise ValueError("existing Kubernetes installation: refusing fresh OS installation")
    if platform.machine() != "x86_64" or not Path("/run/systemd/system").is_dir():
        raise ValueError("source host must be x86_64 Linux running systemd")
    disabled = Path("/proc/sys/kernel/kexec_load_disabled")
    if disabled.exists() and disabled.read_text().strip() != "0":
        raise ValueError("source kernel disables kexec")
    mem_kb = int(next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines() if line.startswith("MemAvailable:")))
    if mem_kb < 1024 * 1024:
        raise ValueError("at least 1 GiB available RAM is required for installer staging")
    root = command(["findmnt", "-n", "-o", "SOURCE", "/"])
    roots = list(walk_disks(json_command(["lsblk", "-s", "-p", "-J", "-o", "NAME,PATH,TYPE", root])["blockdevices"]))
    disks = json_command(["lsblk", "-b", "-d", "-p", "-J", "-o", "NAME,PATH,SIZE,TYPE,RO,RM,SERIAL"])["blockdevices"]
    disk = select_disk(disks, {d["path"] for d in roots if d["type"] == "disk"}, spec["installation"]["disk"])
    # Do not let partman dismantle an array spanning disks outside this request.
    if any(d["type"].startswith("raid") or d["type"] in ("crypt", "mpath") for d in roots):
        raise ValueError("RAID, encrypted and multipath source roots require a separately qualified disk profile")
    if not shutil.which("pvs"):
        raise ValueError("source requires pvs for safe disk discovery")
    if shutil.which("pvs"):
        groups = {}
        for pv in json_command(["pvs", "--readonly", "--reportformat", "json", "-o", "pv_name,vg_name"])["report"][0]["pv"]:
            name = pv["vg_name"].strip()
            if name:
                ancestors = walk_disks(json_command(["lsblk", "-s", "-p", "-J", "-o", "NAME,PATH,TYPE", pv["pv_name"].strip()])["blockdevices"])
                groups.setdefault(name, set()).update(d["path"] for d in ancestors if d["type"] == "disk")
        validate_volume_groups(disk["path"], groups, spec["installation"]["volumeGroup"])
    ids = sorted(p for p in Path("/dev/disk/by-id").iterdir() if str(p.resolve()) == disk["path"] and "-part" not in p.name)
    if not ids:
        raise ValueError("selected disk needs a stable /dev/disk/by-id identity")
    disk["byId"] = str(ids[0])
    defaults = json_command(["ip", "-j", "-4", "route", "show", "default"])
    if len(defaults) != 1 or not defaults[0].get("gateway"):
        raise ValueError("source needs one IPv4 uplink with a gateway")
    iface = defaults[0]["dev"]
    info = json_command(["ip", "-d", "-j", "address", "show", "dev", iface])[0]
    if info.get("linkinfo", {}).get("info_kind") in ("bond", "bridge", "vlan", "vrf"):
        raise ValueError("bond/VLAN/bridge/VRF uplinks need a separately qualified network profile")
    addresses = [str(ipaddress.ip_interface(f"{a['local']}/{a['prefixlen']}")) for a in info["addr_info"]
                 if a.get("scope") == "global" and not a.get("tentative") and not a.get("temporary") and not a.get("deprecated")]
    if not any(ipaddress.ip_interface(a).version == 4 for a in addresses):
        raise ValueError("uplink has no usable IPv4 address")
    routes = [{"destination": "0.0.0.0/0", "gateway": defaults[0]["gateway"]}]
    v6 = json_command(["ip", "-j", "-6", "route", "show", "default", "dev", iface])
    if v6:
        if len(v6) != 1 or not v6[0].get("gateway"):
            raise ValueError("ambiguous IPv6 default route")
        routes.append({"destination": "::/0", "gateway": v6[0]["gateway"]})
    if spec["installation"].get("dualStack", True) and (not v6 or not any(ipaddress.ip_interface(a).version == 6 for a in addresses)):
        raise ValueError("dual-stack profile requires global IPv6 and an IPv6 gateway")
    resolvers = spec["installation"].get("dnsServers") or [line.split()[1] for line in Path("/etc/resolv.conf").read_text().splitlines() if line.startswith("nameserver ")]
    resolvers = [r for r in resolvers if not ipaddress.ip_address(r).is_loopback and not ipaddress.ip_address(r).is_link_local]
    if not resolvers and shutil.which("resolvectl"):
        resolvers = command(["resolvectl", "dns", iface]).split(": ", 1)[-1].split()
    if not resolvers or any(ipaddress.ip_address(r).is_loopback for r in resolvers):
        raise ValueError("configure reachable DNS servers in the installation profile")
    return {"disk": disk, "network": {"mac": info["address"], "addresses": addresses, "routes": routes, "dns": resolvers},
            "uefi": Path("/sys/firmware/efi").exists(), "bootId": Path("/proc/sys/kernel/random/boot_id").read_text().strip(),
            "machineId": Path("/etc/machine-id").read_text().strip()}


def fetch_artifact(artifact, destination):
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest() == artifact["sha256"]:
        return
    temporary = destination.with_suffix(".download")
    command(["curl", "--fail", "--silent", "--show-error", "--location", "--proto", "=https", "--proto-redir", "=https",
             "--connect-timeout", "30", "--max-time", "300", "--max-filesize", str(512 * 1024**2),
             "--retry", "3", "--retry-delay", "2", "--output", str(temporary), artifact["url"]])
    if temporary.stat().st_size > 512 * 1024**2:
        temporary.unlink()
        raise ValueError("installer artifact exceeds 512 MiB staging limit")
    if hashlib.sha256(temporary.read_bytes()).hexdigest() != artifact["sha256"]:
        temporary.unlink()
        raise ValueError("installer artifact checksum mismatch")
    temporary.replace(destination)


def stage(payload):
    spec, expected = payload["spec"], payload["facts"]
    current = probe(spec)
    if current != expected:
        raise ValueError("host identity, disks or network changed after discovery")
    receipt = {"uid": payload["uid"], "fingerprint": fingerprint(spec), "hostname": spec["hostname"], "sourceBootId": current["bootId"]}
    # Fence aliases of the same host, including requests in other namespaces.
    claim = Path("/var/lib/nebula-baremetal/claim.json")
    claim.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        with claim.open("x") as output:
            output.write(canonical(receipt))
    except FileExistsError:
        if json.loads(claim.read_text()) != receipt:
            raise ValueError("host is already bound to another provisioning operation")
    files = render_files(spec, current, payload["workerPublicKey"], receipt)
    hostkeys = list(Path("/etc/ssh").glob("ssh_host_*_key*"))
    if not hostkeys:
        raise ValueError("source host has no persistent SSH host keys")
    for key in hostkeys:
        files["nebula/hostkeys/" + key.name] = key.read_bytes()
    if not shutil.which("kexec") or not shutil.which("curl"):
        if shutil.which("apt-get"):
            command(["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "update"])
            command(["env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y", "kexec-tools", "curl", "ca-certificates"])
        elif shutil.which("dnf"):
            command(["dnf", "install", "-y", "kexec-tools", "curl", "ca-certificates"])
        else:
            raise ValueError("source needs kexec-tools and curl, or apt/dnf to install them")
    directory = Path("/run/nebula-baremetal") / payload["uid"]
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(directory, 0o700)
    for kind in ("kernel", "initrd"):
        fetch_artifact(spec["installation"][kind], directory / kind)
    (directory / "seeded-initrd").write_bytes((directory / "initrd").read_bytes() + gzip.compress(cpio(files), mtime=0))
    # Loading proves kernel support/lockdown compatibility before committing a
    # reboot. The existing disk and bootloader remain untouched at this point.
    command(["kexec", "-l", str(directory / "kernel"), "--initrd=" + str(directory / "seeded-initrd"),
             "--append=auto=true priority=critical net.ifnames=1"])
    (directory / "receipt.json").write_text(canonical(receipt))
    return receipt


def commit(payload):
    spec = payload["spec"]
    directory = Path("/run/nebula-baremetal") / payload["uid"]
    receipt = json.loads((directory / "receipt.json").read_text())
    if receipt["fingerprint"] != fingerprint(spec) or receipt["sourceBootId"] != command(["cat", "/proc/sys/kernel/random/boot_id"]):
        raise ValueError("staged installer does not match this host boot and profile")
    unit = "nebula-install-" + payload["uid"]
    if subprocess.run(["systemctl", "is-active", "--quiet", unit + ".timer"]).returncode != 0:
        # The same transient timer name makes a retry safe before SSH disappears.
        command(["systemd-run", "--unit=" + unit, "--on-active=5s", "/bin/sh", "-c", "sync; exec " + shlex.quote(shutil.which("kexec")) + " -e"])
    return {"committed": True}


def verify(payload):
    spec = payload["spec"]
    receipt = json.loads(Path("/var/lib/nebula-baremetal/installed.json").read_text())
    if receipt["uid"] != payload["uid"] or receipt["fingerprint"] != fingerprint(spec):
        raise ValueError("installed OS belongs to another request or profile")
    if platform.node() != spec["hostname"] or receipt["sourceBootId"] == command(["cat", "/proc/sys/kernel/random/boot_id"]):
        raise ValueError("installed host identity or reboot verification failed")
    os_release = dict(line.split("=", 1) for line in Path("/etc/os-release").read_text().splitlines() if "=" in line)
    if os_release.get("ID", "").strip('"') != "debian" or os_release.get("VERSION_CODENAME", "").strip('"') != spec["installation"]["suite"]:
        raise ValueError("installed OS does not match the requested suite")
    vg = spec["installation"]["volumeGroup"]
    free_bytes = float(command(["vgs", "--noheadings", "--units", "b", "--nosuffix", "-o", "vg_free", vg]))
    root_bytes = float(command(["lvs", "--noheadings", "--units", "b", "--nosuffix", "-o", "lv_size", vg + "/root"]))
    requested = spec["installation"]["rootSizeGiB"] * 1024**3
    if free_bytes < 1024**3 or abs(root_bytes - requested) > 8 * 1024**2:
        raise ValueError("installed root allocation or free worker storage does not match the profile")
    command(["systemctl", "is-active", "ssh"])
    addresses = json_command(["ip", "-j", "address"])
    usable = [a for interface in addresses for a in interface.get("addr_info", []) if a.get("scope") == "global" and not a.get("tentative") and not a.get("deprecated")]
    if not any(a["family"] == "inet" for a in usable) or (spec["installation"].get("dualStack", True) and not any(a["family"] == "inet6" for a in usable)):
        raise ValueError("installed host lacks the requested node address families")
    return {"verified": True, "addresses": [a["local"] for a in usable]}


def agent_main():
    os.umask(0o077)
    if os.geteuid() != 0:
        raise ValueError("root or passwordless sudo is required")
    payload = json.load(sys.stdin)
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,64}", payload["uid"]):
        raise ValueError("invalid request UID")
    validate_spec(payload["spec"])
    action = sys.argv[1]
    result = probe(payload["spec"]) if action == "probe" else {"stage": stage, "commit": commit, "verify": verify}[action](payload)
    print(canonical(result))


if __name__ == "__main__":
    try:
        agent_main()
    except (ValueError, KeyError, OSError, subprocess.SubprocessError, StopIteration) as error:
        # Do not print command stdout, SSH keys, payloads or a traceback.
        print(canonical({"error": str(error) if isinstance(error, ValueError) else "host operation failed: " + type(error).__name__}))
        sys.exit(1)
