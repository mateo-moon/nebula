"""Build input for Nitro attestation with a protected TPM owner hierarchy."""
import argparse
import subprocess
from pathlib import Path

NITRO_REVISION = "441fe310cce206efc79d88287fa2ee00355f5ce3"
PATCH = "nitro-owner-auth.patch"
LICENSES = ("LICENSE", "NOTICE", "LICENSES/APACHEv2-LICENSE",
            "LICENSES/MIT0-LICENSE", "LICENSES/THIRD_PARTY_LICENSES_RUST_CRATES.html")


def prepare(source, work):
    path = work / "nitro-tpm-tools"
    if not path.exists():
        subprocess.run(["git", "init", str(path)], check=True)
        subprocess.run(["git", "-C", str(path), "fetch", "--depth=1",
                        "https://github.com/aws/NitroTPM-Tools.git", NITRO_REVISION], check=True)
        subprocess.run(["git", "-C", str(path), "checkout", "--detach", NITRO_REVISION], check=True)
    verify_and_patch(path, source / "release/patches" / PATCH)
    return path


def verify_and_patch(path, patch):
    def git(*args):
        return subprocess.check_output(["git", "-C", str(path), *args])
    if git("rev-parse", "HEAD").decode().strip() != NITRO_REVISION:
        raise ValueError("Nitro source revision mismatch")
    if git("diff", "--cached") or git("ls-files", "--others", "--exclude-standard"):
        raise ValueError("unexpected Nitro source changes")
    expected = patch.read_bytes()
    changed = git("diff", "--binary", "--full-index", "--no-ext-diff")
    if not changed:
        subprocess.run(["git", "-C", str(path), "apply", "--check", str(patch)], check=True)
        subprocess.run(["git", "-C", str(path), "apply", str(patch)], check=True)
        changed = git("diff", "--binary", "--full-index", "--no-ext-diff")
    if changed != expected:
        raise ValueError("Nitro source must contain exactly the reviewed owner-auth patch")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--work", type=Path, required=True)
    args = parser.parse_args()
    print(prepare(args.source.resolve(), args.work.resolve()))
