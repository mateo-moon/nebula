"""Own a missing worker mount helper for the lifetime of the Kata installer.

Run as a Kubernetes native sidecar: start before Kata installation, stop after
Kata cleanup. Existing system helpers are used without changing their files.
No package manager, workload key, cloud credential or network access is needed.
"""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import tempfile
import threading


def read_regular(path, limit):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise ValueError("unsafe helper file")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("oversized helper file")
        return data


class Helper:
    def __init__(self, directory, source, owner, existing):
        self.directory, self.source = Path(directory), Path(source)
        self.target = self.directory / "mount.fuse"
        self.marker = self.directory / ".nebula-coco-mount-helper.json"
        self.lock_path = self.directory / ".nebula-coco-mount-helper.lock"
        self.owner, self.existing = owner, existing
        self.data = self.source.read_bytes()
        if not self.data.startswith(b"\x7fELF") or len(self.data) > 16 * 1024**2:
            raise ValueError("bounded Linux helper required")
        self.receipt = {"owner": owner, "sha256": hashlib.sha256(self.data).hexdigest()}
        self.lock = None
        self.locked = False
        self.owned = False

    def sync(self):
        fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def publish(self, path, data, mode, replace=False):
        fd, name = tempfile.mkstemp(prefix=".nebula-coco-helper-", dir=self.directory)
        temporary = Path(name)
        try:
            with os.fdopen(fd, "wb") as stream:
                stream.write(data)
                stream.flush()
                os.fchmod(stream.fileno(), mode)
                os.fsync(stream.fileno())
            if replace:
                os.replace(temporary, path)
            else:
                # Never overwrite a helper that appeared after discovery.
                os.link(temporary, path)
            temporary.unlink(missing_ok=True)
            self.sync()
        finally:
            temporary.unlink(missing_ok=True)

    def matches(self):
        try:
            return read_regular(self.target, 16 * 1024**2) == self.data
        except (OSError, ValueError):
            return False

    def install(self):
        self.lock = os.open(self.lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        info = os.fstat(self.lock)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o022 or info.st_size or info.st_nlink != 1:
            raise ValueError("unsafe helper lock")
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.locked = True
        if os.path.lexists(self.marker):
            if json.loads(read_regular(self.marker, 4096)) != self.receipt:
                raise ValueError("foreign helper ownership")
        else:
            if self.existing():
                return "existing"
            if os.path.lexists(self.target):
                raise ValueError("foreign helper file")
            # Intent precedes installation so a restarted sidecar can finish
            # an interrupted copy without adopting an unrelated executable.
            self.publish(self.marker, json.dumps(self.receipt).encode(), 0o600)
        if not os.path.lexists(self.target):
            self.publish(self.target, self.data, 0o755)
        if not self.matches():
            raise ValueError("owned helper was replaced")
        self.owned = True
        return "installed"

    def cleanup(self):
        if self.owned and json.loads(read_regular(self.marker, 4096)) == self.receipt:
            if self.matches():
                self.target.unlink()
            # A replacement by another administrator is preserved.
            self.marker.unlink()
            self.sync()
        self.close()

    def close(self):
        if self.lock is not None:
            if self.locked and os.path.lexists(self.lock_path) and os.lstat(self.lock_path).st_ino == os.fstat(self.lock).st_ino:
                self.lock_path.unlink()
            os.close(self.lock)
            self.lock = None
            self.locked = False


def system_helper_exists():
    # Resolve the host's own symlinks in its filesystem namespace. This is a
    # fixed read-only command; neither the path nor shell text is user input.
    result = subprocess.run(["chroot", "/host", "/bin/sh", "-c", "if command -v mount.fuse >/dev/null 2>&1; then exit 0; else exit 42; fi"],
        env={"PATH": "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"},
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=False)
    if result.returncode not in (0, 42):
        raise ValueError("host helper discovery failed")
    return result.returncode == 0


def main():
    os.umask(0o077)
    stopped = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stopped.set())
    signal.signal(signal.SIGINT, lambda *_: stopped.set())
    helper = Helper("/host-bin", "/usr/local/lib/nebula/mount.fuse", os.environ["NEBULA_HELPER_OWNER"], system_helper_exists)
    status = helper.install()
    Path("/run/nebula-helper/ready").write_text(status)
    print(json.dumps({"mountHelper": status}), flush=True)
    stopped.wait()
    helper.cleanup()
    print('{"ownedMountHelperRemoved":true}', flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        # Never include host paths, process output or opaque mount options.
        print("NEBULA_HOST_HELPER_FAILED", flush=True)
        raise SystemExit(1)
