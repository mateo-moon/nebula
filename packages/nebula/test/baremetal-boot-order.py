"""Installed-loader regression tests using disposable EFI files and fake tools."""

import hashlib
import json
import struct
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from baremetal_fixtures import FACTS, SPEC, build_agent, host_agent, installer

boot_order = host_agent.boot_order
OLD_ESP = "10000000-0000-0000-0000-000000000001"
NEW_ESP = "20000000-0000-0000-0000-000000000002"
OTHER_ESP = "30000000-0000-0000-0000-000000000003"


def load_option(partition, loader, *, active=True, label="test"):
    drive = struct.pack("<BBHIQQ", 4, 1, 42, 1, 2048, 1048576)
    drive += uuid.UUID(partition).bytes_le + b"\x02\x02"
    filename = (loader + "\0").encode("utf-16-le")
    path = drive + struct.pack("<BBH", 4, 4, len(filename) + 4) + filename + b"\x7f\xff\x04\x00"
    return struct.pack("<IH", int(active), len(path)) + (label + "\0").encode("utf-16-le") + path


class BootOrderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.variables = self.root / "efivars"
        self.variables.mkdir()
        self.mounts = self.root / "mounts"
        self.mounts.write_text(f"efivarfs {self.variables} efivarfs rw 0 0\n")
        self.disk = self.root / "disk"
        self.disk.touch()
        self.esp = self.root / "esp"
        (self.esp / "efi/debian").mkdir(parents=True)
        (self.esp / "efi/debian/grubx64.efi").write_bytes(b"new-loader")
        for key, value in (
            ("VARIABLES", self.variables),
            ("MOUNTS", self.mounts),
            ("ESP", self.esp),
        ):
            patched = patch.object(boot_order, key, value)
            patched.start()
            self.addCleanup(patched.stop)
        mounted = patch.object(
            boot_order, "esp_identity", return_value=(str(self.disk), "1", NEW_ESP)
        )
        mounted.start()
        self.addCleanup(mounted.stop)
        self.variable("Boot0007", load_option(OLD_ESP, "\\EFI\\ubuntu\\shimx64.efi"))
        self.variable("Boot0002", b"network-recovery-entry")
        self.variable("Boot0003", load_option(OTHER_ESP, "\\EFI\\other\\bootx64.efi"))
        self.variable("Boot0000", load_option(NEW_ESP, "\\EFI\\debian\\grubx64.efi"))
        self.variable("BootCurrent", b"\x07\0")
        self.order(["0007", "0002", "0003", "0000"])
        self.receipt = self.root / "installed.json"
        self.source = [{"number": "0007", "sha256": self.digest("0007")}]
        self.receipt.write_text(
            json.dumps(
                {"uid": "test", "sourceBootEntries": self.source, "systemDisk": str(self.disk)}
            )
        )

    def variable(self, name, data):
        path = self.variables / (name + "-" + boot_order.GLOBAL_GUID)
        path.write_bytes(b"\x07\0\0\0" + data)
        return path

    def digest(self, n):
        return hashlib.sha256(boot_order.value("Boot" + n)).hexdigest()

    def order(self, numbers):
        self.variable("BootOrder", b"".join(int(n, 16).to_bytes(2, "little") for n in numbers))

    def manager(self, args):
        self.assertEqual(args[0], "efibootmgr")
        if args[1] == "--bootorder":
            self.order(args[2].split(","))
        elif args[1] == "--bootnum":
            self.assertEqual(args[3], "--delete-bootnum")
            (self.variables / ("Boot" + args[2] + "-" + boot_order.GLOBAL_GUID)).unlink()
        elif args[1] == "--create-only":
            self.variable("Boot0000", load_option(NEW_ESP, args[-1], label="debian"))
        else:
            self.fail("Unexpected firmware mutation")
        return ""

    def configure(self):
        with patch.object(boot_order, "command", side_effect=self.manager):
            boot_order.configure(self.receipt)
        return json.loads(self.receipt.read_text())["bootLoader"]

    def test_new_debian_precedes_stale_source_and_network_after_kexec(self):
        network = boot_order.value("Boot0002")
        other = boot_order.value("Boot0003")
        identity = self.configure()
        self.assertEqual(boot_order.order(), ["0000", "0002", "0003"])
        self.assertIsNone(boot_order.value("Boot0007"))
        self.assertEqual(boot_order.value("Boot0002"), network)
        self.assertEqual(boot_order.value("Boot0003"), other)
        self.assertEqual(identity["partUuid"], NEW_ESP)
        self.assertEqual(self.receipt.stat().st_mode & 0o777, 0o600)
        with self.assertRaisesRegex(ValueError, "did not boot"):
            boot_order.verify(identity)
        self.variable("BootCurrent", b"\0\0")
        boot_order.verify(identity)

    def test_already_local_first_and_network_first_sources_select_new_os(self):
        for previous in (["0000", "0007", "0002"], ["0002", "0007", "0000"]):
            with self.subTest(previous=previous):
                self.receipt.write_text(
                    json.dumps({"sourceBootEntries": self.source, "systemDisk": str(self.disk)})
                )
                self.variable("Boot0007", load_option(OLD_ESP, "\\EFI\\ubuntu\\shimx64.efi"))
                self.order(previous)
                identity = self.configure()
                self.assertEqual(boot_order.order()[0], "0000")
                self.variable("BootCurrent", b"\0\0")
                boot_order.verify(identity)

    def test_reused_boot_number_is_not_deleted(self):
        self.variable("Boot0007", load_option(NEW_ESP, "\\EFI\\debian\\grubx64.efi"))
        (self.variables / ("Boot0000-" + boot_order.GLOBAL_GUID)).unlink()
        self.order(["0007", "0002", "0003"])
        identity = self.configure()
        self.assertEqual(identity["number"], "0007")
        self.assertIsNotNone(boot_order.value("Boot0007"))
        self.assertEqual(boot_order.order(), ["0007", "0002", "0003"])

    def test_changed_source_number_belongs_to_new_owner_and_is_retained(self):
        self.variable("Boot0007", load_option(OTHER_ESP, "\\EFI\\other\\different.efi"))
        self.configure()
        self.assertIsNotNone(boot_order.value("Boot0007"))
        self.assertEqual(boot_order.order(), ["0000", "0007", "0002", "0003"])

    def test_esp_on_another_disk_blocks_setup_before_firmware_writes(self):
        other = self.root / "other-disk"
        other.touch()
        with (
            patch.object(boot_order, "esp_identity", return_value=(str(other), "1", NEW_ESP)),
            patch.object(boot_order, "command") as commands,
            self.assertRaisesRegex(ValueError, "selected system disk"),
        ):
            boot_order.configure(self.receipt)
        commands.assert_not_called()

    def test_ownership_change_during_priority_write_prevents_entry_deletion(self):
        def manager(args):
            result = self.manager(args)
            if args[1] == "--bootorder":
                self.variable("Boot0007", load_option(OTHER_ESP, "\\EFI\\other\\new.efi"))
            return result

        with patch.object(boot_order, "command", side_effect=manager):
            with self.assertRaisesRegex(ValueError, "ownership changed"):
                boot_order.configure(self.receipt)
        self.assertIsNotNone(boot_order.value("Boot0007"))
        self.assertNotIn("bootLoader", json.loads(self.receipt.read_text()))

    def test_missing_grub_registration_is_created_for_the_actual_esp(self):
        (self.variables / ("Boot0000-" + boot_order.GLOBAL_GUID)).unlink()
        self.order(["0007", "0002", "0003"])
        identity = self.configure()
        self.assertEqual(identity["number"], "0000")
        self.assertEqual(boot_order.order()[0], "0000")

    def test_wrong_esp_inactive_entry_and_deceptive_label_are_not_accepted(self):
        for raw in (
            load_option(OTHER_ESP, "\\EFI\\debian\\grubx64.efi", label="debian"),
            load_option(NEW_ESP, "\\EFI\\debian\\grubx64.efi", active=False),
            load_option(NEW_ESP, "\\EFI\\ubuntu\\shimx64.efi", label="debian"),
        ):
            self.variable("Boot0000", raw)
            self.assertIsNone(boot_order.select_loader(NEW_ESP))
        (self.esp / "efi/debian/grubx64.efi").unlink()
        with self.assertRaisesRegex(ValueError, "file is missing"):
            self.configure()

    def test_failed_priority_or_cleanup_does_not_complete_receipt(self):
        for failure in ("write", "readback", "delete"):
            with self.subTest(failure=failure):

                def manager(args, failure=failure):
                    if failure == "write":
                        raise subprocess.CalledProcessError(1, args)
                    if failure == "delete" and args[1] == "--bootnum":
                        return ""
                    if failure != "readback":
                        return self.manager(args)
                    return ""

                self.order(["0007", "0002", "0003", "0000"])
                with patch.object(boot_order, "command", side_effect=manager):
                    with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                        boot_order.configure(self.receipt)
                self.assertNotIn("bootLoader", json.loads(self.receipt.read_text()))

    def test_conflicting_bootnext_is_preserved_and_blocks_configuration(self):
        self.variable("BootNext", b"\x02\0")
        with patch.object(boot_order, "command") as commands:
            with self.assertRaisesRegex(ValueError, "BootNext conflicts"):
                boot_order.configure(self.receipt)
        commands.assert_not_called()
        self.assertEqual(boot_order.value("BootNext"), b"\x02\0")
        self.assertNotIn("bootLoader", json.loads(self.receipt.read_text()))

    def test_loader_bootnext_is_left_unchanged(self):
        self.variable("BootNext", b"\0\0")
        self.configure()
        self.assertEqual(boot_order.value("BootNext"), b"\0\0")

    def test_retry_cannot_overwrite_later_operator_priority_change(self):
        self.configure()
        with patch.object(boot_order, "command") as commands:
            boot_order.configure(self.receipt)
            self.order(["0002", "0000", "0003"])
            with self.assertRaisesRegex(ValueError, "not first"):
                boot_order.configure(self.receipt)
        commands.assert_not_called()

    def test_post_reboot_requires_correct_entry_current_boot_and_esp(self):
        identity = self.configure()
        self.variable("BootCurrent", b"\0\0")
        boot_order.verify(identity)
        with patch.object(boot_order, "esp_identity", return_value=("/dev/vdb", "1", OTHER_ESP)):
            with self.assertRaisesRegex(ValueError, "OS ESP"):
                boot_order.verify(identity)
        self.variable("Boot0000", load_option(OTHER_ESP, "\\EFI\\debian\\grubx64.efi"))
        with self.assertRaisesRegex(ValueError, "identity changed"):
            boot_order.verify(identity)

    def test_capture_owns_only_gpt_entries_on_selected_disk_and_fences_bootnext(self):
        devices = {
            "blockdevices": [{"children": [{"parttype": boot_order.ESP_TYPE, "partuuid": OLD_ESP}]}]
        }
        with patch.object(boot_order, "command", return_value=json.dumps(devices)):
            self.assertEqual(boot_order.capture("/dev/disk/by-id/os"), self.source)
            self.variable("BootNext", b"\x02\0")
            with self.assertRaisesRegex(ValueError, "Resolve pending"):
                boot_order.capture("/dev/disk/by-id/os")

    def test_malformed_load_options_and_unmounted_variables_are_rejected(self):
        for raw in (b"", b"\0" * 7, load_option(NEW_ESP, "\\EFI\\debian\\grubx64.efi")[:-1]):
            self.assertIsNone(boot_order.load_option(raw))
        self.mounts.write_text("")
        with self.assertRaisesRegex(ValueError, "unavailable"):
            self.configure()

    def test_receipt_validation_rejects_invalid_source_ownership(self):
        for data in ("0007", [{"number": "../../BootNext", "sha256": "a" * 64}], self.source * 2):
            with self.assertRaises(ValueError):
                boot_order.source_entries(data)
        for identity in (None, {}, {"number": "0000"}):
            with self.assertRaisesRegex(ValueError, "loader identity"):
                boot_order.verify(identity)

    def test_missing_or_unbooted_loader_receipt_blocks_host_verification(self):
        identity = self.configure()
        receipt = {
            "uid": "test",
            "fingerprint": installer.fingerprint(SPEC),
            "sourceBootId": "old",
            "sourceBootEntries": self.source,
            "systemDisk": str(self.disk),
            "bootLoader": identity,
        }
        with (
            patch.object(host_agent, "Path") as path,
            patch.object(host_agent.platform, "node", return_value=SPEC["hostname"]),
            patch.object(
                host_agent,
                "command",
                side_effect=lambda args: str(16 * 1024**3) if args[0] in ("vgs", "lvs") else "new",
            ),
            patch.object(
                host_agent,
                "json_command",
                return_value=[
                    {
                        "addr_info": [
                            {"scope": "global", "family": "inet", "local": "192.0.2.10"},
                            {"scope": "global", "family": "inet6", "local": "2001:db8::10"},
                        ]
                    }
                ],
            ),
        ):

            def read_receipt():
                path.return_value.read_text.side_effect = [
                    json.dumps(receipt),
                    "ID=debian\nVERSION_CODENAME=trixie\n",
                ]

            read_receipt()
            with self.assertRaisesRegex(ValueError, "loader verification failed"):
                host_agent.verify({"uid": "test", "spec": SPEC})
            self.variable("BootCurrent", b"\0\0")
            read_receipt()
            self.assertTrue(host_agent.verify({"uid": "test", "spec": SPEC})["verified"])
            receipt.pop("bootLoader")
            read_receipt()
            with self.assertRaisesRegex(ValueError, "loader was not recorded"):
                host_agent.verify({"uid": "test", "spec": SPEC})

    def test_seed_records_ownership_and_bios_has_no_firmware_setup(self):
        receipt = {
            "uid": "test",
            "sourceBootEntries": FACTS["sourceBootEntries"],
            "systemDisk": FACTS["disk"]["byId"],
        }
        files = installer.render_files(SPEC, FACTS, "ssh-ed25519 AAAA", receipt)
        self.assertIn(
            b"python3 -I /var/lib/nebula-baremetal/boot_order.py", files["nebula/late.sh"]
        )
        self.assertNotIn(b"grub2/update_nvram boolean false", files["nebula/late.sh"])
        with self.assertRaisesRegex(ValueError, "not captured"):
            installer.render_files(SPEC, FACTS, "ssh-ed25519 AAAA", {"uid": "test"})
        bios = installer.render_files(
            SPEC, {**FACTS, "uefi": False}, "ssh-ed25519 AAAA", {"uid": "test"}
        )
        self.assertNotIn("nebula/boot_order.py", bios)

    def test_boot_entry_drift_between_discovery_and_staging_blocks_writes(self):
        with (
            patch.object(
                host_agent,
                "probe",
                return_value={
                    **FACTS,
                    "sourceBootEntries": self.source,
                    "systemDisk": str(self.disk),
                },
            ),
            patch.object(host_agent, "command") as command,
            self.assertRaisesRegex(ValueError, "changed after discovery"),
        ):
            host_agent.stage({"uid": "test", "spec": SPEC, "facts": FACTS})
        command.assert_not_called()

    def test_source_is_available_inside_actual_isolated_agent_zipapp(self):
        program = build_agent().replace(
            "runpy.run_path(str(archive), run_name='__main__')",
            "sys.path.insert(0, str(archive)); import installer; "
            "files=installer.render_files(**json.loads(sys.stdin.read())); "
            "print(files['nebula/boot_order.py'].decode())",
        )
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", "import sys,json\n" + program],
            input=json.dumps(
                {
                    "spec": SPEC,
                    "facts": FACTS,
                    "worker_public_key": "ssh-ed25519 AAAA",
                    "receipt": {
                        "sourceBootEntries": FACTS["sourceBootEntries"],
                        "systemDisk": FACTS["disk"]["byId"],
                    },
                }
            ),
            text=True,
            capture_output=True,
            cwd=self.root,
            check=True,
        )
        self.assertIn("def configure(receipt_path: Path)", result.stdout)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
