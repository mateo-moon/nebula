"""Exercise UEFI byte updates and recovery on temporary files, never host firmware."""

import copy
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
        for name, value in (
            ("UEFI_ROOT", self.efi),
            ("UEFI_DMI", self.dmi),
            ("UEFI_STATE", self.state),
            ("UEFI_BOOT_ID", self.boot),
        ):
            self.stack.enter_context(patch.object(host, name, value))
        self.stack.enter_context(
            patch.object(
                host.subprocess,
                "run",
                return_value=types.SimpleNamespace(returncode=0, stdout="efivarfs\n"),
            )
        )
        self.prepare = self.stack.enter_context(patch.object(host.efi_boot, "prepare", self.stage))
        self.arm = self.stack.enter_context(patch.object(host.efi_boot, "arm"))
        self.result = self.stack.enter_context(patch.object(host.efi_boot, "execution_result"))
        self.cleanup = self.stack.enter_context(patch.object(host.efi_boot, "cleanup"))
        self.commands = self.stack.enter_context(
            patch.object(host, "command", return_value="loaded")
        )

    def bind(self):
        (self.state / "installed.json").write_text(
            json.dumps(
                {"uid": self.payload["uid"], "fingerprint": installer.fingerprint(self.spec)}
            )
        )

    def stage(self, profile, state, save):
        saved = json.loads((self.state / "uefi-operation.json").read_text())
        self.assertEqual(bytes.fromhex(saved["variables"][0]["before"]), self.original)
        state["efiBoot"] = {
            "directory": "nebula-fixture",
            "bootNumber": "0003",
            "returnBoot": "0000",
            "partUuid": "fixture",
            "bootOrder": "0000",
            "entryHash": "1" * 64,
        }
        save(state)

    def execute(self):
        host.reboot(self.payload)
        self.path.write_bytes(host.desired_blob(self.variable, self.original))
        self.boot.write_text("firmware-boot")

    def test_apply_stages_after_private_backup_without_linux_variable_writes(self):
        with patch.object(host.os, "write", wraps=os.write) as writes:
            result = host.apply(self.payload)
        self.assertTrue(result["changed"])
        self.assertEqual(writes.call_count, 0)
        self.assertEqual(self.path.read_bytes(), self.original)
        saved = self.state / "uefi-operation.json"
        self.assertEqual(saved.stat().st_mode & 0o777, 0o600)
        self.assertFalse(json.loads(saved.read_text())["complete"])
        self.assertFalse(host.verify(self.payload)["verified"])
        self.execute()
        self.assertTrue(host.verify(self.payload)["verified"])
        self.cleanup.assert_called_once()
        self.assertTrue(json.loads(saved.read_text())["complete"])
        changed = {
            i for i, (a, b) in enumerate(zip(self.original, self.path.read_bytes())) if a != b
        }
        self.assertEqual(changed, {5, 8})

    def test_wrong_hardware_size_attributes_or_values_never_prepare(self):
        for mutate in (
            lambda: (self.dmi / "bios_version").write_text("different"),
            lambda: self.path.write_bytes(self.original[:-1]),
            lambda: self.path.write_bytes((39).to_bytes(4, "little") + self.original[4:]),
            lambda: self.path.write_bytes(self.original[:5] + b"\x02" + self.original[6:]),
        ):
            (self.dmi / "bios_version").write_text("1.0")
            self.path.write_bytes(self.original)
            mutate()
            with patch.object(host.efi_boot, "prepare") as prepare, self.assertRaises(ValueError):
                host.apply(self.payload)
            prepare.assert_not_called()
            self.assertFalse((self.state / "uefi-operation.json").exists())

    def test_ambiguous_name_is_rejected_before_preboot_write(self):
        (self.efi / "Setup-00000000-0000-0000-0000-bbbbbbbbbbbb").write_bytes(self.original)
        with (
            patch.object(host.efi_boot, "prepare") as prepare,
            self.assertRaisesRegex(ValueError, "unambiguous"),
        ):
            host.apply(self.payload)
        prepare.assert_not_called()

    def test_late_invalid_variable_blocks_the_whole_operation(self):
        other = copy.deepcopy(self.variable)
        other["name"] = "Second"
        self.spec["installation"]["uefi"]["variables"].append(other)
        (self.efi / host.variable_name(other)).write_bytes(b"invalid")
        self.bind()
        with patch.object(host.efi_boot, "prepare") as prepare, self.assertRaises(ValueError):
            host.apply(self.payload)
        prepare.assert_not_called()
        self.assertEqual(self.path.read_bytes(), self.original)

    def test_backup_failure_prevents_boot_mutation(self):
        with (
            patch.object(host, "save_transaction", side_effect=OSError("disk full")),
            patch.object(host.efi_boot, "prepare") as prepare,
        ):
            with self.assertRaises(OSError):
                host.apply(self.payload)
        prepare.assert_not_called()

    def test_failure_result_is_terminal_retains_backup_and_cleans_boot_intent(self):
        host.apply(self.payload)
        host.reboot(self.payload)
        self.boot.write_text("firmware-boot")
        self.result.side_effect = fixtures.ProvisioningError(
            "setup_var.efi failed: WRITE_PROTECTED"
        )
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "WRITE_PROTECTED"):
                host.verify(self.payload)
        self.cleanup.assert_called_once()
        self.result.assert_called_once()
        state = json.loads((self.state / "uefi-operation.json").read_text())
        self.assertFalse(state["complete"])
        self.assertEqual(bytes.fromhex(state["variables"][0]["before"]), self.original)
        self.assertEqual(self.path.read_bytes(), self.original)
        with self.assertRaisesRegex(ValueError, "WRITE_PROTECTED"):
            host.apply(self.payload)

    def test_success_status_does_not_accept_changed_padding(self):
        host.apply(self.payload)
        self.execute()
        self.path.write_bytes(self.path.read_bytes()[:-1] + b"\x00")
        with self.assertRaisesRegex(ValueError, "complete backed-up layout"):
            host.verify(self.payload)
        self.cleanup.assert_called_once()

    def test_retry_requires_explicit_next_generation_and_preserves_original(self):
        host.apply(self.payload)
        host.reboot(self.payload)
        self.boot.write_text("firmware-boot")
        self.result.side_effect = fixtures.ProvisioningError(
            "setup_var.efi failed: WRITE_PROTECTED"
        )
        with self.assertRaises(ValueError):
            host.verify(self.payload)
        self.payload["firmwareRetryGeneration"] = 2
        with self.assertRaisesRegex(ValueError, "next explicit"):
            host.apply(self.payload)
        self.payload["firmwareRetryGeneration"] = 1
        host.apply(self.payload)
        state = json.loads((self.state / "uefi-operation.json").read_text())
        self.assertEqual(state["bootId"], "firmware-boot")
        self.assertEqual(bytes.fromhex(state["variables"][0]["before"]), self.original)
        self.assertNotIn("rebootRequested", state)

    def test_stale_generation_cannot_arm_or_verify_another_attempt(self):
        self.payload["firmwareRetryGeneration"] = 1
        host.apply(self.payload)
        stale = {**self.payload, "firmwareRetryGeneration": 0}
        for action in (host.reboot, host.verify):
            with self.assertRaisesRegex(ValueError, "another retry generation"):
                action(stale)
        self.arm.assert_not_called()
        self.result.assert_not_called()

    def test_preparation_failure_can_retry_only_with_the_next_generation(self):
        with patch.object(
            host.efi_boot,
            "prepare",
            side_effect=fixtures.ProvisioningError("EFI artifact checksum mismatch"),
        ):
            with self.assertRaisesRegex(ValueError, "checksum mismatch"):
                host.apply(self.payload)
        state = json.loads((self.state / "uefi-operation.json").read_text())
        self.assertTrue(state["cleanupComplete"])
        self.assertEqual(state["variables"][0]["before"], self.original.hex())
        with self.assertRaisesRegex(ValueError, "checksum mismatch"):
            host.apply(self.payload)
        self.payload["firmwareRetryGeneration"] = 1
        host.apply(self.payload)
        self.assertEqual(self.path.read_bytes(), self.original)
        self.assertNotIn("failed", json.loads((self.state / "uefi-operation.json").read_text()))

    def test_completed_execution_can_recheck_capabilities_without_another_reboot(self):
        host.apply(self.payload)
        self.execute()
        host.verify(self.payload)
        self.payload["firmwareRetryGeneration"] = 1
        with patch.object(host.efi_boot, "prepare") as prepare:
            self.assertFalse(host.apply(self.payload)["changed"])
        prepare.assert_not_called()
        self.assertTrue(host.verify(self.payload)["verified"])

    def test_missing_backup_cannot_turn_pending_execution_into_noop(self):
        host.apply(self.payload)
        (self.state / "uefi-operation.json").unlink()
        with self.assertRaisesRegex(ValueError, "backup is missing"):
            host.apply(self.payload)

    def test_installed_receipt_must_match_request(self):
        with self.assertRaisesRegex(ValueError, "not bound"):
            host.apply({**self.payload, "uid": "other"})

    def test_legacy_runtime_transaction_is_not_replayed_as_preboot(self):
        host.apply(self.payload)
        state = json.loads((self.state / "uefi-operation.json").read_text())
        state.pop("backend")
        host.save_transaction(state)
        with self.assertRaisesRegex(ValueError, "Legacy"):
            host.apply(self.payload)

    def test_already_configured_variables_need_no_efi_download_or_reboot(self):
        self.path.write_bytes(host.desired_blob(self.variable, self.original))
        with patch.object(host.efi_boot, "prepare") as prepare:
            self.assertFalse(host.apply(self.payload)["changed"])
        prepare.assert_not_called()
        self.assertFalse(host.reboot(self.payload)["scheduled"])
        self.assertTrue(host.verify(self.payload)["verified"])

    def test_reboot_checkpoint_prevents_duplicate_arming_and_scheduling(self):
        host.apply(self.payload)
        self.assertTrue(host.reboot(self.payload)["scheduled"])
        self.assertTrue(host.reboot(self.payload)["scheduled"])
        self.arm.assert_called_once()
        self.assertEqual(
            sum(a.args[0][0] == "systemd-run" for a in self.commands.call_args_list), 1
        )
        self.commands.return_value = "not-found"
        with self.assertRaisesRegex(ValueError, "checkpoint"):
            host.reboot(self.payload)
        self.arm.assert_called_once()

    def test_failed_checkpoint_never_schedules_reboot(self):
        host.apply(self.payload)
        with (
            patch.object(host, "save_transaction", side_effect=OSError("disk full")),
            self.assertRaises(OSError),
        ):
            host.reboot(self.payload)
        self.assertFalse(self.commands.called)

    def test_effective_kernel_capabilities_gate_verification(self):
        self.spec["installation"]["uefi"]["verification"] = {
            "cpuFlags": ["sev_snp"],
            "moduleParameters": [{"module": "kvm_amd", "parameter": "sev_snp", "value": "Y"}],
        }
        self.bind()
        host.apply(self.payload)
        self.execute()
        module = self.root / "modules/kvm_amd/parameters"
        module.mkdir(parents=True)
        (module / "sev_snp").write_text("N")

        def path(value):
            if value == "/proc/cpuinfo":
                return types.SimpleNamespace(read_text=lambda: "flags : sev sev_snp\n")
            if value == "/sys/module":
                return self.root / "modules"
            return Path(value)

        with patch.object(host, "Path", path):
            with self.assertRaisesRegex(ValueError, "kernel module verification"):
                host.verify(self.payload)
            (module / "sev_snp").write_text("Y")
            self.assertTrue(host.verify(self.payload)["verified"])


class EfiBootTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.esp, self.vars = self.root / "esp", self.root / "vars"
        (self.esp / "EFI").mkdir(parents=True)
        self.vars.mkdir()
        self.boot = host.efi_boot
        self.stack.enter_context(patch.object(self.boot, "ESP", self.esp))
        self.stack.enter_context(patch.object(self.boot, "VARIABLES", self.vars))
        self.stack.enter_context(
            patch.object(
                self.boot,
                "esp_identity",
                return_value=("/dev/vda", "1", "00000000-0000-0000-0000-aaaaaaaaaaaa"),
            )
        )
        self.stack.enter_context(
            patch.object(self.boot.shutil, "which", return_value="/usr/bin/efibootmgr")
        )
        self.write_variable("SecureBoot", b"\x00")
        self.write_variable("BootCurrent", b"\x00\x00")
        self.write_variable("BootOrder", b"\x02\x00\x00\x00")
        self.state = {
            "uid": "fixture",
            "fingerprint": "fingerprint",
            "bootId": "source",
            "variables": [],
            "complete": False,
            "changed": True,
        }
        self.snapshots = []
        self.calls = []

    def write_variable(self, name, value):
        (self.vars / (name + "-" + self.boot.GLOBAL_GUID)).write_bytes(b"\x07\x00\x00\x00" + value)

    def save(self, state):
        self.snapshots.append(copy.deepcopy(state))

    def command(self, args):
        self.calls.append(args)
        if args[0] == "efibootmgr" and "--create-only" in args:
            self.assertIn("efiBoot", self.snapshots[-1])
            self.write_variable("Boot" + self.state["efiBoot"]["bootNumber"], b"fixture-entry")
        if args == ["efibootmgr", "--verbose"]:
            i = self.state["efiBoot"]
            return f"Boot{i['bootNumber']}* {i['directory']} HD(1,GPT,{i['partUuid']},0,1)/File(\\EFI\\{i['directory']}\\Shell.efi)"
        if "--bootnext" in args:
            self.write_variable("BootNext", int(args[-1], 16).to_bytes(2, "little"))
        if "--delete-bootnum" in args:
            (self.vars / ("Boot" + args[2] + "-" + self.boot.GLOBAL_GUID)).unlink()
        return ""

    def prepare(self):
        def download(path):
            path.write_bytes(b"fixture artifact")

        with (
            patch.object(self.boot, "fetch_artifact", download),
            patch.object(self.boot, "command", self.command),
        ):
            self.boot.prepare(UEFI, self.state, self.save)

    def test_staging_binds_partition_and_preserves_boot_order(self):
        self.prepare()
        intent = self.state["efiBoot"]
        self.assertIn("entryHash", intent)
        self.assertEqual(self.boot.global_value("BootOrder"), b"\x02\x00\x00\x00")
        self.assertIsNone(self.boot.global_value("BootNext"))
        path = self.esp / "EFI" / intent["directory"]
        script = (path / "startup.nsh").read_text()
        self.assertIn("--write_on_demand Setup:0x1(1)=0x1 Setup:0x4(4)=0x63", script)
        self.assertIn("setvar BootNext -guid " + self.boot.GLOBAL_GUID, script)
        self.assertIn("=H0000", script)
        self.assertIn("rm %f:", script)
        self.assertIn("once.flag", script)
        self.assertNotIn("rm %f:" + "\\EFI\\" + intent["directory"] + "\\startup.nsh", script)
        with patch.object(self.boot, "command", self.command):
            self.boot.arm(intent)
        self.assertEqual(
            self.boot.global_value("BootNext"), int(intent["bootNumber"], 16).to_bytes(2, "little")
        )

    def test_secure_boot_or_foreign_bootnext_refuses_staging(self):
        for name, value in [("SecureBoot", b"\x01"), ("BootNext", b"\xff\x00")]:
            self.write_variable("SecureBoot", b"\x00")
            self.write_variable(name, value)
            with patch.object(self.boot, "command") as commands, self.assertRaises(ValueError):
                self.boot.prepare(UEFI, self.state, self.save)
            commands.assert_not_called()
            self.assertEqual(self.state.get("efiBoot"), None)

    def test_ownership_change_does_not_arm_or_delete_entry(self):
        self.prepare()
        intent = self.state["efiBoot"]
        self.write_variable("Boot" + intent["bootNumber"], b"foreign-entry")
        with patch.object(self.boot, "command", self.command):
            for action in (
                lambda: self.boot.arm(intent),
                lambda: self.boot.cleanup(intent, self.root / "archive"),
            ):
                with self.assertRaisesRegex(ValueError, "changed after staging"):
                    action()
        self.assertFalse(any("--bootnext" in a or "--delete-bootnum" in a for a in self.calls))

    def test_efi_failure_is_sanitized_and_logs_are_archived_privately(self):
        self.prepare()
        intent = self.state["efiBoot"]
        path = self.esp / "EFI" / intent["directory"]
        (path / "status.log").write_text(
            "marker=" + intent["directory"] + "\r\nreturnStatus=0x0\r\napplyStatus=0x15\r\n",
            encoding="utf-16",
        )
        (path / "apply.log").write_text(
            "private variable contents WRITE_PROTECTED", encoding="utf-16"
        )
        with self.assertRaisesRegex(ValueError, "setup_var.efi failed: WRITE_PROTECTED") as raised:
            self.boot.execution_result(intent)
        self.assertNotIn("private", str(raised.exception))
        with patch.object(self.boot, "command", self.command):
            self.boot.cleanup(intent, self.root / "archive")
        self.assertFalse(path.exists())
        self.assertEqual((self.root / "archive/apply.log").stat().st_mode & 0o777, 0o600)
        self.assertIsNone(self.boot.global_value("Boot" + intent["bootNumber"]))

    def test_success_requires_both_helper_and_return_boot_success(self):
        self.prepare()
        intent = self.state["efiBoot"]
        path = self.esp / "EFI" / intent["directory"]
        for marker, result, returned in [
            (intent["directory"], "0x0", "0x0"),
            ("foreign", "0x0", "0x0"),
            (intent["directory"], "0x0", "0x15"),
        ]:
            (path / "status.log").write_text(
                f"marker={marker}\r\nreturnStatus={returned}\r\napplyStatus={result}\r\n",
                encoding="utf-16",
            )
            if marker == intent["directory"] and returned == "0x0":
                self.boot.execution_result(intent)
            else:
                with self.assertRaises(ValueError):
                    self.boot.execution_result(intent)

    def test_checksum_failure_never_promotes_download(self):
        target = self.esp / "setup_var.efi"

        def download(args):
            Path(args[args.index("--output") + 1]).write_bytes(b"tampered executable")
            return ""

        with (
            patch.object(self.boot, "command", download),
            self.assertRaisesRegex(ValueError, "checksum mismatch"),
        ):
            self.boot.fetch_artifact(target)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".download").exists())


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
