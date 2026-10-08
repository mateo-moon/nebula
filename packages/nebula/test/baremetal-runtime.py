"""Installer and checkpoint recovery tests using isolated host fixtures."""

import copy
import gzip
import json
import subprocess
import tempfile
import types
import unittest
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

    def test_terminal_error_is_persisted_across_pods(self):
        self.journal.save(terminalError=True, lastError="inspection required")
        resumed = runner.Journal(self.api, "default", "host-state", self.request, "hash-123")
        with self.assertRaisesRegex(ValueError, "blocked"):
            runner.advance(resumed, FakeSSH)
        self.assertEqual(FakeSSH.calls, [])

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
