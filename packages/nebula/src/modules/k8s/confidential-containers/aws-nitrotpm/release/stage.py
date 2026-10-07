"""Software-release build step for generic appliances; never run by module users."""
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from image_sources import BASE_REVISION, CAA_REVISION, BASE_DESCRIPTION, MASKS


def require(ok, message):
    if not ok:
        raise ValueError(message)


def clean_revision(path, revision):
    require(subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip() == revision, "source revision mismatch")
    require(not subprocess.check_output(["git", "-C", str(path), "status", "--porcelain", "--untracked-files=all"], text=True), "source checkout is not clean")


def put(root, path, content):
    destination = root / path
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(content)


def stage(base, caa, binaries, asvk, canary, releasever, role, output):
    require(role in ("authority", "runtime"), "unknown image role")
    require(not output.exists(), "fresh build description required")
    require(releasever.startswith("2023.") and all(c.isdigit() or c == "." for c in releasever), "immutable AL2023 repository version required")
    clean_revision(base, BASE_REVISION)
    clean_revision(caa, CAA_REVISION)
    names = {"aws-trustee-bootstrap"} | ({"kata-agent", "confidential-data-hub", "agent-protocol-forwarder"} if role == "runtime" else set())
    require(set(binaries) == names, "unexpected appliance binary set")
    shutil.copytree(base / BASE_DESCRIPTION, output)
    root = output / "root"
    overlay = Path(__file__).resolve().parents[1] / "image/root"
    for relative in ("etc/systemd/journald.conf.d/90-no-disk.conf", "etc/systemd/coredump.conf.d/90-no-dump.conf"):
        destination = root / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(overlay / relative, destination)
    units = root / "etc/systemd/system"
    units.mkdir(parents=True, exist_ok=True)
    for name in MASKS + ["systemd-random-seed.service", "kdump.service", "systemd-suspend.service", "systemd-hybrid-sleep.service"]:
        path = units / name
        path.unlink(missing_ok=True)
        path.symlink_to("/dev/null")
    provenance = {}
    for name, item in binaries.items():
        data = Path(item["path"]).read_bytes()
        require(data[:4] == b"\x7fELF" and hashlib.sha256(data).hexdigest() == item["sha256"], "unverified guest binary")
        target = root / "usr/local/bin" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data); target.chmod(0o755)
        provenance[name] = {"sha256": item["sha256"], "revision": item["revision"]}
    trust = Path(__file__).resolve().parents[1] / "trust/amd-milan-ark.pem"
    subprocess.run(["openssl", "verify", "-CAfile", str(trust), str(asvk)], check=True, stdout=subprocess.DEVNULL)
    (root / "usr/share/nebula").mkdir(parents=True, exist_ok=True)
    shutil.copyfile(asvk, root / "usr/share/nebula/amd-milan-asvk.pem")
    canary_bytes = canary.read_bytes()
    require(len(canary_bytes) <= 256 * 1024 and set(json.loads(canary_bytes)) == {"image", "policy"}, "released canary definition required")
    (root / "usr/share/nebula/canary.json").write_bytes(canary_bytes)
    put(root, "usr/share/nebula/appliance.json", json.dumps({"version": 1, "role": role, "baseRevision": BASE_REVISION,
        "caaRevision": CAA_REVISION, "al2023Release": releasever, "binaries": provenance}, sort_keys=True) + "\n")
    put(root, "etc/modules-load.d/nebula.conf", "sev-guest\n")
    put(root, "etc/sysctl.d/90-nebula.conf", "kernel.kptr_restrict=2\nkernel.dmesg_restrict=1\nkernel.yama.ptrace_scope=3\nfs.suid_dumpable=0\n")
    memories = {"evidence": "4M", "secrets": "2M", "workload": "4M", "authority-tpm": "16M"}
    for name, size in memories.items():
        put(root, f"etc/systemd/system/run-nebula-{name.replace('-', chr(92) + 'x2d')}.mount",
            f"[Unit]\nDescription=Nebula protected volatile {name}\n\n[Mount]\nWhat=tmpfs\nWhere=/run/nebula/{name}\nType=tmpfs\nOptions=mode=0700,size={size},nosuid,nodev,noexec\n")
    tree = ET.parse(output / "appliance.kiwi")
    tree.getroot().set("name", "nebula-coco-" + role)
    image = tree.find("./preferences/type")
    # dm-verity makes the complete ext4 root read-only. A writable overlay over
    # executable/configuration paths would defeat require_readonly_file().
    image.set("filesystem", "ext4")
    for key in list(image.attrib):
        if key.startswith("overlayroot"): del image.attrib[key]
    image.set("kernelcmdline", "ro rd.shell=0 systemd.getty_auto=false rd.kiwi.verity_options=panic-on-corruption")
    tree.find("./repository/source").set("path", f"https://cdn.amazonlinux.com/al2023/core/mirrors/{releasever}/$basearch/mirror.list")
    packages = tree.find('./packages[@type="image"]')
    for item in packages.findall("namedCollection"):
        if item.get("name") == "ami-minimal": item.set("name", "ami-minimal-kernel6.12")
    for item in list(packages):
        if item.get("name") in {"zram-generator", "zram-generator-defaults", "dracut-kiwi-overlay", "awscli"}: packages.remove(item)
    present = {item.get("name") for item in packages}
    for package in ["tpm2-tools", "e2fsprogs", "util-linux", "openssl-libs", "libseccomp", "ca-certificates", "iproute", "iptables-nft", "net-tools"]:
        if package not in present: ET.SubElement(packages, "package", {"name": package})
    tree.write(output / "appliance.kiwi", encoding="utf8", xml_declaration=True)
    wants = units / "multi-user.target.wants"
    wants.mkdir(parents=True, exist_ok=True)
    put(root, "etc/systemd/system/var.mount", "[Unit]\nBefore=local-fs.target\n\n[Mount]\nWhat=tmpfs\nWhere=/var\nType=tmpfs\nOptions=mode=0755,nosuid,nodev,size=512M\n")
    local_wants = units / "local-fs.target.wants"
    local_wants.mkdir(parents=True, exist_ok=True)
    (local_wants / "var.mount").symlink_to("../var.mount")
    put(root, "etc/tmpfiles.d/nebula.conf", "d /var/lib/nebula 0700 root root -\nd /var/log 0755 root root -\n")
    put(root, "etc/kata-opa/default-policy.rego", "package agent_policy\ndefault AllowRequestsFailingPolicy = false\n")
    if role == "authority":
        (root / "var/lib/nebula").mkdir(parents=True, exist_ok=True)
        put(root, "etc/systemd/system/nebula-coco-authority.service", r'''[Unit]
Description=Attested Nebula authority and automatic replica recovery
RequiresMountsFor=/run/nebula/evidence /run/nebula/authority-tpm /var/lib/nebula
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
StateDirectory=nebula
StateDirectoryMode=0700
ExecStart=/usr/local/bin/aws-trustee-bootstrap --authority
Restart=always
RestartSec=10
# Refresh ephemeral channel certificates automatically, preserving TPM state.
RuntimeMaxSec=86400
UMask=0077
LimitCORE=0
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/nebula /run/nebula
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=null
StandardError=null
TimeoutStopSec=30
''')
        (wants / "nebula-coco-authority.service").symlink_to("../nebula-coco-authority.service")
    else:
        pause = canary.parent / "pause_bundle"
        require((pause / "rootfs/pause").read_bytes()[:4] == b"\x7fELF", "released sandbox bundle required")
        shutil.copytree(pause, root / "pause_bundle")
        caa_files = caa / "src/cloud-api-adaptor/podvm/files"
        for relative in ["etc/systemd/system/kata-agent.service", "etc/systemd/system/confidential-data-hub.service",
                         "etc/systemd/system/agent-protocol-forwarder.service", "etc/systemd/system/netns@.service", "etc/ocicrypt_config.json"]:
            target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(caa_files / relative, target)
        for relative in ["usr/lib/systemd/system/run-peerpod.mount", "usr/lib/systemd/system/aws-caa-transport.service",
                         "usr/lib/systemd/system/kata-agent.service.d/90-attested-keys.conf", "usr/lib/systemd/system/confidential-data-hub.service.d/90-attested-keys.conf",
                         "usr/lib/systemd/system/agent-protocol-forwarder.service.d/90-attested-keys.conf", "usr/share/nebula/cdh.toml"]:
            target = root / relative; target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(overlay / relative, target)
        put(root, "usr/share/nebula/agent.toml", (overlay / "usr/share/nebula/agent.toml").read_text().replace(
            "/usr/share/nebula/policy.rego", "/run/nebula/workload/policy.rego"))
        put(root, "etc/systemd/system/aws-trustee-bootstrap.service", '''[Unit]
Description=Verify owner approval, measure policy and fetch image keys
Requires=aws-caa-transport.service run-nebula-evidence.mount run-nebula-workload.mount run-nebula-secrets.mount
After=aws-caa-transport.service run-nebula-evidence.mount run-nebula-workload.mount run-nebula-secrets.mount network-online.target
Before=confidential-data-hub.service kata-agent.service agent-protocol-forwarder.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/aws-trustee-bootstrap --managed-runtime
RemainAfterExit=yes
UMask=0077
LimitCORE=0
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/run/nebula
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
StandardOutput=null
StandardError=null
TimeoutStartSec=1800
''')
        (wants / "agent-protocol-forwarder.service").symlink_to("../agent-protocol-forwarder.service")


def main():
    parser = argparse.ArgumentParser()
    for name in ("base", "caa", "binaries", "asvk", "canary", "output"): parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--releasever", required=True)
    parser.add_argument("--role", choices=["authority", "runtime"], required=True)
    args = parser.parse_args()
    stage(args.base, args.caa, json.loads(args.binaries.read_text()), args.asvk, args.canary, args.releasever, args.role, args.output)


if __name__ == "__main__": main()
