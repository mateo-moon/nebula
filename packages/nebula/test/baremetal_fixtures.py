"""Shared in-memory provisioning fixtures; no host commands run on import."""

import copy
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src/modules/infra/k0s/baremetal"))
import host as host_agent
import installer
import runner
import transport
import uefi as uefi_agent
from agent import build_agent
from runtime import ProvisioningError, RetryableError

__all__ = [
    "FACTS",
    "SPEC",
    "FakeAPI",
    "FakeSSH",
    "RetryableError",
    "ProvisioningError",
    "build_agent",
    "host_agent",
    "installer",
    "runner",
    "transport",
    "uefi_agent",
]

SPEC = {
    "address": "192.0.2.10",
    "hostname": "bm-192-0-2-10",
    "ssh": {
        "user": "root",
        "port": 22,
        "secretName": "initial",
        "workerSecretName": "worker",
        "trustOnFirstUse": True,
    },
    "installation": {
        "suite": "trixie",
        "mirror": {"hostname": "deb.debian.org", "directory": "/debian"},
        "kernel": {"url": "https://images.example.test/kernel", "sha256": "1" * 64},
        "initrd": {"url": "https://images.example.test/initrd", "sha256": "2" * 64},
        "disk": {"minSizeGiB": 32},
        "rootSizeGiB": 16,
        "volumeGroup": "worker-vg",
        "timeoutSeconds": 3600,
        "dualStack": True,
    },
}
FACTS = {
    "bootId": "source-boot",
    "uefi": True,
    "disk": {"byId": "/dev/disk/by-id/virtio-test"},
    "network": {
        "mac": "02:00:00:00:00:10",
        "addresses": ["192.0.2.10/24", "2001:db8::10/64"],
        "routes": [
            {"destination": "0.0.0.0/0", "gateway": "192.0.2.1"},
            {"destination": "::/0", "gateway": "fe80::1"},
        ],
        "dns": ["192.0.2.53"],
    },
}


class FakeAPI:
    def __init__(self, resource):
        self.resource, self.actions = copy.deepcopy(resource), []

    def request(self, method, path, value=None, content_type=None):
        self.actions.append((method, path))
        if method == "PATCH":
            if value["metadata"]["resourceVersion"] != self.resource["metadata"]["resourceVersion"]:
                raise RetryableError("conflict")
            self.resource["metadata"]["resourceVersion"] = str(
                int(self.resource["metadata"]["resourceVersion"]) + 1
            )
            self.resource["data"].update(copy.deepcopy(value["data"]))
        return copy.deepcopy(self.resource)


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
                raise RetryableError("not yet installed")
            return {
                "verified": True,
                "addresses": ["192.0.2.10", "2001:db8::10"],
                "bootId": "installed-boot",
            }
        if action == "probe":
            return {**copy.deepcopy(FACTS), "bootId": self.original_boot}
        if action == "commit" and self.crash_commit:
            raise RetryableError("controller stopped before commit")
        return {}
