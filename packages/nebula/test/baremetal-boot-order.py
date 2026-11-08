"""Firmware-priority regression tests using disposable EFI-variable files only."""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from baremetal_fixtures import FACTS, SPEC, build_agent, host_agent, installer

boot_order = host_agent.boot_order


class BootOrderTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.variables = self.root / "efivars"
        self.variables.mkdir()
        self.mounts = self.root / "mounts"
        self.mounts.write_text(f"efivarfs {self.variables} efivarfs rw 0 0\n")
        patched = patch.object(boot_order, "VARIABLES", self.variables)
        patched.start()
        self.addCleanup(patched.stop)
        mounted = patch.object(boot_order, "MOUNTS", self.mounts)
        mounted.start()
        self.addCleanup(mounted.stop)
        self.receipt = self.root / "installed.json"
        self.receipt.write_text(json.dumps({"uid": "test", "sourceBootOrder": ["0002", "0003"]}))
        for number in ("0000", "0002", "0003"):
            self.variable("Boot" + number, ("loader-" + number).encode())
        self.variable("BootNext", b"\x03\0")

    def variable(self, name, value):
        path = self.variables / (name + "-" + boot_order.GLOBAL_GUID)
        path.write_bytes(b"\x07\0\0\0" + value)
        return path

    def order(self, numbers):
        self.variable("BootOrder", b"".join(int(n, 16).to_bytes(2, "little") for n in numbers))

    def apply(self, args, **kwargs):
        self.assertEqual(args[:2], ["efibootmgr", "--bootorder"])
        self.order(args[2].split(","))
        return subprocess.CompletedProcess(args, 0)

    def test_grub_cannot_preempt_existing_network_recovery_priority(self):
        self.order(["0000", "0002", "0003"])
        original_entries = {n: boot_order.value("Boot" + n) for n in ("0000", "0002", "0003")}
        with patch.object(boot_order.subprocess, "run", side_effect=self.apply) as command:
            boot_order.restore(self.receipt)
            command.assert_called_once()
        self.assertEqual(boot_order.capture(), ["0002", "0003", "0000"])
        self.assertEqual(boot_order.value("BootNext"), b"\x03\0")
        self.assertEqual(
            {n: boot_order.value("Boot" + n) for n in original_entries}, original_entries
        )
        saved = json.loads(self.receipt.read_text())
        self.assertEqual(saved["bootOrder"], ["0002", "0003", "0000"])
        self.assertEqual(saved["sourceBootOrder"], ["0002", "0003"])
        self.assertEqual(self.receipt.stat().st_mode & 0o777, 0o600)

    def test_local_first_policy_is_preserved_without_guessing_a_provider_order(self):
        self.receipt.write_text(json.dumps({"sourceBootOrder": ["0000", "0003", "0002"]}))
        self.order(["0000", "0003", "0002"])
        with patch.object(boot_order.subprocess, "run") as command:
            boot_order.restore(self.receipt)
            command.assert_not_called()
        self.assertEqual(boot_order.capture(), ["0000", "0003", "0002"])

    def test_removed_old_loader_is_not_resurrected_and_new_loader_is_retained(self):
        self.receipt.write_text(json.dumps({"sourceBootOrder": ["0002", "0001", "0003"]}))
        self.order(["0000", "0002", "0003"])
        with patch.object(boot_order.subprocess, "run", side_effect=self.apply):
            boot_order.restore(self.receipt)
        self.assertEqual(boot_order.capture(), ["0002", "0003", "0000"])
        self.assertIsNone(boot_order.value("Boot0001"))

    def test_surviving_entry_is_preserved_even_if_grub_removed_it_from_boot_order(self):
        self.order(["0000", "0002"])
        with patch.object(boot_order.subprocess, "run", side_effect=self.apply):
            boot_order.restore(self.receipt)
        self.assertEqual(boot_order.capture(), ["0002", "0003", "0000"])

    def test_fresh_firmware_keeps_new_installed_loader_without_an_original_order(self):
        self.receipt.write_text(json.dumps({"sourceBootOrder": []}))
        self.order(["0000"])
        with patch.object(boot_order.subprocess, "run") as command:
            boot_order.restore(self.receipt)
            command.assert_not_called()
        self.assertEqual(boot_order.capture(), ["0000"])

    def test_failed_write_readback_or_bootnext_change_never_records_success(self):
        for failure in ("write", "readback", "bootnext"):
            with self.subTest(failure=failure):
                self.order(["0000", "0002", "0003"])
                before = self.receipt.read_text()

                def apply(args, failure=failure, **kwargs):
                    if failure == "write":
                        raise subprocess.CalledProcessError(1, args)
                    if failure == "bootnext":
                        self.apply(args)
                        self.variable("BootNext", b"\x02\0")

                with (
                    patch.object(boot_order.subprocess, "run", side_effect=apply),
                    self.assertRaises((ValueError, subprocess.CalledProcessError)),
                ):
                    boot_order.restore(self.receipt)
                self.assertEqual(self.receipt.read_text(), before)

    def test_retry_is_idempotent_and_cannot_overwrite_later_operator_changes(self):
        self.order(["0000", "0002", "0003"])
        with patch.object(boot_order.subprocess, "run", side_effect=self.apply) as command:
            boot_order.restore(self.receipt)
            boot_order.restore(self.receipt)
            self.assertEqual(command.call_count, 1)
            self.order(["0000", "0003", "0002"])
            with self.assertRaisesRegex(ValueError, "priority differs"):
                boot_order.restore(self.receipt)
            self.assertEqual(command.call_count, 1)

    def test_firmware_can_append_a_new_device_without_changing_recorded_priority(self):
        with self.assertRaisesRegex(ValueError, "priority is empty"):
            boot_order.verify([])
        self.variable("Boot0004", b"new-device")
        self.order(["0002", "0003", "0000", "0004"])
        boot_order.verify(["0002", "0003", "0000"])
        self.order(["0004", "0002", "0003", "0000"])
        with self.assertRaisesRegex(ValueError, "priority differs"):
            boot_order.verify(["0002", "0003", "0000"])

    def test_malformed_firmware_and_invalid_receipts_are_rejected_without_writes(self):
        self.order(["0000", "0002", "0003"])
        with patch.object(boot_order.subprocess, "run") as command:
            for source in (["0002", "0002"], ["../../BootNext"], "0002", [False]):
                self.receipt.write_text(json.dumps({"sourceBootOrder": source}))
                with self.assertRaises(ValueError):
                    boot_order.restore(self.receipt)
            for raw in (b"\x02", b"\x02\0\x02\0", b"\xff\xff"):
                self.variable("BootOrder", raw)
                with self.assertRaises(ValueError):
                    boot_order.capture()
            self.variable("BootOrder", b"").write_bytes(b"\x07\0")
            with self.assertRaisesRegex(ValueError, "truncated"):
                boot_order.capture()
            command.assert_not_called()

    def test_an_unmounted_efivars_directory_is_not_an_empty_firmware_order(self):
        self.mounts.write_text(f"sysfs {self.variables} sysfs rw 0 0\n")
        with self.assertRaisesRegex(ValueError, "unavailable"):
            boot_order.capture()

    def test_seed_only_restores_captured_uefi_order_and_bios_install_is_unchanged(self):
        receipt = {"uid": "test", "sourceBootOrder": FACTS["bootOrder"]}
        files = installer.render_files(SPEC, FACTS, "ssh-ed25519 AAAA", receipt)
        self.assertIn(b"mountpoint -q /sys/firmware/efi/efivars", files["nebula/late.sh"])
        self.assertIn(
            b"python3 -I /var/lib/nebula-baremetal/boot_order.py", files["nebula/late.sh"]
        )
        self.assertIn(b"efibootmgr", files["nebula/boot_order.py"])
        late = files["nebula/late.sh"]
        self.assertGreater(
            late.index(b"grub2/update_nvram boolean false"), late.index(b"python3 -I")
        )
        self.assertEqual(
            json.loads(files["nebula/receipt.json"])["sourceBootOrder"], FACTS["bootOrder"]
        )
        for invalid in ({"uid": "test"}, {"uid": "test", "sourceBootOrder": []}):
            with self.assertRaisesRegex(ValueError, "not captured"):
                installer.render_files(SPEC, FACTS, "ssh-ed25519 AAAA", invalid)
        bios = installer.render_files(
            SPEC, {**FACTS, "uefi": False}, "ssh-ed25519 AAAA", {"uid": "test"}
        )
        self.assertNotIn("nebula/boot_order.py", bios)
        self.assertNotIn(b"efivar", bios["nebula/late.sh"])

    def test_post_reboot_drift_or_missing_late_receipt_blocks_osready(self):
        receipt = {
            "uid": "test",
            "fingerprint": installer.fingerprint(SPEC),
            "sourceBootId": "old",
            "sourceBootOrder": ["0002", "0003"],
            "bootOrder": ["0002", "0003", "0000"],
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
            path.return_value.read_text.side_effect = [
                json.dumps(receipt),
                "ID=debian\nVERSION_CODENAME=trixie\n",
            ]
            self.order(["0002", "0003", "0000"])
            self.assertTrue(host_agent.verify({"uid": "test", "spec": SPEC})["verified"])
            path.return_value.read_text.side_effect = [
                json.dumps(receipt),
                "ID=debian\nVERSION_CODENAME=trixie\n",
            ]
            self.order(["0000", "0002", "0003"])
            with self.assertRaisesRegex(ValueError, "boot priority verification failed"):
                host_agent.verify({"uid": "test", "spec": SPEC})
            receipt.pop("bootOrder")
            path.return_value.read_text.side_effect = [
                json.dumps(receipt),
                "ID=debian\nVERSION_CODENAME=trixie\n",
            ]
            with self.assertRaisesRegex(ValueError, "boot priority was not recorded"):
                host_agent.verify({"uid": "test", "spec": SPEC})

    def test_boot_order_drift_after_discovery_cannot_stage_or_commit_an_install(self):
        with (
            patch.object(
                host_agent, "probe", return_value={**FACTS, "bootOrder": ["0003", "0002"]}
            ),
            patch.object(host_agent, "command") as command,
            self.assertRaisesRegex(ValueError, "changed after discovery"),
        ):
            host_agent.stage({"uid": "test", "spec": SPEC, "facts": FACTS})
        command.assert_not_called()

    def test_actual_seeded_helper_executes_in_isolation_with_disposable_firmware(self):
        files = installer.render_files(
            SPEC, FACTS, "ssh-ed25519 AAAA", {"sourceBootOrder": FACTS["bootOrder"]}
        )
        helper = self.root / "boot_order.py"
        helper.write_text(
            files["nebula/boot_order.py"]
            .decode()
            .replace(
                'Path("/sys/firmware/efi/efivars")',
                f"Path({str(self.variables)!r})",
            )
            .replace('Path("/proc/mounts")', f"Path({str(self.mounts)!r})")
        )
        executables = self.root / "bin"
        executables.mkdir()
        manager = executables / "efibootmgr"
        manager.write_text(
            f"#!{sys.executable}\nimport sys\nfrom pathlib import Path\n"
            "assert sys.argv[1] == '--bootorder'\n"
            f"p = Path({str(self.variables / ('BootOrder-' + boot_order.GLOBAL_GUID))!r})\n"
            "p.write_bytes(bytes([7,0,0,0]) + b''.join(int(n,16).to_bytes(2,'little') for n in sys.argv[2].split(',')))\n"
        )
        manager.chmod(0o755)
        self.order(["0000", "0002", "0003"])
        result = subprocess.run(
            [sys.executable, "-I", "-B", str(helper), str(self.receipt)],
            capture_output=True,
            text=True,
            cwd=self.root,
            env={**os.environ, "PATH": str(executables) + os.pathsep + os.environ["PATH"]},
            check=True,
        )
        self.assertEqual(result.stdout + result.stderr, "")
        self.assertEqual(boot_order.capture(), ["0002", "0003", "0000"])
        self.assertEqual(
            json.loads(self.receipt.read_text())["bootOrder"], ["0002", "0003", "0000"]
        )
        self.assertEqual(boot_order.value("BootNext"), b"\x03\0")

    def test_seed_helper_source_is_available_inside_the_isolated_agent_zipapp(self):
        # Use only temporary code paths; importing the packaged agent never probes a host.
        program = build_agent().replace(
            "runpy.run_path(str(archive), run_name='__main__')",
            "sys.path.insert(0, str(archive)); import installer; "
            "files = installer.render_files(**json.loads(sys.stdin.read())); "
            "print(files['nebula/boot_order.py'].decode())",
        )
        payload = {
            "spec": SPEC,
            "facts": FACTS,
            "worker_public_key": "ssh-ed25519 AAAA",
            "receipt": {"sourceBootOrder": FACTS["bootOrder"]},
        }
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", "import sys,json\n" + program],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            cwd=self.root,
            check=True,
        )
        self.assertIn("def restore(receipt_path: Path)", result.stdout)
        self.assertEqual(result.stderr, "")


if __name__ == "__main__":
    unittest.main()
