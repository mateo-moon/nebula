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
from botocore.exceptions import ClientError
from kube import ApiError


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
        self.resources = {}
        self.deletes = []
        self.lose_delete_reply = False
        self.lose_checkpoint_reply = False
    def get(self, path):
        if "/awsconfidentialruntimes/" in path: return copy.deepcopy(self.obj)
        if path not in self.resources: raise ApiError(404)
        return copy.deepcopy(self.resources[path])
    def items(self, path):
        if path == "/apis/confidentialcontainers.org/v1alpha1/peerpods":
            return [copy.deepcopy(obj) for key, obj in self.resources.items() if "/peerpods/" in key]
        return [copy.deepcopy(obj) for key, obj in self.resources.items() if key.startswith(path + "/")]
    def request(self, method, path, value, content_type="application/json"):
        if method == "PATCH":
            assert path.endswith("/status") and content_type == "application/json-patch+json"
            assert value[0]["op"] == "test" and value[0]["path"] == "/metadata/resourceVersion"
            if value[0]["value"] != self.obj["metadata"]["resourceVersion"]: raise ApiError(422)
            assert len(value) == 2 and value[1]["op"] == "add" and value[1]["path"] == "/status"
            self.patches.append((path, copy.deepcopy(value)))
            self.obj["status"] = copy.deepcopy(value[1]["value"])
            self.obj["metadata"]["resourceVersion"] = str(int(self.obj["metadata"]["resourceVersion"]) + 1)
            if self.lose_checkpoint_reply: raise OSError("injected lost checkpoint reply")
            return copy.deepcopy(self.obj)
        assert method == "DELETE"
        obj = self.resources[path]
        assert value["preconditions"] == {key: obj["metadata"][key] for key in ("uid", "resourceVersion")}
        self.deletes.append(path)
        obj["metadata"]["deletionTimestamp"] = "2026-10-08T00:00:00Z"
        if self.lose_delete_reply: raise OSError("injected lost reply")
    def patch(self, path, value):
        if value.get("metadata", {}).get("resourceVersion", self.obj["metadata"]["resourceVersion"]) != self.obj["metadata"]["resourceVersion"]:
            raise ApiError(409)
        self.patches.append((path, copy.deepcopy(value)))
        def merge(old, update):
            if not isinstance(update, dict): return copy.deepcopy(update)
            result = copy.deepcopy(old) if isinstance(old, dict) else {}
            for key, item in update.items():
                if item is None: result.pop(key, None)
                else: result[key] = merge(result.get(key), item)
            return result
        self.obj = merge(self.obj, value)
        self.obj["metadata"]["resourceVersion"] = str(int(self.obj["metadata"]["resourceVersion"]) + 1)
        return copy.deepcopy(self.obj)


class ControllerTests(unittest.TestCase):
    def test_checkpoint_removes_retired_instance_and_failed_import_receipts(self):
        obj, release = fixture()
        obj["status"] = {"cursors": {
            "authorities": {"2": {"generation": 0, "instance": "old-instance", "volume": "old-volume", "retired": []}},
            "imports": {"authority-image": {"attempt": 0, "snapshot": "failed-snapshot", "completion": {"ChangedBlocksCount": 9}, "completionAccepted": True}},
        }}
        kube = KubeFixture(obj)
        controller = Controller(kube, "example", release, lambda: None)
        controller.obj = kube.get(controller.path)
        new = {"authorities": {"2": {"generation": 1, "retired": ["old-volume"], "previousPeer": "old-peer"}},
               "imports": {"authority-image": {"attempt": 1}}}
        controller.checkpoint("PreparingReplicaReplacement", new)
        restarted = Controller(kube, "example", release, lambda: None)
        restarted.obj = kube.get(restarted.path)
        self.assertEqual(restarted.obj["status"]["cursors"], new)
        # Later checkpoints cannot resurrect an omitted receipt after restart.
        restarted.checkpoint("WaitingForStateVolume", restarted.obj["status"]["cursors"])
        self.assertEqual(kube.obj["status"]["cursors"], new)
        # Even if a successful write loses its reply, the next process reads
        # the one committed replacement generation, not the retired instance.
        kube.lose_checkpoint_reply = True
        new["authorities"]["2"]["volume"] = "new-volume"
        with self.assertRaises(OSError): restarted.checkpoint("BootstrappingAuthority", new)
        following = Controller(kube, "example", release, lambda: None)
        following.obj = kube.get(following.path)
        self.assertEqual(following.obj["status"]["cursors"], new)

    def test_checkpoint_refuses_a_stale_writer_without_overwriting_progress(self):
        obj, release = fixture()
        kube = KubeFixture(obj)
        first = Controller(kube, "example", release, lambda: None)
        stale = Controller(kube, "example", release, lambda: None)
        first.obj = kube.get(first.path)
        stale.obj = kube.get(stale.path)
        first.checkpoint("Provisioning", {"marker": "newer"})
        with self.assertRaises(ApiError): stale.checkpoint("Provisioning", {"marker": "older"})
        self.assertEqual(kube.obj["status"]["cursors"], {"marker": "newer"})

    def test_diagnostics_never_include_error_messages_or_response_data(self):
        error = ClientError({"Error": {"Code": "AccessDenied", "Message": "private payload"}, "Credentials": "private material"}, "CreateBucket")
        self.assertEqual(reconciler.diagnostic(error), {"category": "AWS", "operation": "CreateBucket", "code": "AccessDenied"})
        error.response["Error"]["Code"] = "untrusted/response/payload"
        self.assertEqual(reconciler.diagnostic(error)["code"], "Unknown")
        self.assertEqual(reconciler.diagnostic(ValueError("private material")), {"category": "Local", "code": "ValueError"})
        self.assertEqual(reconciler.diagnostic(ApiError(403)), {"category": "Kubernetes", "status": 403})

    def setup_controller(self, health=None):
        environment = patch.dict(reconciler.os.environ, {"NEBULA_WEBHOOK_SERVICE": "example", "NEBULA_WEBHOOK_DEPLOYMENT": "example",
                                                        "NEBULA_WEBHOOK_CONFIGURATION": "example"})
        environment.start(); self.addCleanup(environment.stop)
        admission = patch.object(reconciler.admission, "reconcile", return_value=True)
        admission.start(); self.addCleanup(admission.stop)
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
        cloud.runtime_instances.return_value = set()
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

    def test_admission_must_be_ready_before_starting_the_encrypted_canary(self):
        health = {"voters": {str(i): {} for i in range(3)}, "joint": False, "replacing": False,
                  "status": {"authorityIdentity": "d" * 64}}
        kube, controller, cloud, _ = self.setup_controller(health)
        reconciler.admission.reconcile.return_value = False
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertEqual(kube.obj["status"]["phase"], "WaitingForAdmissionCertificate")
        controller.canary.assert_not_called()

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

    def deleting(self):
        kube, controller, cloud, _ = self.setup_controller()
        kube.obj["metadata"].update({"finalizers": [FINALIZER], "deletionTimestamp": "2026-10-08T00:00:00Z"})
        path = "/apis/confidentialcontainers.org/v1alpha1/namespaces/example/peerpods/owned-resource"
        kube.resources[path] = {"metadata": {"name": "owned-resource", "namespace": "example", "uid": "owned-uid", "resourceVersion": "4",
            "finalizers": ["peer.pod/finalizer"]}, "spec": {"cloudProvider": "aws", "instanceID": "i-0123456789abcdef0"}}
        cloud.runtime_instances.return_value = {"i-0123456789abcdef0"}
        return kube, controller, cloud, path

    def test_peerpod_finalizer_must_finish_before_cloud_cleanup_and_runtime_release(self):
        kube, controller, cloud, path = self.deleting()
        foreign = path.replace("owned-resource", "foreign-resource")
        kube.resources[foreign] = copy.deepcopy(kube.resources[path])
        kube.resources[foreign]["metadata"].update(name="foreign-resource", uid="foreign-uid")
        kube.resources[foreign]["spec"]["instanceID"] = "i-0123456789abcdef1"
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertEqual(kube.deletes, [path])
        self.assertEqual(kube.resources[path]["metadata"]["finalizers"], ["peer.pod/finalizer"])
        self.assertEqual(kube.obj["status"]["phase"], "DrainingPeerPods")
        self.assertEqual(kube.obj["metadata"]["finalizers"], [FINALIZER])
        cloud.stop_runtime_launches.assert_called_once()
        cloud.delete.assert_not_called()
        # AWS can forget the terminated guest while Kubernetes is still waiting.
        cloud.runtime_instances.return_value = set()
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        cloud.delete.assert_not_called()
        del kube.resources[path]  # Only the normal cleanup controller completes it.
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        cloud.delete.assert_called_once()
        self.assertEqual(kube.obj["metadata"]["finalizers"], [])
        self.assertNotIn("deletionTimestamp", kube.resources[foreign]["metadata"])

    def test_peerpod_deletion_resumes_after_lost_reply_and_controller_restart(self):
        kube, controller, cloud, path = self.deleting()
        kube.lose_delete_reply = True
        with patch.object(reconciler, "Cloud", return_value=cloud), self.assertRaises(OSError): controller.reconcile()
        self.assertEqual(kube.obj["status"]["cursors"]["deletingPeerPods"]["example/owned-resource"]["uid"], "owned-uid")
        cloud.delete.assert_not_called()
        kube.lose_delete_reply = False
        cloud.runtime_instances.return_value = set()
        restarted = Controller(kube, "example", controller.release, lambda: None)
        with patch.object(reconciler, "Cloud", return_value=cloud): restarted.reconcile()
        self.assertEqual(kube.deletes, [path], "an already deleting object needs no repeated Delete")
        self.assertEqual(kube.obj["metadata"]["finalizers"], [FINALIZER])
        del kube.resources[path]
        with patch.object(reconciler, "Cloud", return_value=cloud): restarted.reconcile()
        self.assertEqual(kube.obj["metadata"]["finalizers"], [])

    def test_recorded_peerpod_name_cannot_delete_a_replacement_uid_or_instance(self):
        for changed in ("uid", "instance"):
            with self.subTest(changed=changed):
                kube, controller, cloud, path = self.deleting()
                with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
                kube.resources[path]["metadata"].pop("deletionTimestamp")
                if changed == "uid": kube.resources[path]["metadata"]["uid"] = "replacement-uid"
                else: kube.resources[path]["spec"]["instanceID"] = "i-0123456789abcdef1"
                cloud.runtime_instances.return_value = set()
                with patch.object(reconciler, "Cloud", return_value=cloud), self.assertRaisesRegex(ValueError, "identity changed"):
                    controller.reconcile()
                self.assertEqual(kube.deletes, [path])
                cloud.delete.assert_not_called()
                self.assertEqual(kube.obj["metadata"]["finalizers"], [FINALIZER])

    def test_owned_peerpods_are_drained_in_workload_namespaces(self):
        kube, controller, cloud, path = self.deleting()
        other = path.replace("namespaces/example/", "namespaces/workloads/")
        kube.resources[other] = copy.deepcopy(kube.resources[path])
        kube.resources[other]["metadata"].update(namespace="workloads", uid="workload-uid")
        with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
        self.assertCountEqual(kube.deletes, [path, other])
        self.assertEqual(len(kube.obj["status"]["cursors"]["deletingPeerPods"]), 2)
        self.assertEqual(kube.obj["metadata"]["finalizers"], [FINALIZER])

    def test_deletion_only_stops_canary_owned_by_this_runtime_uid(self):
        for owner in ("fixture-uid", "another-runtime-uid"):
            with self.subTest(owner=owner):
                kube, controller, cloud, _ = self.deleting()
                path = "/api/v1/namespaces/example/pods/nebula-runtime-canary"
                kube.resources[path] = {"metadata": {"uid": "canary-uid", "resourceVersion": "8", "ownerReferences": [{"uid": owner}]}}
                with patch.object(reconciler, "Cloud", return_value=cloud): controller.reconcile()
                self.assertEqual(path in kube.deletes, owner == "fixture-uid")

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
