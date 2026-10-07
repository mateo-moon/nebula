"""Offline AWS SDK checks. All identifiers/credentials below are synthetic."""
import copy
import base64
import tempfile
from contextlib import contextmanager
from pathlib import Path
import hashlib
import unittest

import boto3
from botocore.stub import Stubber, ANY
from cloud import Cloud, Pending, choose_subnets


class CloudTests(unittest.TestCase):
    def make_cloud(self):
        cloud = Cloud.__new__(Cloud)
        session = boto3.Session(aws_access_key_id="EXAMPLE", aws_secret_access_key="example", region_name="eu-west-1")
        cloud.ec2 = session.client("ec2")
        cloud.s3 = session.client("s3")
        cloud.iam = session.client("iam")
        cloud.ebs = session.client("ebs")
        cloud.deployment = "d" * 64
        cloud.region = "eu-west-1"
        cloud.account = "111122223333"
        cloud.prefix = "nebula-coco-" + "d" * 20
        cloud.bucket = cloud.prefix + "-111122223333-eu-west-1"
        cloud.placement = {"vpcId": "vpc-0123456789abcdef0"}
        cloud.saved = []
        cloud.checkpoint = lambda phase, cursors: cloud.saved.append((phase, copy.deepcopy(cursors)))
        return cloud

    def test_subnet_allocator_never_overlaps_platform_subnets(self):
        selected = choose_subnets("192.0.2.0/24", ["192.0.2.0/26", "192.0.2.128/25"])
        self.assertEqual(selected, ["192.0.2.64/28", "192.0.2.80/28", "192.0.2.96/28"])
        with self.assertRaises(ValueError):
            choose_subnets("192.0.2.0/24", ["192.0.2.0/24"])

    def test_state_volume_creation_retries_the_same_intent_after_a_lost_response(self):
        cloud = self.make_cloud()
        cursors = {}
        interface = {"AvailabilityZone": "eu-west-1a", "Status": "available"}
        expected = {"AvailabilityZone": "eu-west-1a", "Encrypted": True, "Size": 1, "VolumeType": "gp3",
            "TagSpecifications": cloud.tag_spec("volume", "state-0"),
            "ClientToken": hashlib.sha256((cloud.deployment + "authority-0" + "0").encode()).hexdigest()}
        with Stubber(cloud.ec2) as ec2:
            ec2.add_response("describe_instances", {"Reservations": []}, {"Filters": cloud.filters("authority-0")})
            ec2.add_client_error("create_volume", service_error_code="InternalError", expected_params=expected)
            with self.assertRaises(Exception): cloud.authority(0, interface, "ami-example", {}, cursors, False)
            self.assertEqual(cursors["authorities"]["0"], {"generation": 0, "retired": []})
            ec2.add_response("describe_instances", {"Reservations": []}, {"Filters": cloud.filters("authority-0")})
            ec2.add_response("create_volume", {"VolumeId": "vol-0123456789abcdef0"}, expected)
            ec2.add_response("describe_volumes", {"Volumes": [{"VolumeId": "vol-0123456789abcdef0", "State": "creating",
                "Tags": cloud.tags("state-0")}]}, {"VolumeIds": ["vol-0123456789abcdef0"]})
            with self.assertRaises(Pending): cloud.authority(0, interface, "ami-example", {}, cursors, False)
            self.assertEqual(cursors["authorities"]["0"]["volume"], "vol-0123456789abcdef0")
            ec2.assert_no_pending_responses()

    def test_owned_inventory_reads_every_page_and_deletion_waits_for_termination(self):
        cloud = self.make_cloud()
        with Stubber(cloud.ec2) as ec2:
            ec2.add_response("describe_instances", {"Reservations": [], "NextToken": "second-page"}, {"Filters": cloud.filters()})
            ec2.add_response("describe_instances", {"Reservations": [{"Instances": [{"InstanceId": "i-0123456789abcdef0",
                "State": {"Name": "shutting-down"}, "Tags": cloud.tags("authority-0")}]}]}, {"Filters": cloud.filters(), "NextToken": "second-page"})
            with self.assertRaisesRegex(Pending, "TerminatingOwnedGuests"): cloud.delete()
            ec2.assert_no_pending_responses()

    def test_foreign_and_ambiguous_resources_cannot_be_adopted(self):
        cloud = self.make_cloud()
        for resource in [{}, {"Tags": [{"Key": "NebulaCocoDeployment", "Value": "other"}]}]:
            with self.assertRaises(ValueError):
                cloud.owned(resource)
        with self.assertRaises(ValueError):
            cloud.one([{}, {}])
        self.assertIsNotNone(cloud.owned({"TagSet": cloud.tags("interface")}, "interface"))
        with Stubber(cloud.s3) as stub:
            stub.add_response("get_bucket_tagging", {"TagSet": [{"Key": "NebulaCocoDeployment", "Value": "other"}]}, {"Bucket": cloud.bucket})
            with self.assertRaises(ValueError):
                cloud.storage({})
            stub.assert_no_pending_responses()

    def test_snapshot_completion_survives_a_lost_response_without_reuploading_blocks(self):
        cloud = self.make_cloud()
        artifact = {"rawSha256": "a" * 64, "sha256": "b" * 64, "rawSize": 512 * 1024}
        component = "authority-image-" + "a" * 24
        cursors = {}
        block = b"x" * (512 * 1024)
        checksum = base64.b64encode(hashlib.sha256(block).digest()).decode()
        aggregate = base64.b64encode(hashlib.sha256(hashlib.sha256(block).digest()).digest()).decode()
        with tempfile.TemporaryDirectory() as directory:
            raw = Path(directory) / "image.raw"; raw.write_bytes(block)
            @contextmanager
            def artifact_file(_): yield raw
            cloud.artifact = artifact_file
            with Stubber(cloud.ec2) as ec2, Stubber(cloud.ebs) as ebs:
                ec2.add_response("describe_images", {"Images": []}, {"Owners": ["self"], "Filters": cloud.filters(component)})
                ebs.add_response("start_snapshot", {"SnapshotId": "snap-0123456789abcdef0", "BlockSize": 512 * 1024}, {
                    "ClientToken": hashlib.sha256((cloud.deployment + component + "0").encode()).hexdigest(),
                    "Description": component, "Encrypted": True, "VolumeSize": 1, "Timeout": 60, "Tags": cloud.tags(component)})
                ebs.add_response("put_snapshot_block", {"Checksum": checksum, "ChecksumAlgorithm": "SHA256"}, {
                    "SnapshotId": "snap-0123456789abcdef0", "BlockIndex": 0, "BlockData": block, "DataLength": len(block),
                    "Checksum": checksum, "ChecksumAlgorithm": "SHA256"})
                final = {"SnapshotId": "snap-0123456789abcdef0", "ChangedBlocksCount": 1,
                    "Checksum": aggregate, "ChecksumAlgorithm": "SHA256", "ChecksumAggregationMethod": "LINEAR"}
                ebs.add_client_error("complete_snapshot", service_error_code="InternalServerException", expected_params=final)
                with self.assertRaises(Exception): cloud.image("authority", artifact, cursors)
                self.assertEqual(cursors["imports"][component]["completion"]["ChangedBlocksCount"], 1)
                # On retry AWS may already have completed the snapshot. No
                # subsequent artifact download, block write or completion call.
                cloud.artifact = lambda _: self.fail("a completed upload was repeated")
                ec2.add_response("describe_images", {"Images": []}, {"Owners": ["self"], "Filters": cloud.filters(component)})
                ec2.add_response("describe_snapshots", {"Snapshots": [{"SnapshotId": "snap-0123456789abcdef0",
                    "State": "completed", "Tags": cloud.tags(component)}]}, {"SnapshotIds": ["snap-0123456789abcdef0"]})
                ec2.add_response("register_image", {"ImageId": "ami-0123456789abcdef0"}, {
                    "Name": cloud.prefix + "-" + component, "Description": component, "Architecture": "x86_64",
                    "VirtualizationType": "hvm", "BootMode": "uefi", "TpmSupport": "v2.0", "ImdsSupport": "v2.0", "EnaSupport": True,
                    "RootDeviceName": "/dev/sda1", "BlockDeviceMappings": [{"DeviceName": "/dev/sda1", "Ebs": {
                        "SnapshotId": "snap-0123456789abcdef0", "DeleteOnTermination": True, "VolumeType": "gp3"}}],
                    "TagSpecifications": cloud.tag_spec("image", component)})
                self.assertEqual(cloud.image("authority", artifact, cursors), "ami-0123456789abcdef0")
                ec2.assert_no_pending_responses(); ebs.assert_no_pending_responses()

    def test_runtime_template_requires_snp_tpm_metadata_and_owned_encrypted_storage(self):
        cloud = self.make_cloud()
        profile = {"Path": "/", "InstanceProfileName": cloud.prefix + "-guest", "InstanceProfileId": "AIPAEXAMPLE1234567",
            "Arn": "arn:aws:iam::111122223333:instance-profile/example", "CreateDate": "2026-10-07T00:00:00Z", "Roles": []}
        with Stubber(cloud.iam) as iam, Stubber(cloud.ec2) as ec2:
            iam.add_response("get_instance_profile", {"InstanceProfile": profile}, {"InstanceProfileName": cloud.prefix + "-guest"})
            ec2.add_response("describe_launch_templates", {"LaunchTemplates": []}, {"Filters": cloud.filters("runtime-template-" + "c" * 16)})
            def inspect(params, **_):
                data = params["LaunchTemplateData"]
                self.assertEqual(data["CpuOptions"], {"AmdSevSnp": "enabled"})
                self.assertEqual(data["MetadataOptions"]["HttpTokens"], "required")
                self.assertTrue(data["BlockDeviceMappings"][0]["Ebs"]["Encrypted"])
                self.assertTrue(data["NetworkInterfaces"][0]["AssociatePublicIpAddress"])
                self.assertEqual({t["Key"]: t["Value"] for t in data["TagSpecifications"][0]["Tags"]}["nebula-coco-deployment"], cloud.deployment)
            cloud.ec2.meta.events.register("before-parameter-build.ec2.CreateLaunchTemplate", inspect)
            ec2.add_response("create_launch_template", {"LaunchTemplate": {"LaunchTemplateId": "lt-0123456789abcdef0"}}, {
                "LaunchTemplateName": cloud.prefix + "-runtime-" + "c" * 16, "ClientToken": ANY,
                "TagSpecifications": cloud.tag_spec("launch-template", "runtime-template-" + "c" * 16), "LaunchTemplateData": ANY})
            name = cloud.runtime_template("ami-0123456789abcdef0", "subnet-0123456789abcdef0", "sg-0123456789abcdef0", "c" * 64)
            self.assertTrue(name.endswith("c" * 16))
            iam.assert_no_pending_responses(); ec2.assert_no_pending_responses()


if __name__ == "__main__":
    unittest.main()
