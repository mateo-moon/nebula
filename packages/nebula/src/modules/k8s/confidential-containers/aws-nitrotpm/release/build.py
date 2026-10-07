"""Maintainer release pipeline, executed in builder.Dockerfile. Never a user step.

Builds generic public appliances and derives measurements from their UKIs. No
running instance may contribute an approved PCR or a workload key to this build.
"""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from image_sources import BASE_REVISION, CAA_REVISION
from stage import stage, require

KATA = "c7351e797efff8bfc6bd73da0eb1909be12e2cfe"
GUEST_COMPONENTS = "17ad60d88f9b7e4b3b54d01200985ae72723e8ab"
RELEASEVER = "2023.12.20260930"


def run(*args, cwd=None, env=None, output=None):
    subprocess.run([str(arg) for arg in args], cwd=cwd, env={**os.environ, **(env or {})}, check=True, stdout=output)


def checkout(work, name, url, revision):
    path = work / name
    if not path.exists():
        run("git", "init", path)
        run("git", "-C", path, "remote", "add", "origin", url)
        run("git", "-C", path, "fetch", "--depth=1", "origin", revision)
        run("git", "-C", path, "checkout", "--detach", revision)
    require(subprocess.check_output(["git", "-C", str(path), "rev-parse", "HEAD"], text=True).strip() == revision, "source revision changed")
    return path


def sha(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        while chunk := source.read(1024 * 1024): result.update(chunk)
    return result.hexdigest()


def json_file(path, value):
    path.write_text(json.dumps(value, separators=(",", ":")) + "\n")


def uki_measurements(measured):
    require(measured.get("HashAlgorithm") == "SHA384", "SHA384 build measurements required")
    result = {}
    for field in ("PCR4", "PCR12"):
        value = measured.get(field)
        require(isinstance(value, str) and len(value) == 96 and
                all(c in "0123456789abcdefABCDEF" for c in value), "invalid UKI measurement")
        result[field.lower()] = value.lower()
    # The Nitro tool emits reset PCR12 for a UKI without external parameters.
    # A reset boot-image PCR4 is never an image identity. Runtime verification
    # still compares both full values, including the expected reset PCR12.
    require(result["pcr4"] != "0" * 96, "missing UKI boot measurement")
    return result


def binaries(source, work):
    work.mkdir(parents=True, exist_ok=True)
    out = work / "binaries"; out.mkdir(exist_ok=True)
    target = work / "target"
    env = {"CARGO_TARGET_DIR": str(target), "CARGO_BUILD_JOBS": os.environ.get("CARGO_BUILD_JOBS", "4"), "RUSTUP_TOOLCHAIN": "1.98.1"}
    kata = checkout(work, "kata", "https://github.com/kata-containers/kata-containers.git", KATA)
    components = checkout(work, "guest-components", "https://github.com/confidential-containers/guest-components.git", GUEST_COMPONENTS)
    caa = checkout(work, "caa", "https://github.com/confidential-containers/cloud-api-adaptor.git", CAA_REVISION)
    revisions = {}
    def copy(name, path, revision):
        shutil.copy2(path, out / name)
        revisions[name] = {"path": str(out / name), "sha256": sha(out / name), "revision": revision}
    guest = source / "guest"
    run("cargo", "build", "--locked", "--release", "--manifest-path", guest / "Cargo.toml", "--bin", "aws-trustee-bootstrap", env=env)
    revision = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    if subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=all"], text=True).strip(): revision += "-dirty"
    copy("aws-trustee-bootstrap", target / "release/aws-trustee-bootstrap", revision)
    # Generate upstream version files without changing any policy/security code.
    run("make", "src/version.rs", "LIBC=gnu", "AGENT_POLICY=yes", "INIT_DATA=no", cwd=kata / "src/agent", env=env)
    run("cargo", "build", "--locked", "--release", "--manifest-path", kata / "src/agent/Cargo.toml",
        "--no-default-features", "--features", "agent-policy,seccomp", env=env)
    copy("kata-agent", target / "release/kata-agent", KATA)
    run("cargo", "build", "--locked", "--release", "--manifest-path", components / "confidential-data-hub/hub/Cargo.toml",
        "--no-default-features", "--features", "bin,ttrpc", "--bin", "ttrpc-cdh", env=env)
    copy("confidential-data-hub", target / "release/ttrpc-cdh", GUEST_COMPONENTS)
    run("go", "build", "-trimpath", "-buildvcs=true", "-o", out / "agent-protocol-forwarder", "./cmd/agent-protocol-forwarder",
        cwd=caa / "src/cloud-api-adaptor", env={"GOOS": "linux", "GOARCH": "amd64", "CGO_ENABLED": "0", "GOTOOLCHAIN": "local"})
    revisions["agent-protocol-forwarder"] = {"path": str(out / "agent-protocol-forwarder"), "sha256": sha(out / "agent-protocol-forwarder"), "revision": CAA_REVISION}
    run("make", "src/version.rs", cwd=kata / "src/tools/genpolicy", env=env)
    run("cargo", "build", "--locked", "--release", "--manifest-path", kata / "src/tools/genpolicy/Cargo.toml", env=env)
    shutil.copy2(target / "release/genpolicy", out / "genpolicy")
    run("cargo", "build", "--locked", "--release", "--manifest-path", components / "attestation-agent/coco_keyprovider/Cargo.toml", env=env)
    shutil.copy2(target / "release/coco_keyprovider", out / "coco_keyprovider")
    json_file(work / "binaries.json", revisions)


def images(source, work, canary, repository, tag, policy):
    require(repository.count("/") == 1 and all(c.isalnum() or c in "-_/" for c in repository), "invalid release repository")
    require(tag and all(c.isalnum() or c in "-_." for c in tag), "invalid immutable release tag")
    require(set(policy) == {"bootloader", "tee", "snp", "microcode"} and all(isinstance(v, int) and 0 <= v <= 255 for v in policy.values())
            and policy["bootloader"] >= 3 and policy["microcode"] >= 169 and policy["snp"] >= 27,
            "reviewed Milan firmware floor required")
    policy = {name: policy[name] for name in ("bootloader", "tee", "snp", "microcode")}
    base = checkout(work, "kiwi", "https://github.com/amazonlinux/kiwi-image-descriptions-examples.git", BASE_REVISION)
    caa = checkout(work, "caa", "https://github.com/confidential-containers/cloud-api-adaptor.git", CAA_REVISION)
    inputs = json.loads((work / "binaries.json").read_text())
    require(not inputs["aws-trustee-bootstrap"]["revision"].endswith("-dirty"), "release builds require committed source")
    out = work / "release"; out.mkdir(exist_ok=True)
    result = {"version": 1}
    for role in ("authority", "runtime"):
        description, build = work / (role + "-description"), work / (role + "-image")
        require(not description.exists() and not build.exists(), "fresh image build directories required")
        stage(base, caa, inputs if role == "runtime" else {"aws-trustee-bootstrap": inputs["aws-trustee-bootstrap"]},
            source / "trust/amd-milan-asvk.pem", canary, RELEASEVER, role, description)
        run("kiwi-ng", "system", "build", "--description", description, "--target-dir", build)
        disks = list(build.glob("*.raw")); require(len(disks) == 1, "one appliance disk required")
        disk = disks[0]
        measured = json.loads((build / "pcr_measurements.json").read_text())["Measurements"]
        profile = {"minimumTcb": policy, **uki_measurements(measured), "role": role, "version": 1}
        release = hashlib.sha256(json.dumps(profile, separators=(",", ":")).encode()).hexdigest()
        profile.pop("version"); profile["release"] = release
        target = out / f"{role}.raw.gz"
        with disk.open("rb") as raw, target.open("wb") as destination:
            with gzip.GzipFile(filename="", mode="wb", fileobj=destination, mtime=0) as compressed: shutil.copyfileobj(raw, compressed, 1024 * 1024)
        result[role] = {"profile": profile, "artifact": {"url": f"https://github.com/{repository}/releases/download/{tag}/{target.name}",
            "sha256": sha(target), "compressedSize": target.stat().st_size, "rawSha256": sha(disk), "rawSize": disk.stat().st_size}}
    result["id"] = hashlib.sha256((result["authority"]["profile"]["release"] + "\n" + result["runtime"]["profile"]["release"] + "\n").encode()).hexdigest()
    json_file(out / "core.json", result)
    shutil.copy2(work / "binaries/aws-trustee-bootstrap", out / "aws-coco-client-linux-x64")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["binaries", "images"])
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--canary", type=Path)
    parser.add_argument("--repository")
    parser.add_argument("--tag")
    parser.add_argument("--firmware-policy", type=Path)
    args = parser.parse_args()
    if args.command == "binaries": binaries(args.source, args.work.resolve())
    else:
        require(args.canary and args.repository and args.tag and args.firmware_policy, "complete release inputs required")
        images(args.source, args.work.resolve(), args.canary, args.repository, args.tag, json.loads(args.firmware_policy.read_text()))


if __name__ == "__main__": main()
