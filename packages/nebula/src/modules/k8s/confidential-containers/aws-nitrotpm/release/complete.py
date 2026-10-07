"""Assemble catalog only from built artifact receipts, never placeholder pins."""
import argparse
import hashlib
import json
from pathlib import Path
import re

from build import json_file, require, sha

CAA = "quay.io/confidential-containers/cloud-api-adaptor@sha256:0eaa02a8fad19a2bf1b27745fb8d0ca28edc68da1f8c5c886b87444f188170ef"
CLEANUP = "quay.io/confidential-containers/peerpod-ctrl@sha256:034398d3d7b065b840e470979b935429f0e70272b2c0a1d3f159dfb870de1362"


def complete(directory, repository, tag, controller):
    require(re.fullmatch(r"[a-zA-Z0-9_-]+/[a-zA-Z0-9_.-]+", repository), "invalid release repository")
    require(re.fullmatch(r"[a-zA-Z0-9_.-]+", tag), "invalid release tag")
    require(re.fullmatch(r"ghcr\.io/[a-z0-9/_.-]+@sha256:[a-f0-9]{64}", controller), "published controller digest required")
    core = json.loads((directory / "core.json").read_text())
    base = f"https://github.com/{repository}/releases/download/{tag}/"
    for role in ("authority", "runtime"):
        artifact = core[role]["artifact"]
        path = directory / f"{role}.raw.gz"
        require(path.stat().st_size == artifact["compressedSize"] and sha(path) == artifact["sha256"] and
                artifact["url"] == base + path.name, "appliance artifact receipt changed")
    core.update({"controllerImage": controller, "caaImage": CAA, "cleanupImage": CLEANUP, "clients": {}})
    for platform in ("linux-x64", "darwin-arm64", "darwin-x64"):
        path = directory / ("aws-coco-client-" + platform)
        require(path.is_file() and 0 < path.stat().st_size < 128 * 1024**2, "missing bounded publisher client")
        core["clients"][platform] = {"url": base + path.name, "size": path.stat().st_size, "sha256": sha(path)}
    json_file(directory / "catalog.candidate.json", core)
    # Qualification promotes this exact file into the Nebula package. A CI
    # build alone never claims a hardware qualification or approves live PCRs.
    return core


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--controller", required=True)
    args = parser.parse_args()
    complete(args.directory, args.repository, args.tag, args.controller)
