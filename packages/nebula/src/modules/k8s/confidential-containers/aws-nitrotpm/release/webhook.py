"""Pinned upstream admission with automatic image-pull handler selection."""
import argparse
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from image_sources import CAA_REVISION

PATCH = "webhook-runtime-handler.patch"


def prepare(source, work):
    # Keep the appliance's unmodified CAA checkout separate from this reviewed
    # admission-only patch. Neither guest image contains the webhook.
    path = work / "caa-webhook"
    if not path.exists():
        subprocess.run(["git", "init", str(path)], check=True)
        subprocess.run(["git", "-C", str(path), "fetch", "--depth=1",
                        "https://github.com/confidential-containers/cloud-api-adaptor.git", CAA_REVISION], check=True)
        subprocess.run(["git", "-C", str(path), "checkout", "--detach", CAA_REVISION], check=True)
    verify_and_patch(path, source / "release/patches" / PATCH)
    return path


def verify_and_patch(path, patch):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(path), *args])
    if git("rev-parse", "HEAD").decode().strip() != CAA_REVISION:
        raise ValueError("webhook source revision mismatch")
    if git("diff", "--cached") or git("ls-files", "--others", "--exclude-standard"):
        raise ValueError("unexpected webhook source changes")
    expected = patch.read_bytes()
    changed = git("diff", "--binary", "--full-index", "--no-ext-diff")
    if not changed:
        subprocess.run(["git", "-C", str(path), "apply", "--check", str(patch)], check=True)
        subprocess.run(["git", "-C", str(path), "apply", str(patch)], check=True)
        changed = git("diff", "--binary", "--full-index", "--no-ext-diff")
    if changed != expected:
        raise ValueError("webhook source must contain exactly the reviewed runtime-handler patch")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    print(prepare(args.source.resolve(), args.work.resolve()))
