"""Lifecycle and failure tests; no AWS/Kubernetes endpoints are contacted."""
import base64
import copy
import hashlib
import json
import unittest
from unittest.mock import MagicMock, patch
from datetime import datetime, timezone, timedelta

import controller as reconciler
from controller import Controller, FINALIZER, Lease
from cloud import Pending


def fixture():
    genesis = {"authorityRelease": "a" * 64, "runtimeReleases": ["b" * 64]}
    raw = json.dumps(genesis).encode()
    deployment = hashlib.sha256(raw).hexdigest()
    release = {"version": 1, "id": "c" * 64,
        "authority": {"profile": {"release": "a" * 64}, "artifact": {}},
        "runtime": {"profile": {"release": "b" * 64}, "artifact": {}}}
    obj = {"apiVersion": "coco.nebula.io/v1alpha1", "kind": "AwsConfidentialRuntime",
        "metadata": {"name": "example", "namespace": "example", "uid": "fixture-uid", "resourceVersion": "1", "generation": 1},
        "spec": {"deployment": deployment, "region": "eu-west-1", "release": release["id"],
            "placement": {"vpcId": "vpc-0123456789abcdef0", "workerSecurityGroupIds": ["sg-0123456789abcdef0"]},
            "genesis": {"payload": base64.b64encode(raw).decode()}}}
    return obj, release


class KubeFixture:
    namespace = "example"
    def __init__(self, obj):
        self.obj = obj
        self.patches = []
    def get(self, _): return copy.deepcopy(self.obj)
    def patch(self, path, value):
        self.patches.append((path, copy.deepcopy(value)))
        for key, update in value.items(): self.obj.setdefault(key, {}).update(copy.deepcopy(update))
        self.obj["metadata"]["resourceVersion"] = str(int(self.obj["metadata"]["resourceVersion"]) + 1)
        return copy.deepcopy(self.obj)


class ControllerTests(unittest.TestCase):
    def setup_controller(self, health=None):
        obj, release = fixture()
        kube = KubeFixture(obj)
        verifier = MagicMock(return_value=health)
        controller = Controller(kube, "example", release, lambda: None, verifier)
        cloud = MagicMock()
        cloud.image.return_value = "ami-0123456789abcdef0"
        cloud.network.return_value = [{"SubnetId": "subnet-0123456789abcdef0"} for _ in range(3)]
        cloud.interfaces.return_value = [{"PrivateIpAddress": f"10.0.0.{slot + 1}", "PublicAddress": f"192.0.2.{slot + 1}"} for slot in range(3)]
        cloud.group.return_value = "sg-0123456789abcdef1"
        cloud.authority.return_value = {"InstanceId": "i-0123456789abcdef0"}
        cloud.runtime_template.return_value = "example-runtime"
        controller.canary = MagicMock(return_value=(True, "boot/canary"))
        controller.pod_intents = MagicMock()
        controller.peer_config = MagicMock()
        return kube, controller, cloud, verifier

    def test_no_quorum_cannot_authorize_replacement_or_runtime_readiness(self):
        kube, controller, cloud, verifier = self.setup_controller()
        kube.obj["status"] = {"cursors": {"authorityIdentity": "d" * 64}}
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertEqual(kube.obj["status"]["phase"], "WaitingForAuthorityQuorum")
        self.assertIn(FINALIZER, kube.obj["metadata"]["finalizers"])
        self.assertEqual(cloud.authority.call_count, 3)
        self.assertTrue(all(not call.kwargs["allow_replace"] for call in cloud.authority.call_args_list))
        self.assertEqual(verifier.call_args.args[3], "d" * 64)
        controller.peer_config.assert_not_called()
        controller.canary.assert_not_called()

    def test_quorum_then_config_then_canary_controls_readiness(self):
        health = {"voters": {str(i): {} for i in range(3)}, "joint": False, "replacing": False,
                  "status": {"authorityIdentity": "d" * 64}}
        kube, controller, cloud, _ = self.setup_controller(health)
        events = []
        controller.peer_config.side_effect = lambda *_: events.append("configured")
        controller.canary.side_effect = lambda *_: (events.append("canary") or False, "boot/canary")
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertEqual(events, ["configured", "canary"])
        self.assertEqual(kube.obj["status"]["phase"], "WaitingForRuntimeCanary")
        self.assertEqual(kube.obj["status"]["cursors"]["authorityIdentity"], "d" * 64)
        controller.canary.side_effect = None
        controller.canary.return_value = (True, "boot/canary")
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertEqual(kube.obj["status"]["conditions"][0]["status"], "True")
        controller.pod_intents.assert_called_with(cloud, unittest.mock.ANY, ["boot/canary"])

    def test_joint_membership_cannot_start_another_replacement(self):
        health = {"voters": {str(i): {} for i in range(4)}, "joint": True, "replacing": True,
                  "status": {"authorityIdentity": "d" * 64}}
        kube, controller, cloud, _ = self.setup_controller(health)
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertTrue(all(not call.kwargs["allow_replace"] for call in cloud.authority.call_args_list))
        self.assertEqual(kube.obj["status"]["phase"], "WaitingForAuthorityQuorum")

    def test_delete_retains_finalizer_until_owned_cloud_cleanup_finishes(self):
        kube, controller, cloud, _ = self.setup_controller()
        kube.obj["metadata"].update({"finalizers": [FINALIZER, "another-controller"], "deletionTimestamp": "2026-10-07T00:00:00Z"})
        cloud.delete.side_effect = Pending("TerminatingOwnedGuests")
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertEqual(kube.obj["metadata"]["finalizers"], [FINALIZER, "another-controller"])
        cloud.storage.assert_not_called()
        cloud.authority.assert_not_called()
        cloud.delete.side_effect = None
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertEqual(kube.obj["metadata"]["finalizers"], ["another-controller"])

    def test_live_controller_lease_cannot_be_stolen_and_expired_holder_cannot_call_aws(self):
        kube = MagicMock(namespace="example")
        kube.get.return_value = {"metadata": {"resourceVersion": "1"}, "spec": {"holderIdentity": "first",
            "renewTime": datetime.now(timezone.utc).isoformat(), "leaseDurationSeconds": 30}}
        second = Lease(kube, "example", "second")
        with self.assertRaises(ValueError): second.renew()
        with self.assertRaises(Pending): second.require_current()
        kube.patch.assert_not_called()
        kube.get.return_value["spec"]["renewTime"] = (datetime.now(timezone.utc) - timedelta(seconds=60)).isoformat()
        second.renew(); second.require_current()
        self.assertEqual(kube.patch.call_args.args[1]["spec"]["holderIdentity"], "second")


if __name__ == "__main__": unittest.main()
