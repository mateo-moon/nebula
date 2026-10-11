import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from host_helper import Helper


class HostHelperTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.binary = self.root / "source"
        self.binary.write_bytes(b"\x7fELFsynthetic-helper")
        self.directory = self.root / "bin"
        self.directory.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def helper(self, existing=False, owner="fixture"):
        return Helper(self.directory, self.binary, owner, lambda: existing)

    def test_missing_helper_is_owned_and_removed(self):
        helper = self.helper()
        self.assertEqual(helper.install(), "installed")
        self.assertEqual(helper.target.read_bytes(), self.binary.read_bytes())
        self.assertEqual(helper.target.stat().st_mode & 0o7777, 0o755)
        helper.cleanup()
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_existing_system_helper_is_preserved(self):
        target = self.directory / "mount.fuse"
        target.write_bytes(b"system-helper")
        helper = self.helper(existing=True)
        self.assertEqual(helper.install(), "existing")
        helper.cleanup()
        self.assertEqual(target.read_bytes(), b"system-helper")
        self.assertEqual(list(self.directory.iterdir()), [target])

    def test_restart_recovers_an_interrupted_installation(self):
        helper = self.helper()
        publish = helper.publish
        def interrupted(path, *args, **kwargs):
            if path == helper.target:
                raise OSError("injected interrupted copy")
            return publish(path, *args, **kwargs)
        with patch.object(helper, "publish", side_effect=interrupted):
            with self.assertRaises(OSError):
                helper.install()
        self.assertTrue(helper.marker.exists())
        self.assertFalse(helper.target.exists())
        helper.close()  # Model process death releasing its file lock.
        recovered = self.helper()
        self.assertEqual(recovered.install(), "installed")
        recovered.cleanup()
        self.assertEqual(list(self.directory.iterdir()), [])

    def test_foreign_replacement_is_not_deleted(self):
        helper = self.helper()
        helper.install()
        helper.target.write_bytes(b"replacement-owned-by-someone-else")
        helper.cleanup()
        self.assertEqual(helper.target.read_bytes(), b"replacement-owned-by-someone-else")
        self.assertFalse(helper.marker.exists())

    def test_foreign_ownership_and_symlinks_are_refused(self):
        helper = self.helper()
        helper.marker.write_text(json.dumps({"owner": "someone-else", "sha256": helper.receipt["sha256"]}))
        with self.assertRaisesRegex(ValueError, "foreign helper ownership"):
            helper.install()
        helper.close()
        helper.marker.unlink()
        helper.target.symlink_to(self.binary)
        with self.assertRaisesRegex(ValueError, "foreign helper file"):
            helper.install()
        helper.close()
        self.assertTrue(helper.target.is_symlink())
        self.assertEqual(self.binary.read_bytes(), b"\x7fELFsynthetic-helper")


if __name__ == "__main__":
    unittest.main()
