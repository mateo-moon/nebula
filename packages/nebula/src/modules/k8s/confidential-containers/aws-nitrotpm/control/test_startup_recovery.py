"""Startup recovery preserves TPM lineage and a durable, bounded cloud intent."""
import copy
from datetime import datetime, timezone
import unittest
from unittest.mock import MagicMock

from cloud import Pending
from startup_recovery import recover


class StartupRecoveryTests(unittest.TestCase):
    def fixture(self):
        instances = [{"InstanceId": f"instance-{slot}", "State": {"Name": "running"},
            "LaunchTime": datetime.fromtimestamp(100, timezone.utc), "component": f"authority-{slot}"}
            for slot in range(3)]
        cursors = {"authorities": {str(slot): {"instance": instance["InstanceId"],
            "volume": f"state-{slot}", "generation": 0} for slot, instance in enumerate(instances)}}
        saved = []
        cloud = MagicMock()
        def owned(instance, component):
            if instance["component"] != component: raise ValueError("foreign resource")
        cloud.owned.side_effect = owned
        cloud.checkpoint.side_effect = lambda phase, value: saved.append((phase, copy.deepcopy(value)))
        return cloud, instances, cursors, saved

    def test_boot_grace_and_pending_instance_never_probe_or_stop(self):
        for state, now in [("running", 399), ("pending", 1000), ("stopping", 1000)]:
            cloud, instances, cursors, _ = self.fixture()
            instances[1]["State"]["Name"] = state
            probe = MagicMock()
            recover(cloud, instances, cursors, probe, now)
            probe.assert_not_called()
            cloud.ec2.stop_instances.assert_not_called()

    def test_only_failed_attestation_is_restarted_and_state_is_preserved(self):
        cloud, instances, cursors, saved = self.fixture()
        original = copy.deepcopy(cursors["authorities"])
        with self.assertRaisesRegex(Pending, "RecoveringAuthorityStartup"):
            recover(cloud, instances, cursors, lambda: {0, 2}, 500)
        cloud.ec2.stop_instances.assert_called_once_with(InstanceIds=["instance-1"])
        self.assertEqual(cursors["authorities"], original)
        self.assertEqual(cursors["startupRecovery"]["attempts"], {"1": 1})
        self.assertFalse(saved[-2][1]["startupRecovery"]["pending"]["accepted"])
        self.assertTrue(saved[-1][1]["startupRecovery"]["pending"]["accepted"])

    def test_all_attested_replicas_wait_for_quorum_without_cloud_changes(self):
        cloud, instances, cursors, _ = self.fixture()
        probe = MagicMock(return_value={0, 1, 2})
        recover(cloud, instances, cursors, probe, 500)
        recover(cloud, instances, cursors, probe, 510)
        probe.assert_called_once()
        cloud.ec2.stop_instances.assert_not_called()
        self.assertNotIn("authorityIdentity", cursors)

    def test_lost_intent_checkpoint_reply_resumes_same_target_and_budget(self):
        cloud, instances, cursors, saved = self.fixture()
        def checkpoint(phase, value):
            saved.append((phase, copy.deepcopy(value)))
            if value.get("startupRecovery", {}).get("pending"):
                raise OSError("lost checkpoint reply")
        cloud.checkpoint.side_effect = checkpoint
        with self.assertRaises(OSError): recover(cloud, instances, cursors, lambda: {0, 2}, 500)
        cloud.ec2.stop_instances.assert_not_called()
        persisted = saved[-1][1]
        cloud.checkpoint.side_effect = lambda phase, value: saved.append((phase, copy.deepcopy(value)))
        with self.assertRaises(Pending): recover(cloud, instances, persisted, self.fail, 510)
        cloud.ec2.stop_instances.assert_called_once_with(InstanceIds=["instance-1"])
        self.assertEqual(persisted["startupRecovery"]["attempts"], {"1": 1})

    def test_rejected_checkpoint_prevents_cloud_stop(self):
        cloud, instances, cursors, _ = self.fixture()
        def checkpoint(_phase, value):
            if value.get("startupRecovery", {}).get("pending"):
                raise OSError("stale writer")
        cloud.checkpoint.side_effect = checkpoint
        with self.assertRaises(OSError): recover(cloud, instances, cursors, lambda: {0, 2}, 500)
        cloud.ec2.stop_instances.assert_not_called()

    def test_lost_stop_reply_is_recovered_from_instance_transition(self):
        cloud, instances, cursors, _ = self.fixture()
        cloud.ec2.stop_instances.side_effect = OSError("lost cloud reply")
        with self.assertRaises(OSError): recover(cloud, instances, cursors, lambda: {0, 2}, 500)
        instances[1]["State"]["Name"] = "stopping"
        with self.assertRaises(Pending): recover(cloud, instances, cursors, self.fail, 510)
        self.assertTrue(cursors["startupRecovery"]["pending"]["accepted"])
        instances[1]["State"]["Name"] = "stopped"
        with self.assertRaises(Pending): recover(cloud, instances, cursors, self.fail, 520)
        instances[1]["State"]["Name"] = "running"
        instances[1]["LaunchTime"] = datetime.fromtimestamp(525, timezone.utc)
        recover(cloud, instances, cursors, self.fail, 530)
        self.assertNotIn("pending", cursors["startupRecovery"])
        self.assertEqual(cursors["startupRecovery"]["attempts"], {"1": 1})
        self.assertEqual(cursors["startupRecovery"]["nextProbeAt"], 830)
        cloud.ec2.stop_instances.assert_called_once()

    def test_accepted_stop_is_not_repeated_while_cloud_state_lags(self):
        cloud, instances, cursors, _ = self.fixture()
        with self.assertRaises(Pending): recover(cloud, instances, cursors, lambda: {0, 2}, 500)
        for now in [510, 600, 1399]:
            with self.assertRaises(Pending): recover(cloud, instances, cursors, self.fail, now)
        with self.assertRaisesRegex(Pending, "RestartTimedOut"):
            recover(cloud, instances, cursors, self.fail, 1400)
        cloud.ec2.stop_instances.assert_called_once()
        self.assertEqual(cursors["startupRecovery"]["attempts"], {"1": 1})
        self.assertNotIn("pending", cursors["startupRecovery"])

    def test_budget_exhaustion_never_replaces_instances_or_changes_identity(self):
        cloud, instances, cursors, _ = self.fixture()
        cursors["startupRecovery"] = {"attempts": {"1": 2}}
        original = copy.deepcopy(cursors["authorities"])
        with self.assertRaisesRegex(Pending, "RecoveryExhausted"):
            recover(cloud, instances, cursors, lambda: {0, 2}, 500)
        cloud.ec2.stop_instances.assert_not_called()
        cloud.ec2.terminate_instances.assert_not_called()
        cloud.ec2.run_instances.assert_not_called()
        self.assertEqual(cursors["authorities"], original)
        self.assertNotIn("authorityIdentity", cursors)

    def test_an_enrolled_identity_cancels_an_unexecuted_stop(self):
        cloud, instances, cursors, _ = self.fixture()
        cloud.checkpoint.side_effect = OSError("lost checkpoint reply")
        # Use a recorded intent to model enrollment winning the next pass.
        cursors["startupRecovery"] = {"attempts": {"1": 1}, "pending": {"slot": 1}}
        cursors["authorityIdentity"] = "d" * 64
        cloud.checkpoint.side_effect = None
        recover(cloud, instances, cursors, self.fail, 500)
        cloud.ec2.stop_instances.assert_not_called()
        self.assertEqual(cursors["authorityIdentity"], "d" * 64)
        self.assertNotIn("pending", cursors["startupRecovery"])

    def test_changed_instance_and_foreign_ownership_are_refused(self):
        for field in ["InstanceId", "component"]:
            cloud, instances, cursors, _ = self.fixture()
            instances[1][field] = "foreign"
            with self.assertRaises(ValueError): recover(cloud, instances, cursors, self.fail, 500)
            cloud.ec2.stop_instances.assert_not_called()

    def test_missing_slots_are_recovered_one_at_a_time(self):
        cloud, instances, cursors, _ = self.fixture()
        cursors["startupRecovery"] = {"attempts": {"0": 2}}
        with self.assertRaises(Pending): recover(cloud, instances, cursors, lambda: set(), 500)
        cloud.ec2.stop_instances.assert_called_once_with(InstanceIds=["instance-1"])

    def test_malformed_probe_cannot_trigger_a_stop(self):
        for value in [None, [0, 2], {0, 3}]:
            cloud, instances, cursors, _ = self.fixture()
            with self.assertRaises(ValueError): recover(cloud, instances, cursors, lambda: value, 500)
            cloud.ec2.stop_instances.assert_not_called()


if __name__ == "__main__":
    unittest.main()
