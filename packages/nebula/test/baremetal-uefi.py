"""Exercise UEFI byte updates and recovery on temporary files, never host firmware."""

import copy
import errno
import json
import os
import tempfile
import types
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

import baremetal_fixtures as fixtures

host = fixtures.uefi_agent
installer, runner = fixtures.installer, fixtures.runner
UEFI = {
    "match": {"boardVendor": "Fixture Vendor", "boardName": "Fixture Board", "biosVersion": "1.0"},
    "variables": [
        {
            "name": "Setup",
            "guid": "00000000-0000-0000-0000-aaaaaaaaaaaa",
            "payloadSize": 16,
            "attributes": 7,
            "parameters": [
                {
                    "name": "Enable feature",
                    "offset": 1,
                    "width": 1,
                    "value": 1,
                    "allowedValues": [0, 1, 255],
                },
                {
                    "name": "Guest limit",
                    "offset": 4,
                    "width": 4,
                    "value": 99,
                    "range": {"min": 1, "max": 1007},
                },
            ],
        }
    ],
}


class UefiTransactions(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.efi, self.dmi, self.state = (self.root / name for name in ("efivars", "dmi", "state"))
        for directory in (self.efi, self.dmi, self.state):
            directory.mkdir(mode=0o700)
        self.boot = self.root / "boot-id"
        self.boot.write_text("installed-boot")
        for key, value in {
            "board_vendor": "Fixture Vendor",
            "board_name": "Fixture Board",
            "bios_version": "1.0",
        }.items():
            (self.dmi / key).write_text(value)
        self.spec = copy.deepcopy(fixtures.SPEC)
        self.spec["installation"]["uefi"] = copy.deepcopy(UEFI)
        self.payload = {
            "uid": "uefi-request",
            "spec": self.spec,
            "expectedBootId": "installed-boot",
        }
        self.bind()
        payload = bytearray([165] * 16)
        payload[1] = 255
        payload[4:8] = (1).to_bytes(4, "little")
        self.original = (7).to_bytes(4, "little") + payload
        self.variable = self.spec["installation"]["uefi"]["variables"][0]
        self.path = self.efi / host.variable_name(self.variable)
        self.path.write_bytes(self.original)
        self.flags, self.flag_changes = {self.path.stat().st_ino: 16}, []
        for name, value in (
            ("UEFI_ROOT", self.efi),
            ("UEFI_DMI", self.dmi),
            ("UEFI_STATE", self.state),
            ("UEFI_BOOT_ID", self.boot),
        ):
            self.stack.enter_context(patch.object(host, name, value))
        self.stack.enter_context(patch.object(host.fcntl, "ioctl", self.ioctl))
        self.stack.enter_context(
            patch.object(
                host.subprocess,
                "run",
                return_value=types.SimpleNamespace(returncode=0, stdout="efivarfs\n"),
            )
        )

    def bind(self):
        (self.state / "installed.json").write_text(
            json.dumps(
                {"uid": self.payload["uid"], "fingerprint": installer.fingerprint(self.spec)}
            )
        )

    def ioctl(self, descriptor, operation, values, *args):
        inode = os.fstat(descriptor).st_ino
        if operation == host.UEFI_GETFLAGS:
            values[0] = self.flags[inode]
        else:
            self.flags[inode] = values[0]
            self.flag_changes.append(values[0])

    def test_one_write_preserves_attributes_padding_and_private_backup(self):
        with patch.object(host.os, "write", wraps=os.write) as writes:
            result = host.apply(self.payload)
        self.assertTrue(result["changed"])
        self.assertEqual(writes.call_count, 1)
        desired = host.desired_blob(self.variable, self.original)
        self.assertEqual(self.path.read_bytes(), desired)
        changed = {index for index, (a, b) in enumerate(zip(self.original, desired)) if a != b}
        self.assertEqual(changed, {5, 8})
        self.assertEqual(self.flag_changes, [0, 16])
        saved = self.state / "uefi-operation.json"
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertEqual(
            bytes.fromhex(json.loads(saved.read_text())["variables"][0]["before"]), self.original
        )
        self.assertEqual(set(result), {"configured", "changed", "sourceBootId"})
        with patch.object(host.os, "write", wraps=os.write) as writes:
            host.apply(self.payload)
            self.assertEqual(writes.call_count, 0)

    def test_wrong_hardware_size_attributes_or_values_never_write(self):
        for mutate in (
            lambda: (self.dmi / "bios_version").write_text("different"),
            lambda: self.path.write_bytes(self.original[:-1]),
            lambda: self.path.write_bytes((39).to_bytes(4, "little") + self.original[4:]),
            lambda: self.path.write_bytes(self.original[:5] + b"\x02" + self.original[6:]),
        ):
            (self.dmi / "bios_version").write_text("1.0")
            self.path.write_bytes(self.original)
            mutate()
            with (
                patch.object(host.os, "write", wraps=os.write) as writes,
                self.assertRaises(ValueError),
            ):
                host.apply(self.payload)
            self.assertEqual(writes.call_count, 0)
            self.assertFalse((self.state / "uefi-operation.json").exists())

    def test_late_invalid_variable_blocks_the_whole_operation(self):
        other = copy.deepcopy(self.variable)
        other["name"] = "Second"
        self.spec["installation"]["uefi"]["variables"].append(other)
        path = self.efi / host.variable_name(other)
        path.write_bytes(b"invalid")
        self.bind()
        with (
            patch.object(host.os, "write", wraps=os.write) as writes,
            self.assertRaises(ValueError),
        ):
            host.apply(self.payload)
        self.assertEqual(writes.call_count, 0)
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_backup_failure_prevents_any_firmware_write(self):
        with (
            patch.object(host, "save_transaction", side_effect=OSError("disk full")),
            patch.object(host.os, "write", wraps=os.write) as writes,
        ):
            with self.assertRaises(OSError):
                host.apply(self.payload)
        self.assertEqual(writes.call_count, 0)

    def test_resume_repairs_immutable_flag_without_writing_twice(self):
        def interrupted(descriptor, operation, values, *args):
            if operation == host.UEFI_SETFLAGS and values[0] == 16:
                raise OSError("interrupted before restoring flags")
            return self.ioctl(descriptor, operation, values, *args)

        with (
            patch.object(host.fcntl, "ioctl", interrupted),
            self.assertRaisesRegex(ValueError, "restore immutable flag"),
        ):
            host.apply(self.payload)
        self.assertFalse(json.loads((self.state / "uefi-operation.json").read_text())["complete"])
        self.assertEqual(self.flags[self.path.stat().st_ino], 0)
        with patch.object(host.os, "write", wraps=os.write) as writes:
            host.apply(self.payload)
        self.assertEqual(writes.call_count, 0)
        self.assertEqual(self.flags[self.path.stat().st_ino], 16)

    def test_write_errno_has_operation_context_and_restores_flags(self):
        with (
            patch.object(
                host.os, "write", side_effect=OSError(errno.EINVAL, "private payload")
            ) as writes,
            self.assertRaisesRegex(ValueError, r"UEFI write variable failed: EINVAL \(errno 22\)"),
        ):
            host.apply(self.payload)
        self.assertEqual(writes.call_count, 1)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertEqual(self.flag_changes, [0, 16])
        self.assertFalse(json.loads((self.state / "uefi-operation.json").read_text())["complete"])

    def test_changed_bytes_or_reboot_during_partial_write_are_not_overwritten(self):
        with (
            patch.object(host, "write_variable", side_effect=OSError("interrupted")),
            self.assertRaises(OSError),
        ):
            host.apply(self.payload)
        self.path.write_bytes(self.original[:-1] + b"\x00")
        with (
            patch.object(host.os, "write", wraps=os.write) as writes,
            self.assertRaisesRegex(ValueError, "changed after"),
        ):
            host.apply(self.payload)
        self.assertEqual(writes.call_count, 0)
        self.path.write_bytes(self.original)
        self.boot.write_text("unexpected-boot")
        with self.assertRaisesRegex(ValueError, "incomplete UEFI"):
            host.apply(self.payload)

    def test_host_receipt_and_transaction_must_match_the_request(self):
        bad = {**self.payload, "uid": "other-request"}
        with self.assertRaisesRegex(ValueError, "not bound"):
            host.apply(bad)
        host.apply(self.payload)
        self.spec["installation"]["uefi"]["variables"][0]["parameters"][0]["value"] = 0
        self.bind()
        with self.assertRaisesRegex(ValueError, "another operation"):
            host.apply(self.payload)

    def test_missing_backup_cannot_turn_a_pending_reboot_into_a_noop(self):
        host.apply(self.payload)
        (self.state / "uefi-operation.json").unlink()
        with (
            patch.object(host.os, "write", wraps=os.write) as writes,
            self.assertRaisesRegex(ValueError, "backup is missing"),
        ):
            host.apply(self.payload)
        self.assertEqual(writes.call_count, 0)

    def test_activation_needs_another_boot_and_persistent_parameter_values(self):
        host.apply(self.payload)
        self.assertFalse(host.verify(self.payload)["verified"])
        self.boot.write_text("firmware-boot")
        self.assertTrue(host.verify(self.payload)["verified"])
        self.path.write_bytes(self.original)
        with self.assertRaisesRegex(ValueError, "did not persist"):
            host.verify(self.payload)
        with (
            patch.object(host.os, "write", wraps=os.write) as writes,
            self.assertRaises(ValueError),
        ):
            host.apply(self.payload)
        self.assertEqual(writes.call_count, 0)

    def test_already_configured_variables_need_no_write_or_reboot(self):
        self.path.write_bytes(host.desired_blob(self.variable, self.original))
        with patch.object(host.os, "write", wraps=os.write) as writes:
            self.assertFalse(host.apply(self.payload)["changed"])
        self.assertEqual(writes.call_count, 0)
        self.assertFalse(host.reboot(self.payload)["scheduled"])
        self.assertTrue(host.verify(self.payload)["verified"])

    def test_reboot_resumes_only_before_the_original_boot_ends(self):
        host.apply(self.payload)
        calls = []

        def command(args):
            calls.append(args)
            return "not-found"

        with (
            patch.object(host, "command", command),
            patch.object(
                host.subprocess, "run", return_value=types.SimpleNamespace(returncode=1, stdout="")
            ),
        ):
            # Keep mount detection separate from timer status in this fixture.
            with patch.object(host, "verify_environment"):
                self.assertTrue(host.reboot(self.payload)["scheduled"])
                self.assertIn("reboot.target", calls[-1])
                self.assertNotIn("kexec", calls[-1])
                self.boot.write_text("firmware-boot")
                count = len(calls)
                self.assertFalse(host.reboot(self.payload)["scheduled"])
                self.assertEqual(len(calls), count)

    def test_effective_kernel_capabilities_gate_verification(self):
        profile = self.spec["installation"]["uefi"]
        profile["verification"] = {
            "cpuFlags": ["sev_snp"],
            "moduleParameters": [{"module": "kvm_amd", "parameter": "sev_snp", "value": "Y"}],
        }
        self.bind()
        host.apply(self.payload)
        self.boot.write_text("firmware-boot")
        module = self.root / "modules/kvm_amd/parameters"
        module.mkdir(parents=True)
        (module / "sev_snp").write_text("N")

        def path(value):
            if value == "/proc/cpuinfo":
                return types.SimpleNamespace(read_text=lambda: "flags : sev sev_snp\n")
            if value == "/sys/module":
                return self.root / "modules"
            return Path(value)

        with patch.object(host, "Path", path), patch.object(host, "command", return_value=""):
            with self.assertRaisesRegex(ValueError, "kernel module verification"):
                host.verify(self.payload)
            (module / "sev_snp").write_text("Y")
            self.assertTrue(host.verify(self.payload)["verified"])

    def test_in_progress_shutdown_waits_without_scheduling_another_reboot(self):
        host.apply(self.payload)
        state = json.loads((self.state / "uefi-operation.json").read_text())
        host.save_transaction({**state, "rebootRequested": True})
        with (
            patch.object(host, "verify_environment"),
            patch.object(host, "command", return_value="loaded") as commands,
            patch.object(host.subprocess, "run", return_value=types.SimpleNamespace(returncode=1)),
        ):
            self.assertTrue(host.reboot(self.payload)["scheduled"])
        self.assertEqual(commands.call_count, 1)
        self.assertEqual(commands.call_args.args[0][0:2], ["systemctl", "show"])


class FirmwareSSH(fixtures.FakeSSH):
    ready, changed, crash = False, True, False

    def call(self, action, **kwargs):
        if action.startswith("uefi-"):
            self.calls.append(action)
            if kwargs.get("installed") is not True:
                raise AssertionError("UEFI must use installed worker credentials")
            if action == "uefi-apply":
                return {
                    "configured": True,
                    "changed": self.changed,
                    "sourceBootId": "installed-boot",
                }
            if action == "uefi-reboot" and self.crash:
                raise fixtures.RetryableError("lost SSH reply")
            if action == "uefi-verify":
                return {"verified": self.ready, "bootId": "installed-boot"}
            return {}
        return super().call(action, **kwargs)


class FirmwareJob(unittest.TestCase):
    def setUp(self):
        base = fixtures.FakeSSH
        base.installed, base.crash_commit, base.calls, base.original_boot = (
            False,
            False,
            [],
            "source-boot",
        )
        FirmwareSSH.ready, FirmwareSSH.changed, FirmwareSSH.crash = False, True, False
        self.request = {"uid": "request-123", "spec": copy.deepcopy(fixtures.SPEC)}
        self.request["spec"]["installation"]["uefi"] = copy.deepcopy(UEFI)
        self.api = fixtures.FakeAPI(
            {
                "metadata": {"resourceVersion": "1"},
                "data": {"uid": "request-123", "requestHash": "hash-123"},
            }
        )
        self.journal = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")

    def step(self, clock=lambda: 100):
        return runner.advance(self.journal, FirmwareSSH, clock)

    def install(self):
        for _ in range(3):
            self.step()
        fixtures.FakeSSH.installed = True
        self.assertFalse(self.step())
        self.assertEqual(self.journal.status["phase"], "ConfiguringUefi")

    def test_restart_after_configuration_waits_for_reboot_without_reinstall(self):
        self.install()
        FirmwareSSH.crash = True
        with self.assertRaises(RuntimeError):
            self.step()
        self.assertEqual(self.journal.status["phase"], "RebootingUefi")
        self.assertNotIn("verifiedRequestHash", self.api.resource["data"])
        self.journal = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
        FirmwareSSH.crash = False
        self.assertFalse(self.step())
        FirmwareSSH.ready = True
        self.assertTrue(self.step())
        self.assertTrue(self.journal.status["uefiVerified"])
        self.assertEqual(FirmwareSSH.calls.count("stage"), 1)
        self.assertEqual(FirmwareSSH.calls.count("uefi-apply"), 1)
        self.assertEqual(self.api.resource["data"]["verifiedRequestHash"], "hash-123")

    def test_failed_management_checkpoint_does_not_schedule_reboot(self):
        self.install()
        self.api.resource["metadata"]["resourceVersion"] = "99"
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            self.step()
        self.assertNotIn("uefi-reboot", FirmwareSSH.calls)

    def test_firmware_deadline_never_restarts_installation(self):
        self.install()
        self.step()
        before = list(FirmwareSSH.calls)
        with self.assertRaisesRegex(ValueError, "UEFI deadline"):
            self.step(lambda: 5000)
        self.assertEqual(FirmwareSSH.calls, before)

    def test_os_ready_without_uefi_evidence_is_rejected(self):
        self.journal.save(phase="OSReady")
        with self.assertRaisesRegex(ValueError, "UEFI verification"):
            self.step()

    def test_explicit_retry_retains_failure_and_resumes_only_firmware(self):
        self.install()
        original = "UEFI write variable failed: EINVAL (errno 22)"
        self.journal.save(terminalError=True, lastError=original)
        before = list(FirmwareSSH.calls)
        runner.begin_firmware_retry(self.journal, 1, lambda: 5000)
        self.assertEqual(self.journal.status["firmwareFailures"][0]["error"], original)
        self.assertEqual(self.journal.status["uefiStartedAt"], 5000)
        self.assertEqual(self.journal.status["phase"], "ConfiguringUefi")
        self.assertFalse(self.step(lambda: 5000))
        FirmwareSSH.ready = True
        self.assertTrue(self.step(lambda: 5001))
        self.assertEqual(FirmwareSSH.calls[: len(before)], before)
        self.assertFalse({"stage", "commit", "probe"} & set(FirmwareSSH.calls[len(before) :]))
        self.assertTrue(self.journal.status["uefiVerified"])

    def test_failed_retry_cannot_be_unblocked_by_its_restart(self):
        self.install()
        self.journal.save(terminalError=True, lastError="first failure")
        runner.begin_firmware_retry(self.journal, 1, lambda: 100)
        self.journal.save(terminalError=True, lastError="second failure")
        version = self.api.resource["metadata"]["resourceVersion"]
        runner.begin_firmware_retry(self.journal, 1, lambda: 101)
        self.assertEqual(self.api.resource["metadata"]["resourceVersion"], version)
        with self.assertRaisesRegex(ValueError, "blocked"):
            self.step()
        runner.begin_firmware_retry(self.journal, 2, lambda: 102)
        self.assertEqual(len(self.journal.status["firmwareFailures"]), 2)

    def test_retry_refuses_installation_changed_identity_and_skipped_attempts(self):
        for phase in ("Pending", "Discovered", "Staged", "Installing", "OSReady"):
            self.journal.save(
                phase=phase,
                terminalError=True,
                fingerprint=runner.fingerprint(self.request["spec"]),
            )
            with self.assertRaises(ValueError):
                runner.begin_firmware_retry(self.journal, 1)
        self.journal.save(phase="ConfiguringUefi", installedBootId="installed-boot")
        for generation in (0, 2, 17):
            with self.assertRaises(ValueError):
                runner.begin_firmware_retry(self.journal, generation)
        self.journal.save(fingerprint="changed")
        with self.assertRaisesRegex(ValueError, "bound"):
            runner.begin_firmware_retry(self.journal, 1)
        self.assertEqual(FirmwareSSH.calls, [])

    def test_concurrent_retry_consumers_use_a_single_checkpoint(self):
        self.install()
        self.journal.save(terminalError=True, lastError="original")
        stale = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
        runner.begin_firmware_retry(self.journal, 1)
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            runner.begin_firmware_retry(stale, 1)
        self.assertEqual(self.journal.status["firmwareRetryGeneration"], 1)

    def test_skip_rechecks_os_without_firmware_writes_or_reinstallation(self):
        self.install()
        self.journal.save(terminalError=True, lastError="firmware write protected")
        runner.begin_firmware_retry(self.journal, 1, lambda: 5000)
        before = list(FirmwareSSH.calls)
        self.assertTrue(runner.advance(self.journal, FirmwareSSH, lambda: 5000, skip_uefi=True))
        self.assertEqual(FirmwareSSH.calls[len(before) :], ["verify"])
        self.assertTrue(self.journal.status["uefiSkipped"])
        self.assertFalse(self.journal.status["uefiVerified"])
        self.assertEqual(
            self.journal.status["firmwareFailures"][0]["error"], "firmware write protected"
        )
        self.assertEqual(self.api.resource["data"]["verifiedRequestHash"], "hash-123")
        self.assertTrue(runner.advance(self.journal, FirmwareSSH, skip_uefi=True))
        with self.assertRaisesRegex(ValueError, "UEFI verification"):
            self.step()

    def test_skip_does_not_publish_os_ready_when_verification_fails(self):
        self.install()
        with patch.object(FirmwareSSH, "call", return_value={"verified": False}):
            with self.assertRaisesRegex(ValueError, "OS verification"):
                runner.advance(self.journal, FirmwareSSH, skip_uefi=True)
        self.assertNotIn("verifiedRequestHash", self.api.resource["data"])

    def test_skip_cannot_reopen_a_terminal_failure_without_a_retry(self):
        self.install()
        self.journal.save(terminalError=True, lastError="write protected")
        with self.assertRaisesRegex(ValueError, "blocked"):
            runner.advance(self.journal, FirmwareSSH, skip_uefi=True)


if __name__ == "__main__":
    unittest.main()
