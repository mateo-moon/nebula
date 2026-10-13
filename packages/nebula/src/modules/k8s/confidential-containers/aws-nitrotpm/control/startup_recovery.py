"""Bounded recovery of unresponsive authority boots before enrollment.

Only stop/start the same instance: its NitroTPM, state disk, interfaces and
generation survive. This never replaces a replica or approves its evidence.
"""
import time

from cloud import Pending, require

BOOT_GRACE_SECONDS = 300
PROBE_INTERVAL_SECONDS = 60
RESTART_TIMEOUT_SECONDS = 900
MAX_RESTARTS = 2


def recover(cloud, instances, cursors, probe, now=None):
    if cursors.get("authorityIdentity"):
        recovery = cursors.get("startupRecovery", {})
        if recovery.pop("pending", None):
            cloud.checkpoint("AuthorityStartupRecovered", cursors)
        return
    require(len(instances) == 3, "complete startup cohort required")
    now = time.time() if now is None else now
    for slot, instance in enumerate(instances):
        cloud.owned(instance, f"authority-{slot}")
        require(instance["InstanceId"] == cursors["authorities"][str(slot)]["instance"], "startup instance changed")
    recovery = cursors.get("startupRecovery", {})
    pending = recovery.get("pending")
    if pending:
        instance = instances[pending["slot"]]
        require(instance["InstanceId"] == pending["instance"], "restart target changed")
        state = instance["State"]["Name"]
        boot = instance["LaunchTime"].timestamp()
        if state == "running" and boot > pending["boot"]:
            del recovery["pending"]
            recovery["nextProbeAt"] = now + BOOT_GRACE_SECONDS
            cloud.checkpoint("AuthorityStartupRestarted", cursors)
            return
        if now >= pending["requestedAt"] + RESTART_TIMEOUT_SECONDS:
            del recovery["pending"]
            recovery["nextProbeAt"] = now + BOOT_GRACE_SECONDS
            cloud.checkpoint("AuthorityStartupRestartTimedOut", cursors)
            raise Pending("AuthorityStartupRestartTimedOut")
        if state != "running":
            # authority() starts a stopped instance on the next ordinary pass.
            # Seeing the transition also resolves a lost StopInstances reply.
            if state in {"stopping", "stopped", "pending"} and not pending["accepted"]:
                pending["accepted"] = True
                cloud.checkpoint("RecoveringAuthorityStartup", cursors)
            raise Pending("RecoveringAuthorityStartup")
        if not pending["accepted"]:
            cloud.ec2.stop_instances(InstanceIds=[pending["instance"]])
            pending["accepted"] = True
            cloud.checkpoint("RecoveringAuthorityStartup", cursors)
        raise Pending("RecoveringAuthorityStartup")
    if any(instance["State"]["Name"] != "running" or
           now - instance["LaunchTime"].timestamp() < BOOT_GRACE_SECONDS for instance in instances):
        return
    if now < recovery.get("nextProbeAt", 0):
        return
    recovery.setdefault("attempts", {})
    recovery["nextProbeAt"] = now + PROBE_INTERVAL_SECONDS
    cursors["startupRecovery"] = recovery
    cloud.checkpoint("CheckingAuthorityStartup", cursors)
    attested = probe()
    require(isinstance(attested, set) and attested <= {0, 1, 2}, "invalid startup attestation result")
    missing = set(range(3)) - attested
    if not missing:
        return
    for slot in sorted(missing):
        attempts = recovery["attempts"].get(str(slot), 0)
        if attempts >= MAX_RESTARTS:
            continue
        instance = instances[slot]
        recovery["attempts"][str(slot)] = attempts + 1
        recovery["pending"] = {"slot": slot, "instance": instance["InstanceId"],
            "boot": instance["LaunchTime"].timestamp(), "requestedAt": now, "accepted": False}
        # Persist the exact target and budget before the cloud mutation. A
        # restarted controller resumes this intent instead of spending twice.
        cloud.checkpoint("RecoveringAuthorityStartup", cursors)
        cloud.ec2.stop_instances(InstanceIds=[instance["InstanceId"]])
        recovery["pending"]["accepted"] = True
        cloud.checkpoint("RecoveringAuthorityStartup", cursors)
        raise Pending("RecoveringAuthorityStartup")
    raise Pending("AuthorityStartupRecoveryExhausted")
