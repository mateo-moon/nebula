import copy
import gzip
import ipaddress
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/modules/infra/baremetal"))
import controller
import installer

host_agent = types.ModuleType("host_agent")
source = Path(installer.__file__).parent
exec(compile((source / "installer.py").read_text() + "\n" + (source / "host.py").read_text(), "host_agent", "exec"), host_agent.__dict__)

SPEC = {
    "address": "192.0.2.10", "hostname": "bm-192-0-2-10",
    "ssh": {"user": "root", "port": 22, "secretName": "initial", "workerSecretName": "worker", "trustOnFirstUse": True},
    "installation": {"suite": "trixie", "mirror": {"hostname": "deb.debian.org", "directory": "/debian"},
        "kernel": {"url": "https://images.example.test/kernel", "sha256": "1" * 64},
        "initrd": {"url": "https://images.example.test/initrd", "sha256": "2" * 64},
        "disk": {"minSizeGiB": 32}, "rootSizeGiB": 16, "volumeGroup": "worker-vg", "timeoutSeconds": 3600, "dualStack": True},
    "enrollment": [{"apiVersion": version, "kind": kind, "metadata": {"name": "bm-192-0-2-10", "namespace": "default"}, "spec": {}}
                   for kind, (version, _) in list(controller.KINDS.items())[:4]],
}
FACTS = {"bootId": "source-boot", "uefi": True, "disk": {"byId": "/dev/disk/by-id/virtio-test"},
         "network": {"mac": "02:00:00:00:00:10", "addresses": ["192.0.2.10/24", "2001:db8::10/64"],
                     "routes": [{"destination": "0.0.0.0/0", "gateway": "192.0.2.1"}, {"destination": "::/0", "gateway": "fe80::1"}], "dns": ["192.0.2.53"]}}


class FakeAPI:
    def __init__(self, host):
        self.host, self.objects, self.actions = copy.deepcopy(host), {}, []

    def request(self, method, path, value=None, content_type=None):
        self.actions.append((method, path))
        if "sshbaremetalhosts/" in path:
            if method == "PATCH":
                if value["metadata"]["resourceVersion"] != self.host["metadata"]["resourceVersion"]:
                    raise RuntimeError("conflict")
                self.host["metadata"]["resourceVersion"] = str(int(self.host["metadata"]["resourceVersion"]) + 1)
                if "status" in value:
                    self.host["status"] = copy.deepcopy(value["status"])
                if "finalizers" in value["metadata"]:
                    self.host["metadata"]["finalizers"] = value["metadata"]["finalizers"]
            return copy.deepcopy(self.host)
        key = path.split("?", 1)[0]
        if method == "GET":
            return copy.deepcopy(self.objects.get(key))
        self.objects[key] = copy.deepcopy(value)
        return copy.deepcopy(value)


class FakeSSH:
    installed, crash_commit, calls, original_boot = False, False, [], "source-boot"

    def __init__(self, *args):
        pass

    def public_key(self):
        return "ssh-ed25519 AAAA"

    def known_hosts(self):
        return "bm-192-0-2-10 ssh-ed25519 AAAA\n"

    def call(self, action, **kwargs):
        self.calls.append(action)
        if action == "verify":
            if not self.installed:
                raise RuntimeError("not yet installed")
            return {"verified": True, "addresses": ["192.0.2.10", "2001:db8::10"]}
        if action == "probe":
            return {**copy.deepcopy(FACTS), "bootId": self.original_boot}
        if action == "commit" and self.crash_commit:
            raise RuntimeError("controller stopped before commit")
        return {}


class Qualification(unittest.TestCase):
    def setUp(self):
        FakeSSH.installed, FakeSSH.crash_commit, FakeSSH.calls, FakeSSH.original_boot = False, False, [], "source-boot"
        self.host = {"metadata": {"name": SPEC["hostname"], "namespace": "default", "uid": "request-123", "resourceVersion": "1", "generation": 1}, "spec": copy.deepcopy(SPEC)}
        self.api = FakeAPI(self.host)

    def step(self, clock=lambda: 100):
        controller.reconcile(self.api, self.host, FakeSSH, clock)

    def test_no_pool_before_verified_os_and_resume_after_crash(self):
        for _ in range(3):
            self.step()
        self.assertEqual(self.host["status"]["phase"], "Staged")
        FakeSSH.crash_commit = True
        with self.assertRaises(RuntimeError):
            self.step()
        self.assertEqual(self.host["status"]["phase"], "Installing")
        self.assertEqual(self.api.objects, {})
        FakeSSH.crash_commit = False
        self.step()
        self.assertEqual(FakeSSH.calls.count("stage"), 1)
        self.assertEqual(self.api.objects, {})
        FakeSSH.installed = True
        self.step()
        self.assertEqual(self.host["status"]["phase"], "OSReady")
        self.step()
        self.assertEqual(len(self.api.objects), 4)
        self.assertEqual(self.host["status"]["phase"], "Enrolling")
        self.step()
        self.assertEqual(FakeSSH.calls.count("stage"), 1)
        self.assertEqual(FakeSSH.calls.count("commit"), 2)

    def test_changed_profile_deadline_and_unknown_boot_never_reinstall(self):
        for _ in range(4):
            self.step()
        FakeSSH.original_boot = "unexpected-reboot"
        self.step()
        self.assertEqual(FakeSSH.calls.count("commit"), 1)
        with self.assertRaisesRegex(ValueError, "deadline"):
            self.step(lambda: 5000)
        self.host["spec"]["installation"]["rootSizeGiB"] = 20
        with self.assertRaisesRegex(ValueError, "changed"):
            self.step()
        self.assertEqual(FakeSSH.calls.count("stage"), 1)
        self.assertEqual(self.api.objects, {})

    def test_management_binding_loss_fails_closed(self):
        self.step()
        class InstalledSSH(FakeSSH):
            def call(self, *args, **kwargs):
                return {"installed": {"uid": "old-request"}}
        with self.assertRaisesRegex(ValueError, "restore management state"):
            controller.reconcile(self.api, self.host, InstalledSSH)
        self.assertEqual(self.api.objects, {})

    def test_deletion_retains_host_and_existing_enrollment(self):
        self.host["metadata"]["deletionTimestamp"] = "2026-01-01T00:00:00Z"
        self.step()
        self.assertEqual(self.api.actions, [])
        self.assertEqual(FakeSSH.calls, [])

    def test_reserved_pool_and_foreign_resources_cannot_be_overwritten(self):
        pool = SPEC["enrollment"][0]
        path = "/apis/infrastructure.cluster.x-k8s.io/v1beta2/namespaces/default/pooledremotemachines/" + SPEC["hostname"]
        self.api.objects[path] = copy.deepcopy(pool)
        with self.assertRaisesRegex(ValueError, "another request"):
            controller.apply_bound(self.api, pool, self.host)
        self.api.objects[path]["metadata"]["annotations"] = {controller.BINDING: "request-123"}
        self.api.objects[path]["status"] = {"reserved": True}
        changed = copy.deepcopy(pool)
        changed["spec"] = {"machine": {"address": "198.51.100.20"}}
        with self.assertRaisesRegex(ValueError, "reserved"):
            controller.apply_bound(self.api, changed, self.host)

    def test_disk_selection_rejects_ambiguity_and_small_disks(self):
        disk = {"type": "disk", "path": "/dev/vda", "size": 64 * 1024**3, "serial": "first"}
        other = {**disk, "path": "/dev/vdb", "serial": "second"}
        policy = {"minSizeGiB": 32}
        self.assertEqual(installer.select_disk([disk, other], {"/dev/vda"}, policy), disk)
        with self.assertRaises(ValueError):
            installer.select_disk([disk, other], {"/dev/vda", "/dev/vdb"}, policy)
        with self.assertRaises(ValueError):
            installer.select_disk([{**disk, "size": 1024}], {"/dev/vda"}, policy)
        self.assertEqual(installer.select_disk([disk, other], set(), {**policy, "serial": "second"}), other)

    def test_other_disks_cannot_be_erased_through_a_shared_volume_group(self):
        installer.validate_volume_groups("/dev/vda", {"source": {"/dev/vda"}, "data": {"/dev/vdb"}}, "worker-vg")
        with self.assertRaisesRegex(ValueError, "shares"):
            installer.validate_volume_groups("/dev/vda", {"source": {"/dev/vda", "/dev/vdb"}}, "worker-vg")
        with self.assertRaisesRegex(ValueError, "another disk"):
            installer.validate_volume_groups("/dev/vda", {"worker-vg": {"/dev/vdb"}}, "worker-vg")

    def test_installer_network_seed_and_private_cpio(self):
        files = installer.render_files(SPEC, FACTS, "ssh-ed25519 AAAA", {"uid": "test"})
        self.assertIn(b"preseed/late_command", files["preseed.cfg"])
        self.assertIn(b"2001:db8::10/64", files["nebula/uplink.network"])
        self.assertIn(b"Gateway=fe80::1", files["nebula/uplink.network"])
        self.assertNotIn(b"passwd -d", files["nebula/late.sh"])
        self.assertNotIn(b"partman-auto-lvm/guided_size string max", files["preseed.cfg"])
        self.assertIn(b"chmod 0644 /target/etc/systemd/network/10-nebula.network", files["nebula/late.sh"])
        password_lines = [line for line in files["preseed.cfg"].decode().splitlines() if line.startswith("d-i passwd/root-password")]
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
        archive = installer.cpio({**files, "nebula/hostkeys/ssh_host_ed25519_key": b"private-test-payload"})
        pos, unpacked = 0, {}
        while True:
            self.assertEqual(archive[pos:pos + 6], b"070701")
            fields = [int(archive[pos + 6 + i * 8:pos + 14 + i * 8], 16) for i in range(13)]
            pos += 110
            name = archive[pos:pos + fields[11] - 1].decode()
            pos = (pos + fields[11] + 3) // 4 * 4
            content = archive[pos:pos + fields[6]]
            pos = (pos + fields[6] + 3) // 4 * 4
            if name == "TRAILER!!!":
                break
            if fields[1] & 0o170000 == 0o100000:
                self.assertEqual(fields[1] & 0o777, 0o600)
                unpacked[name] = content
        self.assertEqual(unpacked["preseed.cfg"], files["preseed.cfg"])
        self.assertEqual(gzip.decompress(gzip.compress(archive)), archive)

    def test_bootstrap_shell_is_valid(self):
        subprocess.run(["sh", "-n"], input=controller.BOOTSTRAP, text=True, check=True)

    def test_installed_storage_must_match_before_capi_handoff(self):
        receipt = {"uid": "request-123", "fingerprint": installer.fingerprint(SPEC), "sourceBootId": "source-boot"}
        responses = {"/var/lib/nebula-baremetal/installed.json": json.dumps(receipt),
                     "/etc/os-release": 'ID=debian\nVERSION_CODENAME=trixie\n'}
        def fake_path(name):
            return types.SimpleNamespace(read_text=lambda: responses[name])
        def command(args):
            if args[0] == "cat": return "installed-boot"
            if args[0] == "vgs": return str(free_bytes)
            if args[0] == "lvs": return str(root_bytes)
            return "active"
        addresses = [{"addr_info": [{"family": "inet", "scope": "global", "local": "192.0.2.10"},
                                    {"family": "inet6", "scope": "global", "local": "2001:db8::10"}]}]
        with patch.object(host_agent, "Path", fake_path), patch.object(host_agent, "command", command), \
             patch.object(host_agent, "json_command", lambda args: addresses), patch.object(host_agent.platform, "node", lambda: SPEC["hostname"]):
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
            with patch.object(host_agent, "command", download), self.assertRaisesRegex(ValueError, "checksum"):
                host_agent.fetch_artifact(SPEC["installation"]["kernel"], destination)
            self.assertFalse(destination.exists())
            self.assertFalse(destination.with_suffix(".download").exists())

    def test_stale_capi_readiness_does_not_complete_an_updated_machine(self):
        self.host["metadata"]["finalizers"] = [controller.RETAIN]
        self.host["status"] = {"phase": "Enrolling", "fingerprint": installer.fingerprint(SPEC)}
        self.api = FakeAPI(self.host)
        original = self.api.request
        def observed(method, path, value=None, content_type=None):
            result = original(method, path, value, content_type)
            if method == "GET" and "/machinedeployments/" in path and result:
                result["metadata"]["generation"] = 2
                result["status"] = {"observedGeneration": 1, "readyReplicas": 1,
                    "conditions": [{"type": "MachinesReady", "status": "True", "observedGeneration": 1}]}
            return result
        self.api.request = observed
        self.step()
        self.assertEqual(self.host["status"]["phase"], "Enrolling")

    def test_network_admission_cannot_precreate_nodes(self):
        self.host["spec"]["ipv6PodCidr"] = "2001:db8:c000:20a::/64"
        policies = list(controller.network_admission(self.host))
        self.assertEqual(len(policies), 4)
        self.assertTrue(all(p["kind"] != "Node" for p in policies))
        self.assertIn('system:node:', policies[2]["spec"]["validations"][0]["expression"])


if __name__ == "__main__":
    unittest.main()
