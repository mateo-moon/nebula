"""Installer and checkpoint recovery tests using isolated host fixtures."""

import copy
import errno
import gzip
import io
import json
import subprocess
import tempfile
import types
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import patch

from baremetal_fixtures import (
    FACTS,
    SPEC,
    FakeAPI,
    FakeSSH,
    host_agent,
    installer,
    runner,
    storage,
    transport,
)


class Qualification(unittest.TestCase):
    def setUp(self):
        FakeSSH.installed, FakeSSH.crash_commit, FakeSSH.calls, FakeSSH.original_boot = (
            False,
            False,
            [],
            "source-boot",
        )
        self.request = {"uid": "request-123", "spec": copy.deepcopy(SPEC)}
        self.api = FakeAPI(
            {
                "metadata": {"resourceVersion": "1"},
                "data": {"uid": "request-123", "requestHash": "hash-123"},
            }
        )
        self.journal = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")

    def step(self, clock=lambda: 100):
        return runner.advance(self.journal, FakeSSH, clock)

    def test_job_restart_resumes_without_installing_twice(self):
        for _ in range(2):
            self.step()
        self.assertEqual(self.journal.status["phase"], "Staged")
        FakeSSH.crash_commit = True
        with self.assertRaises(RuntimeError):
            self.step()
        self.assertEqual(self.api.resource["data"]["phase"], "Installing")
        FakeSSH.crash_commit = False
        self.journal = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
        self.step()
        self.assertEqual(FakeSSH.calls.count("stage"), 1)
        FakeSSH.installed = True
        self.assertTrue(self.step())
        self.assertEqual(self.journal.status["phase"], "OSReady")
        self.assertEqual(self.api.resource["data"]["verifiedRequestHash"], "hash-123")
        self.assertTrue(self.step())
        self.assertEqual(FakeSSH.calls.count("stage"), 1)
        self.assertEqual(FakeSSH.calls.count("commit"), 2)
        self.assertTrue(
            all(
                path == "/api/v1/namespaces/default/configmaps/host-state"
                for _, path in self.api.actions
            )
        )

    def test_changed_profile_deadline_and_unknown_boot_never_reinstall(self):
        for _ in range(3):
            self.step()
        FakeSSH.original_boot = "unexpected-reboot"
        self.step()
        self.assertEqual(FakeSSH.calls.count("commit"), 1)
        with self.assertRaisesRegex(ValueError, "deadline"):
            self.step(lambda: 5000)
        self.request["spec"]["installation"]["rootSizeGiB"] = 20
        with self.assertRaisesRegex(ValueError, "changed"):
            self.step()
        self.assertEqual(FakeSSH.calls.count("stage"), 1)

    def test_management_binding_loss_fails_closed(self):
        class InstalledSSH(FakeSSH):
            def call(self, *args, **kwargs):
                return {"installed": {"uid": "old-request"}}

        with self.assertRaisesRegex(ValueError, "restore management state"):
            runner.advance(self.journal, InstalledSSH)
        for field in ("uid", "requestHash"):
            previous = self.api.resource["data"][field]
            self.api.resource["data"][field] = "foreign"
            with self.assertRaisesRegex(ValueError, "another request"):
                runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
            self.api.resource["data"][field] = previous
        self.assertEqual(FakeSSH.calls, [])

    def test_concurrent_journal_update_cannot_commit(self):
        for _ in range(2):
            self.step()
        self.api.resource["metadata"]["resourceVersion"] = "99"
        with self.assertRaisesRegex(RuntimeError, "conflict"):
            self.step()
        self.assertNotIn("commit", FakeSSH.calls)

    def test_diagnostics_survive_pod_restart_without_private_payloads(self):
        self.request["spec"]["installation"]["mirror"]["hostname"] = "private-mirror-fixture"
        with redirect_stdout(io.StringIO()) as output:
            self.step()
            self.step()
            self.step()
            self.step(lambda: 130)
        resumed = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
        events = resumed.status["events"]
        self.assertEqual(
            [event["event"] for event in events[:4]], ["phase-changed"] * 3 + ["kexec-scheduled"]
        )
        self.assertEqual(events[0]["sourceBootId"], "source-boot")
        self.assertEqual(events[-2]["event"], "waiting-for-installed-ssh")
        self.assertEqual(events[-2]["at"], 130)
        self.assertNotIn("private-mirror-fixture", output.getvalue())
        self.assertNotIn("knownHosts", json.dumps(events))
        self.assertNotIn("ssh-ed25519", json.dumps(events))
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()], events)

    def test_connectivity_diagnostics_are_throttled_and_bounded_after_restart(self):
        with redirect_stdout(io.StringIO()):
            self.journal.diagnostic("waiting-for-installed-ssh", 100, error="SSH unavailable")
            actions = len(self.api.actions)
            resumed = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
            resumed.diagnostic("waiting-for-installed-ssh", 115, error="SSH unavailable")
            self.assertEqual(len(self.api.actions), actions + 1)  # refresh only
            for at in range(160, 160 + 60 * 140, 60):
                resumed.diagnostic(
                    "waiting-for-installed-ssh",
                    at,
                    error="SSH unavailable",
                    password="private-password-fixture",
                    privateKey="private-key-fixture",
                )
        events = resumed.status["events"]
        self.assertEqual(len(events), runner.MAX_DIAGNOSTIC_EVENTS)
        self.assertNotIn("private-", json.dumps(events))

    def test_unacknowledged_diagnostic_is_not_reported_as_persisted(self):
        self.api.resource["metadata"]["resourceVersion"] = "99"
        with redirect_stdout(io.StringIO()) as output, self.assertRaises(RuntimeError):
            self.journal.diagnostic("waiting-for-installed-ssh", 100)
        self.assertEqual(output.getvalue(), "")
        self.assertNotIn("events", self.journal.status)

    def test_terminal_error_is_persisted_across_pods(self):
        self.journal.save(terminalError=True, lastError="inspection required")
        resumed = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
        with self.assertRaisesRegex(ValueError, "blocked"):
            runner.advance(resumed, FakeSSH)
        self.assertEqual(FakeSSH.calls, [])

    def test_blocked_restart_preserves_the_original_terminal_diagnostic(self):
        original = "SSH uefi-apply failed: host operation failed: OSError (EROFS, errno 30)"
        self.journal.save(terminalError=True, lastError=original)
        resumed = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
        actions = len(self.api.actions)
        with self.assertRaises(ValueError) as blocked:
            runner.advance(resumed, FakeSSH)
        with redirect_stdout(io.StringIO()) as output:
            self.assertTrue(runner.record_error(resumed, blocked.exception))
        self.assertEqual(json.loads(output.getvalue())["error"], original)
        self.assertEqual(resumed.status["lastError"], original)
        self.assertEqual(len(self.api.actions), actions)
        self.assertEqual(FakeSSH.calls, [])

    def test_host_error_retains_errno_without_private_exception_details(self):
        for code in (errno.EINVAL, errno.EROFS, errno.ENOSPC, errno.EIO):
            with self.subTest(errno=code):
                error = OSError(code, "private payload", "/private/credential")
                with (
                    patch.object(host_agent.sys, "argv", ["agent", "uefi-apply"]),
                    patch.object(host_agent.sys, "stdin", io.StringIO("{}")),
                    patch.object(host_agent.os, "geteuid", return_value=0),
                    patch.object(host_agent.os, "umask"),
                    patch.object(host_agent, "dispatch", side_effect=error),
                    redirect_stdout(io.StringIO()) as output,
                    self.assertRaises(SystemExit),
                ):
                    host_agent.main()
                response = json.loads(output.getvalue())
                self.assertTrue(response["terminal"])
                self.assertIn(errno.errorcode[code], response["error"])
                self.assertIn(f"errno {code}", response["error"])
                self.assertNotIn("private", response["error"])

    def test_mounted_keys_stay_private_and_pinned_trust_cannot_fall_back_to_tofu(self):
        with tempfile.TemporaryDirectory() as tmp:
            credentials = Path(tmp) / "credentials"
            scratch = Path(tmp) / "scratch"
            scratch.mkdir()
            for name in ("initial", "worker", "known-hosts"):
                (credentials / name).mkdir(parents=True)
                (credentials / name / "value").write_text(
                    "fixture" if name != "known-hosts" else ""
                )
            host = {"spec": copy.deepcopy(SPEC), "metadata": {"uid": "request-123"}}
            host["spec"]["ssh"].pop("trustOnFirstUse")
            host["spec"]["ssh"]["knownHostsSecretName"] = "pinned"
            with self.assertRaisesRegex(ValueError, "empty"):
                runner.SSH(host, scratch, credentials)
            (credentials / "known-hosts" / "value").write_text("bm-192-0-2-10 ssh-ed25519 AAAA\n")
            ssh = runner.SSH(host, scratch, credentials)
            self.assertTrue(ssh.strict)
            self.assertEqual((scratch / "initial").stat().st_mode & 0o777, 0o600)
            host["status"] = {"phase": "Installing"}
            with self.assertRaisesRegex(ValueError, "recorded SSH host keys"):
                runner.SSH(host, scratch, credentials)

    def test_disk_selection_rejects_ambiguity_and_small_disks(self):
        disk = {"type": "disk", "path": "/dev/vda", "size": 64 * 1024**3, "serial": "first"}
        other = {**disk, "path": "/dev/vdb", "serial": "second"}
        policy = {"minSizeGiB": 32}
        self.assertEqual(installer.select_disk([disk, other], {"/dev/vda"}, policy), disk)
        with self.assertRaises(ValueError):
            installer.select_disk([disk, other], {"/dev/vda", "/dev/vdb"}, policy)
        with self.assertRaises(ValueError):
            installer.select_disk([{**disk, "size": 1024}], {"/dev/vda"}, policy)
        self.assertEqual(
            installer.select_disk([disk, other], set(), {**policy, "serial": "second"}), other
        )

    def test_rescue_root_does_not_require_a_block_device(self):
        for kind in ("overlay", "tmpfs", "ramfs"):
            with patch.object(
                storage,
                "json_command",
                return_value={"filesystems": [{"source": kind, "fstype": kind}]},
            ) as query:
                self.assertEqual(storage.root_devices(), [])
                self.assertEqual(query.call_count, 1)

    def test_rescue_cleanup_rejects_shared_mounted_and_ambiguous_storage(self):
        array = {"path": "/dev/md0", "type": "raid0", "mountpoints": [None]}
        first = {
            "path": "/dev/vda",
            "type": "disk",
            "serial": "first",
            "children": [{"path": "/dev/vda1", "type": "part", "children": [array]}],
        }
        second = {
            "path": "/dev/vdb",
            "type": "disk",
            "serial": "second",
            "children": [{"path": "/dev/vdb1", "type": "part", "children": [array]}],
        }
        devices = [first, second]
        with self.assertRaisesRegex(ValueError, "outside"):
            storage.cleanup_plan(devices, ["first"])
        plan = storage.cleanup_plan(devices, ["first", "second"])
        self.assertEqual(plan.arrays, ("/dev/md0",))
        self.assertEqual(plan.partitions, ("/dev/vda1", "/dev/vdb1"))
        for mounted in ("/data", "[SWAP]"):
            array["mountpoints"] = [mounted]
            with self.assertRaisesRegex(ValueError, "mounted"):
                storage.cleanup_plan(devices, ["first", "second"])
        array["mountpoints"] = [None]
        for signature in ("LVM2_member", "crypto_LUKS"):
            first["children"][0]["fstype"] = signature
            with self.assertRaisesRegex(ValueError, "signatures"):
                storage.cleanup_plan(devices, ["first", "second"])
        first["children"][0].pop("fstype")
        with self.assertRaisesRegex(ValueError, "resolve"):
            storage.cleanup_plan(devices, ["missing"])
        with self.assertRaisesRegex(ValueError, "resolve"):
            storage.cleanup_plan([first, {**second, "serial": "first"}], ["first"])
        with self.assertRaisesRegex(ValueError, "holders"):
            storage.reject_unapproved_holders(devices, "/dev/vda")

    def test_cleanup_requires_rescue_and_loaded_kernel_then_only_writes_selected_devices(self):
        devices = [
            {
                "path": "/dev/vda",
                "type": "disk",
                "serial": "first",
                "children": [
                    {
                        "path": "/dev/vda1",
                        "type": "part",
                        "children": [{"path": "/dev/md0", "type": "raid0"}],
                    }
                ],
            },
            {"path": "/dev/vdb", "type": "disk", "serial": "untouched"},
        ]
        with (
            patch.object(storage, "root_devices", return_value=[]) as root,
            patch.object(storage, "inventory", return_value=devices),
            patch.object(storage.Path, "read_text", return_value="1") as loaded,
            patch.object(storage, "command") as execute,
        ):
            root.return_value = [{"path": "/dev/vda"}]
            with self.assertRaisesRegex(ValueError, "rescue"):
                storage.erase_from_rescue(["first"])
            root.return_value = []
            loaded.return_value = "0"
            with self.assertRaisesRegex(ValueError, "loaded replacement"):
                storage.erase_from_rescue(["first"])
            execute.assert_not_called()
            loaded.return_value = "1"
            storage.erase_from_rescue(["first"])
        self.assertEqual(
            [call.args[0] for call in execute.call_args_list],
            [
                ["mdadm", "--stop", "/dev/md0"],
                ["wipefs", "--all", "/dev/vda1"],
                ["wipefs", "--all", "/dev/vda"],
                ["udevadm", "settle"],
            ],
        )

    def test_inactive_raid_members_cannot_hide_shared_or_missing_disks(self):
        def disk(path, serial):
            return {
                "path": path,
                "type": "disk",
                "serial": serial,
                "children": [
                    {
                        "path": path + "1",
                        "type": "part",
                        "fstype": "linux_raid_member",
                        "raidUuid": "array-id",
                        "raidDevices": 2,
                    }
                ],
            }

        devices = [disk("/dev/vda", "first"), disk("/dev/vdb", "second")]
        with self.assertRaisesRegex(ValueError, "outside"):
            storage.cleanup_plan(devices, ["first"])
        with self.assertRaisesRegex(ValueError, "missing"):
            storage.cleanup_plan(devices[:1], ["first"])
        self.assertEqual(storage.cleanup_plan(devices, ["first", "second"]).arrays, ())

    def test_other_disks_cannot_be_erased_through_a_shared_volume_group(self):
        installer.validate_volume_groups(
            "/dev/vda", {"source": {"/dev/vda"}, "data": {"/dev/vdb"}}, "worker-vg"
        )
        with self.assertRaisesRegex(ValueError, "shares"):
            installer.validate_volume_groups(
                "/dev/vda", {"source": {"/dev/vda", "/dev/vdb"}}, "worker-vg"
            )
        with self.assertRaisesRegex(ValueError, "another disk"):
            installer.validate_volume_groups("/dev/vda", {"worker-vg": {"/dev/vdb"}}, "worker-vg")

    def test_installer_network_seed_and_private_cpio(self):
        files = installer.render_files(SPEC, FACTS, "ssh-ed25519 AAAA", {"uid": "test"})
        self.assertIn(b"preseed/late_command", files["preseed.cfg"])
        self.assertIn(b"2001:db8::10/64", files["nebula/uplink.network"])
        self.assertIn(b"Gateway=fe80::1", files["nebula/uplink.network"])
        self.assertNotIn(b"passwd -d", files["nebula/late.sh"])
        self.assertNotIn(b"partman-auto-lvm/guided_size string max", files["preseed.cfg"])
        self.assertIn(
            b"chmod 0644 /target/etc/systemd/network/10-nebula.network", files["nebula/late.sh"]
        )
        password_lines = [
            line
            for line in files["preseed.cfg"].decode().splitlines()
            if line.startswith("d-i passwd/root-password")
        ]
        self.assertEqual(len(password_lines), 2)
        self.assertEqual(password_lines[0].split()[-1], password_lines[1].split()[-1])
        self.assertGreater(len(password_lines[0].split()[-1]), 48)
        self.assertNotIn(b"k0s install", b"".join(files.values()))
        with tempfile.TemporaryDirectory() as tmp:
            for name, data in files.items():
                if name.endswith(".sh"):
                    target = Path(tmp) / Path(name).name
                    target.write_bytes(data)
                    subprocess.run(["sh", "-n", str(target)], check=True)
        archive = installer.cpio(
            {**files, "nebula/hostkeys/ssh_host_ed25519_key": b"private-test-payload"}
        )
        pos, unpacked = 0, {}
        while True:
            self.assertEqual(archive[pos : pos + 6], b"070701")
            fields = [int(archive[pos + 6 + i * 8 : pos + 14 + i * 8], 16) for i in range(13)]
            pos += 110
            name = archive[pos : pos + fields[11] - 1].decode()
            pos = (pos + fields[11] + 3) // 4 * 4
            content = archive[pos : pos + fields[6]]
            pos = (pos + fields[6] + 3) // 4 * 4
            if name == "TRAILER!!!":
                break
            if fields[1] & 0o170000 == 0o100000:
                self.assertEqual(fields[1] & 0o777, 0o600)
                unpacked[name] = content
        self.assertEqual(unpacked["preseed.cfg"], files["preseed.cfg"])
        self.assertEqual(gzip.decompress(gzip.compress(archive)), archive)

    def test_bootstrap_shell_is_valid(self):
        subprocess.run(["sh", "-n"], input=transport.BOOTSTRAP, text=True, check=True)

    def test_additional_workload_disks_use_stable_identity_and_require_explicit_erasure(self):
        spec, facts = copy.deepcopy(SPEC), copy.deepcopy(FACTS)
        spec["installation"]["disk"].update(
            {
                "serial": "os-disk",
                "eraseSerials": ["os-disk", "data-one", "data-two"],
                "workloadSerials": ["data-one", "data-two"],
            }
        )
        facts["workloadDisks"] = [
            {"serial": serial, "byId": "/dev/disk/by-id/virtio-" + serial, "size": 64 * 1024**3}
            for serial in ("data-one", "data-two")
        ]
        files = installer.render_files(spec, facts, "ssh-ed25519 AAAA", {"uid": "test"})
        script = files["nebula/late.sh"].decode()
        self.assertEqual(script.count('in-target vgextend worker-vg "$disk"'), 2)
        self.assertEqual(script.count('in-target pvcreate --yes "$disk"'), 2)
        self.assertNotIn("virtio-os-disk", script)
        subprocess.run(["sh", "-n"], input=script, text=True, check=True)
        for serials in (["not-authorized"], ["os-disk"], ["data-one", "data-one"]):
            spec["installation"]["disk"]["workloadSerials"] = serials
            with self.assertRaisesRegex(ValueError, "additional erased"):
                installer.render_files(spec, facts, "ssh-ed25519 AAAA", {"uid": "test"})
        spec["installation"]["disk"]["workloadSerials"] = ["data-one", "data-two"]
        facts["workloadDisks"].pop()
        with self.assertRaisesRegex(ValueError, "discovery differs"):
            installer.render_files(spec, facts, "ssh-ed25519 AAAA", {"uid": "test"})

    def test_worker_handoff_requires_every_declared_disk_in_the_workload_group(self):
        def query(args):
            if args[0] == "pvs":
                return {
                    "report": [
                        {
                            "pv": [
                                {"pv_name": "/dev/vda3", "vg_name": "worker-vg"},
                                {"pv_name": "/dev/vdb", "vg_name": "worker-vg"},
                            ]
                        }
                    ]
                }
            return {
                "blockdevices": [
                    {
                        "type": "disk",
                        "serial": "os" if args[-1] == "/dev/vda3" else "data",
                    }
                ]
            }

        with patch.object(storage, "json_command", side_effect=query):
            storage.verify_volume_group("worker-vg", {"os", "data"})
            with self.assertRaisesRegex(ValueError, "exactly the declared"):
                storage.verify_volume_group("worker-vg", {"os", "data", "missing"})

    def test_installed_storage_must_match_before_capi_handoff(self):
        receipt = {
            "uid": "request-123",
            "fingerprint": installer.fingerprint(SPEC),
            "sourceBootId": "source-boot",
        }
        responses = {
            "/var/lib/nebula-baremetal/installed.json": json.dumps(receipt),
            "/etc/os-release": "ID=debian\nVERSION_CODENAME=trixie\n",
        }

        def fake_path(name):
            return types.SimpleNamespace(read_text=lambda: responses[name])

        def command(args):
            if args[0] == "cat":
                return "installed-boot"
            if args[0] == "vgs":
                return str(free_bytes)
            if args[0] == "lvs":
                return str(root_bytes)
            return "active"

        addresses = [
            {
                "addr_info": [
                    {"family": "inet", "scope": "global", "local": "192.0.2.10"},
                    {"family": "inet6", "scope": "global", "local": "2001:db8::10"},
                ]
            }
        ]
        with (
            patch.object(host_agent, "Path", fake_path),
            patch.object(host_agent, "command", command),
            patch.object(host_agent, "json_command", lambda args: addresses),
            patch.object(host_agent.platform, "node", lambda: SPEC["hostname"]),
        ):
            free_bytes, root_bytes = 16 * 1024**3, 16 * 1024**3
            self.assertTrue(host_agent.verify({"uid": "request-123", "spec": SPEC})["verified"])
            free_bytes, root_bytes = 0, 32 * 1024**3
            with self.assertRaisesRegex(ValueError, "storage"):
                host_agent.verify({"uid": "request-123", "spec": SPEC})

    def test_corrupt_download_never_becomes_a_boot_artifact(self):
        with tempfile.TemporaryDirectory() as temporary:
            destination = Path(temporary) / "kernel"

            def download(args):
                self.assertIn("=https", args)
                self.assertIn("--max-filesize", args)
                Path(args[args.index("--output") + 1]).write_bytes(b"corrupt download")

            with (
                patch.object(host_agent, "command", download),
                self.assertRaisesRegex(ValueError, "checksum"),
            ):
                host_agent.fetch_artifact(SPEC["installation"]["kernel"], destination)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_suffix(".download").exists())


if __name__ == "__main__":
    unittest.main()
