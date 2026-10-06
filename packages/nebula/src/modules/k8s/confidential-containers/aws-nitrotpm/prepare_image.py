"""Offline-only image description staging. Never uploads/imports/launches an AMI."""
import argparse
import hashlib
import json
import re
import shutil
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path
from verifier import require

BASE_REVISION = "4570f0ec8c9217f77c81ed79cb4200cbf9e40912"
CAA_REVISION = "e3e0f00480b41c08e3e4dbc6b64aba7722fb65f9"
BASE_DESCRIPTION = "kiwi-image-descriptions-examples/al2023/attestable-image-example"
BINARY_NAMES = {"aws-trustee-bootstrap", "kata-agent", "confidential-data-hub", "agent-protocol-forwarder"}
MASKS = ["sshd.service", "ssh.service", "amazon-ssm-agent.service", "cloud-init.service", "cloud-config.service",
         "cloud-final.service", "getty@.service", "serial-getty@.service", "debug-shell.service", "rescue.service",
         "emergency.service", "systemd-coredump@.service", "systemd-zram-setup@.service", "systemd-hibernate.service",
         "process-user-data.service", "process-user-data.path", "scratch-storage.service", "scratch-storage.path",
         "api-server-rest.service", "api-server-rest.path"]


def stage(base_repo, caa_repo, policy_path, config_path, ca_path, binaries, output):
    revision = subprocess.check_output(["git", "-C", str(base_repo), "rev-parse", "HEAD"], text=True).strip()
    require(revision == BASE_REVISION, "unreviewed KIWI base revision")
    status = subprocess.check_output(["git", "-C", str(base_repo), "status", "--porcelain", "--untracked-files=all"], text=True)
    require(status == "", "KIWI base must be clean")
    caa_revision = subprocess.check_output(["git", "-C", str(caa_repo), "rev-parse", "HEAD"], text=True).strip()
    require(caa_revision == CAA_REVISION, "unreviewed CAA service revision")
    caa_status = subprocess.check_output(["git", "-C", str(caa_repo), "status", "--porcelain", "--untracked-files=all"], text=True)
    require(caa_status == "", "CAA source must be clean")
    require(not output.exists(), "fresh output directory required")
    require(set(binaries) == BINARY_NAMES, "reviewed CoCo binary set required")
    config = json.loads(config_path.read_text())
    require(set(config) == {"workload", "verifier_url", "kbs_url", "resources"}, "fixed bootstrap config required")
    require(all(config[k].startswith("https://") for k in ["verifier_url", "kbs_url"]), "TLS endpoints required")
    policy = policy_path.read_bytes()
    text = policy.decode("utf-8")
    # These checks reject obvious mistakes; actual policy semantics/RPC tests are qualification gates.
    require(re.search(r"^package agent_policy\s*$", text, re.M), "generated Kata policy required")
    for rpc in ["ExecProcessRequest", "ReadStreamRequest", "WriteStreamRequest", "SetPolicyRequest", "GetDiagnosticDataRequest"]:
        require(re.search(rf"^default {rpc}\s*:?=\s*false\s*$", text, re.M), "mandatory policy denial missing")
        require(len(re.findall(rf"^{rpc}\b", text, re.M)) == 0, "mandatory RPC denial overridden")
    require(re.search(r"^default CreateContainerRequest\s*:?=\s*false\s*$", text, re.M), "default-deny workload policy required")
    for name, item in binaries.items():
        require(set(item) == {"path", "sha256", "revision"} and re.fullmatch(r"[a-f0-9]{40}", item["revision"]), "binary provenance required")
        content = Path(item["path"]).read_bytes()
        require(hashlib.sha256(content).hexdigest() == item["sha256"], "binary digest mismatch")
        require(content[:4] == b"\x7fELF", "Linux binary required")
    shutil.copytree(base_repo / BASE_DESCRIPTION, output)
    caa_files = caa_repo / "src/cloud-api-adaptor/podvm/files"
    # Copy only the stock service contracts needed by the fixed configuration.
    # No default policies, user-data provisioner, sample keys or disk scratch helpers.
    for relative in ["etc/systemd/system/kata-agent.service", "etc/systemd/system/confidential-data-hub.service",
                     "etc/systemd/system/agent-protocol-forwarder.service", "etc/systemd/system/netns@.service",
                     "etc/ocicrypt_config.json"]:
        target = output / "root" / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(caa_files / relative, target)
    overlay = Path(__file__).parent / "image/root"
    shutil.copytree(overlay, output / "root", dirs_exist_ok=True)
    assets = output / "root/usr/share/nebula"
    shutil.copyfile(policy_path, assets / "policy.rego")
    shutil.copyfile(config_path, assets / "bootstrap.json")
    shutil.copyfile(ca_path, assets / "tls-ca.crt")
    bindir = output / "root/usr/local/bin"
    bindir.mkdir(parents=True, exist_ok=True)
    for name, item in binaries.items():
        target = bindir / name
        shutil.copyfile(item["path"], target)
        target.chmod(0o755)
    units = output / "root/etc/systemd/system"
    units.mkdir(parents=True, exist_ok=True)
    for name in MASKS:
        (units / name).symlink_to("/dev/null")
    tree = ET.parse(output / "appliance.kiwi")
    kind = tree.find("./preferences/type")
    # Candidate only: final KIWI boot must be built and verified on Linux.
    kind.set("filesystem", "erofs")
    for key in list(kind.attrib):
        if key.startswith("overlayroot"):
            del kind.attrib[key]
    kind.set("kernelcmdline", "rd.shell=0 systemd.getty_auto=false rd.kiwi.verity_options=panic-on-corruption")
    packages = tree.find('./packages[@type="image"]')
    for item in list(packages):
        if item.attrib.get("name") in {"zram-generator", "zram-generator-defaults", "dracut-kiwi-overlay", "awscli"}:
            packages.remove(item)
    tree.write(output / "appliance.kiwi", encoding="utf-8", xml_declaration=True)
    preset = output / "root/usr/lib/systemd/system-preset/90-nebula.preset"
    preset.parent.mkdir(parents=True, exist_ok=True)
    preset.write_text("enable agent-protocol-forwarder.service\n")
    # A preset alone does not enable a unit in this KIWI base. Install the boot
    # dependency explicitly. APF pulls in transport, key bootstrap, mounts and
    # Kata; Kata pulls in CDH and the stock network namespace service.
    wants = units / "multi-user.target.wants"
    wants.mkdir(parents=True, exist_ok=True)
    (wants / "agent-protocol-forwarder.service").symlink_to("../agent-protocol-forwarder.service")
    manifest = {"base_revision": revision, "caa_revision": caa_revision, "policy_sha256": hashlib.sha256(policy).hexdigest(),
                "binaries": {name: {k: v for k, v in item.items() if k != "path"} for name, item in binaries.items()},
                "deployment_enabled": False, "reason": "CAA transport, storage, boot and SNP gates unqualified"}
    (assets / "build-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def main():
    parser = argparse.ArgumentParser()
    for name in ["base-repo", "caa-repo", "policy", "bootstrap-config", "tls-ca", "binaries", "output"]:
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    stage(args.base_repo, args.caa_repo, args.policy, args.bootstrap_config, args.tls_ca, json.loads(args.binaries.read_text()), args.output)


if __name__ == "__main__":
    main()
