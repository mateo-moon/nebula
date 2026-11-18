"""Offline regressions for the Bash boot tools. Run with python3 scripts/boot-tools.test.py."""

import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import unittest

SCRIPTS = Path(__file__).resolve().parent


class BootToolsTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="nebula boot tools ")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name).resolve()
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self.scratch = self.root / "scratch"
        self.scratch.mkdir()
        # Only these ordinary tools can run. Disk, VM and cloud commands are mocks.
        for name in ("bash", "basename", "cat", "cp", "dirname", "grep", "gzip", "mkdir",
                     "mktemp", "python3", "rm", "tar", "which"):
            (self.bin / name).symlink_to(shutil.which(name))
        self.env = {**os.environ, "PATH": str(self.bin), "TMPDIR": str(self.scratch)}
        self.usb = self.root / "boot input.usb"
        self.usb.write_bytes(b"synthetic boot image")
        self.gcp_args = ["--usb", str(self.usb), "--image-name", "example"]
        self.usb_args = ["--output", "output.usb", "--ipxe-efi", str(self.usb),
                         "--autoexec", str(self.usb), "--mount-dir", "mountpoint"]

    def mock(self, name, body):
        path = self.bin / name
        path.unlink(missing_ok=True)
        path.write_text("#!/bin/sh\n" + body + "\n")
        path.chmod(0o755)

    def invoke(self, script, args, expected, **env):
        result = subprocess.run([str(SCRIPTS / script), *args], cwd=self.root,
                                env={**self.env, **env}, capture_output=True, text=True)
        self.assertEqual(result.returncode, expected, result.stdout + result.stderr)
        return result

    def assert_archive(self, path):
        with tarfile.open(path) as archive:
            self.assertEqual(archive.getnames(), ["disk.raw"])
            self.assertEqual(archive.extractfile("disk.raw").read(), self.usb.read_bytes())

    def test_local_output_survives_exit_and_repeated_runs(self):
        existing = self.root / "example.tar.gz"
        existing.write_bytes(b"unrelated")
        outputs = []
        for _ in range(2):
            run = self.invoke("gcp_create_image_from_usb.sh", self.gcp_args + ["--no-gpt", "--local-only"], 0)
            path = Path(run.stdout.split("Local tarball created at: ")[1].strip())
            self.assertTrue(path.is_file(), f"reported archive missing after exit: {path}")
            self.assertEqual(path.parent.parent, self.root)
            self.assertEqual(list(path.parent.iterdir()), [path])
            self.assert_archive(path)
            outputs.append(path)
        self.assertNotEqual(*outputs)
        self.assertEqual(existing.read_bytes(), b"unrelated")
        self.invoke("gcp_create_image_from_usb.sh",
                    self.gcp_args + ["--no-gpt", "--local-only", "--tarball-out", str(existing)], 0)
        self.assert_archive(existing)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_failed_build_and_upload_report_exact_status_and_clean_staging(self):
        self.mock("docker", "exit 46")
        run = self.invoke("gcp_create_image_from_usb.sh", self.gcp_args + ["--local-only"], 46)
        self.assertIn("exited with 46", run.stderr)
        self.assertEqual(list(self.root.glob("nebula-image.*")), [])
        self.mock("gcloud", 'case "$1 $2" in "storage ls") exit 1;; "storage cp") exit 45;; *) exit 99;; esac')
        run = self.invoke("gcp_create_image_from_usb.sh",
                          self.gcp_args + ["--no-gpt", "--gcs-uri", "gs://mock", "--project", "mock"], 45)
        self.assertIn("exited with 45", run.stderr)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_usb_builder_only_unmounts_its_own_successful_mount(self):
        self.mock("umount", 'echo "$1" >> unmounted')
        self.mock("fallocate", "exit 42")
        run = self.invoke("build_boot_usb.sh", self.usb_args, 42)
        self.assertIn("exited with 42", run.stderr)
        self.assertFalse((self.root / "unmounted").exists())
        for name in ("fallocate", "mkfs.fat", "mount"):
            self.mock(name, "exit 0")
        self.mock("cp", "exit 43")
        self.invoke("build_boot_usb.sh", self.usb_args, 43)
        self.assertEqual((self.root / "unmounted").read_text(), "mountpoint\n")

    def test_vm_launcher_propagates_failure_before_starting_qemu(self):
        self.mock("qemu-system-x86_64", "exit 99")
        self.mock("cp", "exit 44")
        self.mock("umount", "echo unexpected > unmounted")
        run = self.invoke("start_test_machine.sh", [], 44, MOUNT_DIR="unrelated")
        self.assertIn("exit code 44", run.stderr)
        self.assertFalse((self.root / "unmounted").exists())


if __name__ == "__main__":
    unittest.main()
