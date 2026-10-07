"""Module-owned AWS infrastructure. This process never receives workload keys.

Tags and deterministic names identify this installation. AWS responses are
reconciled on every pass; Kubernetes status is only an operation cursor.
"""
import base64
from contextlib import contextmanager
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
import gzip
import hashlib
import ipaddress
import json
import tempfile
import urllib.request
from pathlib import Path

from botocore.exceptions import ClientError

OWNER = "NebulaCocoDeployment"
COMPONENT = "NebulaCocoComponent"
INSTANCE_TYPE = "c6a.large"


class Pending(Exception):
    """A bounded reconciliation pass has work outstanding."""


def require(ok, reason):
    if not ok:
        raise ValueError(reason)


def absent(error, *codes):
    return isinstance(error, ClientError) and error.response["Error"]["Code"] in codes


def choose_subnets(cidr, occupied, count=3):
    network = ipaddress.ip_network(cidr)
    require(network.version == 4 and network.prefixlen <= 24, "VPC needs room for authority subnets")
    occupied = [ipaddress.ip_network(value) for value in occupied]
    chosen = []
    for candidate in network.subnets(new_prefix=28):
        if not any(candidate.overlaps(old) for old in occupied):
            chosen.append(str(candidate))
            if len(chosen) == count:
                return chosen
    raise ValueError("VPC has no room for three module-owned subnets")


class Cloud:
    def __init__(self, session, deployment, region, placement, checkpoint):
        require(len(deployment) == 64 and all(c in "0123456789abcdef" for c in deployment), "invalid deployment")
        require(region in ("eu-west-1", "us-east-2"), "unsupported SNP region")
        self.deployment, self.region, self.placement = deployment, region, placement
        self.ec2, self.s3, self.iam, self.ebs = (session.client(service, region_name=region) for service in ("ec2", "s3", "iam", "ebs"))
        self.account = session.client("sts", region_name=region).get_caller_identity()["Account"]
        self.prefix = "nebula-coco-" + deployment[:20]
        self.bucket = f"{self.prefix}-{self.account}-{region}"
        self.checkpoint = checkpoint

    def tags(self, component):
        return [{"Key": OWNER, "Value": self.deployment}, {"Key": COMPONENT, "Value": component}]

    def items(self, operation, key, **parameters):
        values, token = [], None
        while True:
            page = getattr(self.ec2, operation)(**parameters, **({"NextToken": token} if token else {}))
            values.extend(page.get(key, []))
            following = page.get("NextToken")
            if not following: return values
            require(following != token, "cloud pagination did not progress")
            token = following

    def remove(self, operation, **parameters):
        try: return getattr(self.ec2, operation)(**parameters)
        except ClientError as error:
            # AWS deletion is eventually consistent; a retry may discover an
            # object that disappeared between Describe and Delete.
            if not absent(error, "InvalidVolume.NotFound", "InvalidSnapshot.NotFound", "InvalidAMIID.NotFound",
                "InvalidNetworkInterfaceID.NotFound", "InvalidGroup.NotFound", "InvalidSubnetID.NotFound",
                "InvalidRouteTableID.NotFound", "InvalidInternetGatewayID.NotFound", "InvalidAllocationID.NotFound",
                "InvalidAssociationID.NotFound", "InvalidSecurityGroupRuleId.NotFound", "InvalidLaunchTemplateId.NotFound"):
                raise

    def tag_spec(self, kind, component):
        return [{"ResourceType": kind, "Tags": self.tags(component)}]

    def filters(self, component=None):
        result = [{"Name": "tag:" + OWNER, "Values": [self.deployment]}]
        if component is not None:
            result.append({"Name": "tag:" + COMPONENT, "Values": [component]})
        return result

    def owned(self, resource, component=None):
        require(resource is not None, "owned resource disappeared")
        tags = {item["Key"]: item["Value"] for item in resource.get("Tags", resource.get("TagSet", []))}
        require(tags.get(OWNER) == self.deployment and (component is None or tags.get(COMPONENT) == component), "foreign resource refused")
        return resource

    @staticmethod
    def one(resources):
        require(len(resources) <= 1, "ambiguous owned resource")
        return resources[0] if resources else None

    def storage(self, cursors):
        try:
            actual = self.s3.get_bucket_tagging(Bucket=self.bucket)["TagSet"]
            require({t["Key"]: t["Value"] for t in actual}.get(OWNER) == self.deployment, "foreign bucket refused")
        except ClientError as error:
            if absent(error, "NoSuchTagSet") and cursors.get("creatingBucket") == self.bucket:
                # Resume the gap between CreateBucket and tagging. The exact
                # reserved name and account must match the persisted intent.
                self.s3.head_bucket(Bucket=self.bucket, ExpectedBucketOwner=self.account)
            elif absent(error, "NoSuchBucket"):
                cursors["creatingBucket"] = self.bucket
                self.checkpoint("Provisioning", cursors)
                self.s3.create_bucket(Bucket=self.bucket, CreateBucketConfiguration={"LocationConstraint": self.region},
                                      ObjectOwnership="BucketOwnerEnforced")
            else:
                raise
            self.s3.put_bucket_tagging(Bucket=self.bucket, Tagging={"TagSet": self.tags("artifacts")})
        self.s3.put_public_access_block(Bucket=self.bucket, PublicAccessBlockConfiguration={
            "BlockPublicAcls": True, "IgnorePublicAcls": True, "BlockPublicPolicy": True, "RestrictPublicBuckets": True})
        self.s3.put_bucket_encryption(Bucket=self.bucket, ServerSideEncryptionConfiguration={
            "Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]})
    def put_configuration(self, key, value):
        require(key.startswith(f"boot/{self.deployment}/"), "configuration is outside this deployment")
        data = json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()
        require(len(data) <= 512 * 1024, "public boot configuration too large")
        digest = hashlib.sha256(data).hexdigest()
        try:
            if self.s3.head_object(Bucket=self.bucket, Key=key).get("Metadata", {}).get("sha256") == digest: return
        except ClientError as error:
            if not absent(error, "404", "NoSuchKey", "NotFound"): raise
        self.s3.put_object(Bucket=self.bucket, Key=key, Body=data, ContentType="application/json",
                           Metadata={"sha256": digest}, ServerSideEncryption="AES256", CacheControl="no-store")

    @contextmanager
    def artifact(self, artifact):
        # The packaged release authenticates the bytes, never a running VM's
        # observed measurements. Downloaded disks contain public software only.
        require(artifact["url"].startswith("https://github.com/") and "/releases/download/" in artifact["url"], "released artifact URL required")
        require(0 < artifact["compressedSize"] <= 2 * 1024**3 and 0 < artifact["rawSize"] <= 16 * 1024**3, "image size outside release bounds")
        with tempfile.TemporaryDirectory(prefix="nebula-public-image-") as directory:
            compressed, raw = Path(directory) / "image.gz", Path(directory) / "image.raw"
            digest, size = hashlib.sha256(), 0
            with urllib.request.urlopen(artifact["url"], timeout=30) as response, compressed.open("wb") as output:
                require(response.geturl().startswith("https://"), "artifact redirect must retain TLS")
                while block := response.read(1024 * 1024):
                    size += len(block)
                    require(size <= artifact["compressedSize"], "artifact exceeded signed size")
                    digest.update(block)
                    output.write(block)
            require(size == artifact["compressedSize"] and digest.hexdigest() == artifact["sha256"], "released artifact digest mismatch")
            digest, size = hashlib.sha256(), 0
            with gzip.open(compressed, "rb") as source, raw.open("wb") as output:
                while block := source.read(1024 * 1024):
                    size += len(block)
                    require(size <= artifact["rawSize"], "expanded image exceeded release size")
                    digest.update(block)
                    output.write(block)
            require(size == artifact["rawSize"] and digest.hexdigest() == artifact["rawSha256"], "expanded image digest mismatch")
            yield raw

    def upload_snapshot(self, snapshot, raw):
        block_size = 512 * 1024
        checksums, changed = hashlib.sha256(), 0
        def upload(index, data, checksum):
            result = self.ebs.put_snapshot_block(SnapshotId=snapshot, BlockIndex=index,
                BlockData=data, DataLength=block_size, Checksum=checksum, ChecksumAlgorithm="SHA256")
            require(result["Checksum"] == checksum and result["ChecksumAlgorithm"] == "SHA256", "snapshot block checksum mismatch")
        # Keep at most eight MiB of blocks in flight. Retries write the same
        # bytes to the same indexes; completed-count is independent of retries.
        with raw.open("rb") as source, ThreadPoolExecutor(max_workers=8) as executor:
            pending, index = set(), 0
            while data := source.read(block_size):
                data = data.ljust(block_size, b"\0")
                if any(data):
                    digest = hashlib.sha256(data).digest()
                    checksums.update(digest)
                    pending.add(executor.submit(upload, index, data, base64.b64encode(digest).decode()))
                    changed += 1
                    if len(pending) >= 16:
                        done, pending = wait(pending, return_when=FIRST_COMPLETED)
                        for future in done: future.result()
                index += 1
            for future in pending: future.result()
        return {"ChangedBlocksCount": changed, "Checksum": base64.b64encode(checksums.digest()).decode(),
                "ChecksumAlgorithm": "SHA256", "ChecksumAggregationMethod": "LINEAR"}

    def image(self, role, artifact, cursors):
        require(role in ("authority", "runtime") and all(len(artifact[field]) == 64
            and all(c in "0123456789abcdef" for c in artifact[field]) for field in ("rawSha256", "sha256")), "invalid released image")
        component = f"{role}-image-{artifact['rawSha256'][:24]}"
        images = self.items('describe_images', 'Images', Owners=["self"], Filters=self.filters(component))
        image = self.one(images)
        if image:
            self.owned(image, component)
            require(image["Architecture"] == "x86_64" and image.get("BootMode") == "uefi" and image.get("TpmSupport") == "v2.0", "image launch contract changed")
            if image["State"] != "available":
                raise Pending("WaitingForImage")
            return image["ImageId"]
        cursor = cursors.setdefault("imports", {}).setdefault(component, {"attempt": 0})
        require(isinstance(cursor.get("attempt"), int) and 0 <= cursor["attempt"] < 3, "image import retry limit reached")
        snapshot = None
        if cursor.get("snapshot"):
            try:
                snapshot = self.owned(self.items('describe_snapshots', 'Snapshots', SnapshotIds=[cursor["snapshot"]])[0], component)
            except ClientError as error:
                if not absent(error, "InvalidSnapshot.NotFound"): raise
                cursor.pop("snapshot")
                cursor.pop("completion", None)
                cursor.pop("completionAccepted", None)
                cursor["attempt"] += 1
                self.checkpoint("RetryingImageImport", cursors)
                raise Pending("RetryingImageImport") from None
            if snapshot["State"] == "error":
                self.ec2.delete_snapshot(SnapshotId=snapshot["SnapshotId"])
                cursor.pop("snapshot")
                cursor.pop("completion", None)
                cursor.pop("completionAccepted", None)
                cursor["attempt"] += 1
                self.checkpoint("RetryingImageImport", cursors)
                raise Pending("RetryingImageImport")
        if snapshot is None or snapshot["State"] != "completed":
            if not cursor.get("completion"):
                with self.artifact(artifact) as raw:
                    if snapshot is None:
                        token = hashlib.sha256((self.deployment + component + str(cursor["attempt"])).encode()).hexdigest()
                        result = self.ebs.start_snapshot(ClientToken=token, Description=component, Encrypted=True,
                            VolumeSize=(artifact["rawSize"] + 1024**3 - 1) // 1024**3, Tags=self.tags(component), Timeout=60)
                        require(result["BlockSize"] == 512 * 1024, "unexpected EBS block size")
                        cursor["snapshot"] = result["SnapshotId"]
                        self.checkpoint("Importing", cursors)
                    cursor["completion"] = self.upload_snapshot(cursor["snapshot"], raw)
                    self.checkpoint("CompletingImageSnapshot", cursors)
            if not cursor.get("completionAccepted"):
                # Once all blocks have acknowledgments, never write any block
                # again, including when CompleteSnapshot's response was lost.
                try:
                    self.ebs.complete_snapshot(SnapshotId=cursor["snapshot"], **cursor["completion"])
                except ClientError as error:
                    # CompleteSnapshot is not idempotent. After an ambiguous
                    # accepted request, EC2 can still report pending while EBS
                    # refuses a second completion. Keep polling that snapshot;
                    # never overwrite its blocks or approve an incomplete disk.
                    if absent(error, "ValidationException", "ConflictException"):
                        raise Pending("WaitingForImageSnapshot") from None
                    raise
                cursor["completionAccepted"] = True
                self.checkpoint("CompletingImageSnapshot", cursors)
            raise Pending("WaitingForImageSnapshot")
        snapshot = snapshot["SnapshotId"]
        result = self.ec2.register_image(Name=self.prefix + "-" + component, Description=component,
            Architecture="x86_64", VirtualizationType="hvm", BootMode="uefi", TpmSupport="v2.0", ImdsSupport="v2.0",
            EnaSupport=True, RootDeviceName="/dev/sda1",
            BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {"SnapshotId": snapshot, "DeleteOnTermination": True, "VolumeType": "gp3"}}],
            TagSpecifications=self.tag_spec("image", component))
        return result["ImageId"]

    def network(self):
        vpc = self.items('describe_vpcs', 'Vpcs', VpcIds=[self.placement["vpcId"]])[0]
        require(vpc["State"] == "available", "placement VPC unavailable")
        instance = self.items('describe_instance_types', 'InstanceTypes', InstanceTypes=[INSTANCE_TYPE])[0]
        require(instance.get("NitroTpmSupport") == "supported" and "amd-sev-snp" in instance["ProcessorInfo"].get("SupportedFeatures", []), "required hardware is unavailable")
        offerings = self.items('describe_instance_type_offerings', 'InstanceTypeOfferings', LocationType="availability-zone", Filters=[{"Name": "instance-type", "Values": [INSTANCE_TYPE]}])
        offered = {offer["Location"] for offer in offerings}
        zones = sorted(zone["ZoneName"] for zone in self.items('describe_availability_zones', 'AvailabilityZones', Filters=[{"Name": "state", "Values": ["available"]}]) if zone["ZoneName"] in offered and zone.get("ZoneType") == "availability-zone")
        require(len(zones) >= 3, "three supported availability zones required")
        existing = self.items('describe_subnets', 'Subnets', Filters=[{"Name": "vpc-id", "Values": [vpc["VpcId"]]}])
        subnets = []
        for slot in range(3):
            component = f"subnet-{slot}"
            owned = self.one([subnet for subnet in existing if {t["Key"]: t["Value"] for t in subnet.get("Tags", [])}.get(COMPONENT) == component
                              and {t["Key"]: t["Value"] for t in subnet.get("Tags", [])}.get(OWNER) == self.deployment])
            if not owned:
                cidr = choose_subnets(vpc["CidrBlock"], [s["CidrBlock"] for s in existing], 1)[0]
                owned = self.ec2.create_subnet(VpcId=vpc["VpcId"], CidrBlock=cidr, AvailabilityZone=zones[slot],
                    TagSpecifications=self.tag_spec("subnet", component))["Subnet"]
                existing.append(owned)
            subnets.append(self.owned(owned, component))
        gateways = self.items('describe_internet_gateways', 'InternetGateways', Filters=[{"Name": "attachment.vpc-id", "Values": [vpc["VpcId"]]}])
        gateway = self.one(gateways)
        if not gateway:
            gateway = self.one(self.items('describe_internet_gateways', 'InternetGateways', Filters=self.filters("gateway")))
            if not gateway:
                gateway = self.ec2.create_internet_gateway(TagSpecifications=self.tag_spec("internet-gateway", "gateway"))["InternetGateway"]
            self.ec2.attach_internet_gateway(InternetGatewayId=gateway["InternetGatewayId"], VpcId=vpc["VpcId"])
        table = self.one(self.items('describe_route_tables', 'RouteTables', Filters=self.filters("routes")))
        if not table:
            table = self.ec2.create_route_table(VpcId=vpc["VpcId"], TagSpecifications=self.tag_spec("route-table", "routes"))["RouteTable"]
        table = self.owned(table, "routes")
        require(table["VpcId"] == vpc["VpcId"], "route table outside placement")
        if not any(route.get("DestinationCidrBlock") == "0.0.0.0/0" and route.get("GatewayId") == gateway["InternetGatewayId"] for route in table["Routes"]):
            self.ec2.create_route(RouteTableId=table["RouteTableId"], DestinationCidrBlock="0.0.0.0/0", GatewayId=gateway["InternetGatewayId"])
        for subnet in subnets:
            if not any(a.get("SubnetId") == subnet["SubnetId"] for a in table["Associations"]):
                self.ec2.associate_route_table(RouteTableId=table["RouteTableId"], SubnetId=subnet["SubnetId"])
        endpoint = self.one(self.items('describe_vpc_endpoints', 'VpcEndpoints', Filters=self.filters("s3-endpoint")))
        if not endpoint:
            self.ec2.create_vpc_endpoint(VpcId=vpc["VpcId"], VpcEndpointType="Gateway", ServiceName=f"com.amazonaws.{self.region}.s3",
                RouteTableIds=[table["RouteTableId"]], TagSpecifications=self.tag_spec("vpc-endpoint", "s3-endpoint"))
        return subnets

    def group(self, component):
        group = self.one(self.items('describe_security_groups', 'SecurityGroups', Filters=self.filters(component)))
        if not group:
            result = self.ec2.create_security_group(GroupName=self.prefix + "-" + component, Description="Nebula managed confidential runtime",
                VpcId=self.placement["vpcId"], TagSpecifications=self.tag_spec("security-group", component))
            group = self.items('describe_security_groups', 'SecurityGroups', GroupIds=[result["GroupId"]])[0]
        require(self.owned(group, component)["VpcId"] == self.placement["vpcId"], "security group outside placement")
        return group["GroupId"]

    def ingress(self, group, protocol, port, component, source=None, cidr=None):
        permission = {"IpProtocol": protocol, "FromPort": port, "ToPort": port}
        permission.update({"UserIdGroupPairs": [{"GroupId": source}]} if source else {"IpRanges": [{"CidrIp": cidr}]})
        try:
            self.ec2.authorize_security_group_ingress(GroupId=group, IpPermissions=[permission], TagSpecifications=self.tag_spec("security-group-rule", component))
        except ClientError as error:
            if not absent(error, "InvalidPermission.Duplicate"):
                raise

    def interfaces(self, subnets, authority_group):
        interfaces = []
        for slot, subnet in enumerate(subnets):
            component = f"authority-interface-{slot}"
            interface = self.one(self.items('describe_network_interfaces', 'NetworkInterfaces', Filters=self.filters(component)))
            if not interface:
                interface = self.ec2.create_network_interface(SubnetId=subnet["SubnetId"], Groups=[authority_group],
                    Description=component, ClientToken=hashlib.sha256((self.deployment + component).encode()).hexdigest(),
                    TagSpecifications=self.tag_spec("network-interface", component))["NetworkInterface"]
            require(self.owned(interface, component)["SubnetId"] == subnet["SubnetId"], "authority slot changed subnets")
            address = self.one(self.items('describe_addresses', 'Addresses', Filters=self.filters(f"authority-address-{slot}")))
            if not address:
                address = self.ec2.allocate_address(Domain="vpc", TagSpecifications=self.tag_spec("elastic-ip", f"authority-address-{slot}"))
            if address.get("NetworkInterfaceId") != interface["NetworkInterfaceId"]:
                self.ec2.associate_address(AllocationId=address["AllocationId"], NetworkInterfaceId=interface["NetworkInterfaceId"], AllowReassociation=False)
            interfaces.append({**interface, "PublicAddress": address["PublicIp"]})
        return interfaces

    def authority(self, slot, interface, image, common, cursors, allow_replace, previous_peer=None):
        component = f"authority-{slot}"
        reservations = self.items('describe_instances', 'Reservations', Filters=self.filters(component))
        instances = [instance for reservation in reservations for instance in reservation["Instances"]
                     if instance["State"]["Name"] not in ("shutting-down", "terminated")]
        instance = self.one(instances)
        if instance:
            self.owned(instance, component)
            require(instance["ImageId"] == image, "authority release upgrade needs an authorized membership transition")
            # Recover the gap after RunInstances accepted a request but the
            # response or status write was lost. The AWS tags are atomic with
            # instance creation; do not accidentally reuse this TPM's disk.
            tags = {t["Key"]: t["Value"] for t in instance["Tags"]}
            volume_id = tags["NebulaCocoStateVolume"]
            recovered = {**cursors.setdefault("authorities", {}).get(str(slot), {}),
                         "volume": volume_id, "instance": instance["InstanceId"],
                         "generation": int(tags.get("NebulaCocoGeneration", "0"))}
            if cursors.setdefault("authorities", {}).get(str(slot)) != recovered:
                cursors["authorities"][str(slot)] = recovered
                self.checkpoint("RecoveringProvisioningReceipt", cursors)
            if instance["State"]["Name"] == "stopped":
                self.ec2.start_instances(InstanceIds=[instance["InstanceId"]])
            return instance
        previous = cursors.setdefault("authorities", {}).get(str(slot))
        replacing = bool(previous and previous.get("instance"))
        if previous and previous.get("instance"):
            require(allow_replace and previous_peer, "quorum required before replacing an enrolled replica")
            # A new TPM receives a fresh disk and joins the surviving authority.
            # The old encrypted disk is retained until membership confirms it.
            previous = {"generation": previous.get("generation", 0) + 1,
                        "retired": previous.get("retired", []) + [previous["volume"]], "previousPeer": previous_peer}
            cursors["authorities"][str(slot)] = previous
            self.checkpoint("PreparingReplicaReplacement", cursors)
        if not previous:
            previous = {"generation": 0, "retired": []}
            cursors["authorities"][str(slot)] = previous
            self.checkpoint("PreparingAuthority", cursors)
        if not previous.get("volume"):
            token = hashlib.sha256((self.deployment + component + str(previous["generation"])).encode()).hexdigest()
            volume = self.ec2.create_volume(AvailabilityZone=interface["AvailabilityZone"], Encrypted=True,
                ClientToken=token, Size=1, VolumeType="gp3", TagSpecifications=self.tag_spec("volume", f"state-{slot}"))
            previous["volume"] = volume["VolumeId"]
            self.checkpoint("BootstrappingAuthority", cursors)
        volume = self.owned(self.items('describe_volumes', 'Volumes', VolumeIds=[previous["volume"]])[0], f"state-{slot}")
        if volume["State"] != "available":
            raise Pending("WaitingForStateVolume")
        require(interface["Status"] == "available", "authority network slot is still attached")
        userdata = json.dumps({"deployment": self.deployment, "stateVolume": volume["VolumeId"], "version": 1}, separators=(",", ":"))
        profile = self.iam.get_instance_profile(InstanceProfileName=self.prefix + "-guest")["InstanceProfile"]
        token = hashlib.sha256((self.deployment + component + volume["VolumeId"]).encode()).hexdigest()
        extra = [{"Key": "nebula-coco-bucket", "Value": self.bucket}, {"Key": "nebula-coco-deployment", "Value": self.deployment},
                 {"Key": "NebulaCocoStateVolume", "Value": volume["VolumeId"]},
                 {"Key": "NebulaCocoGeneration", "Value": str(previous["generation"])}]
        result = self.ec2.run_instances(ImageId=image, InstanceType=INSTANCE_TYPE, MinCount=1, MaxCount=1,
            ClientToken=token, UserData=userdata, IamInstanceProfile={"Arn": profile["Arn"]},
            NetworkInterfaces=[{"NetworkInterfaceId": interface["NetworkInterfaceId"], "DeviceIndex": 0, "DeleteOnTermination": False}],
            CpuOptions={"AmdSevSnp": "enabled"}, MetadataOptions={"HttpEndpoint": "enabled", "HttpTokens": "required",
                "HttpPutResponseHopLimit": 1, "InstanceMetadataTags": "enabled"},
            BlockDeviceMappings=[{"DeviceName": "/dev/sda1", "Ebs": {"Encrypted": True, "DeleteOnTermination": True, "VolumeType": "gp3"}}],
            TagSpecifications=[{"ResourceType": "instance", "Tags": self.tags(component) + extra},
                {"ResourceType": "volume", "Tags": self.tags(f"authority-root-{slot}")}])
        instance = result["Instances"][0]
        previous["instance"] = instance["InstanceId"]
        self.checkpoint("BootstrappingAuthority", cursors)
        return {**instance, "NebulaReplacement": replacing}

    def collect_retired(self, interfaces, health, cursors):
        require(health and len(health["voters"]) == 3 and not health["joint"] and not health["replacing"],
                "current uniform quorum required for state collection")
        for slot, interface in enumerate(interfaces):
            cursor = cursors.get("authorities", {}).get(str(slot), {})
            member = next((peer for peer in health["voters"].values() if peer["address"] == interface["PrivateIpAddress"] + ":9443"), None)
            if not cursor.get("previousPeer") or not member or member["publicKey"] == cursor["previousPeer"]: continue
            for volume_id in list(cursor.get("retired", [])):
                require(volume_id != cursor["volume"], "active state volume cannot be collected")
                try:
                    volume = self.owned(self.items("describe_volumes", "Volumes", VolumeIds=[volume_id])[0], f"state-{slot}")
                    if volume["Attachments"] or volume["State"] != "available": continue
                    self.remove("delete_volume", VolumeId=volume_id)
                except ClientError as error:
                    if not absent(error, "InvalidVolume.NotFound"): raise
                cursor["retired"].remove(volume_id)
                self.checkpoint("CollectingRetiredReplica", cursors)

    def attach_state(self, instance):
        tags = {item["Key"]: item["Value"] for item in instance["Tags"]}
        volume_id = tags["NebulaCocoStateVolume"]
        volume = self.owned(self.items('describe_volumes', 'Volumes', VolumeIds=[volume_id])[0])
        if any(attachment["InstanceId"] == instance["InstanceId"] for attachment in volume["Attachments"]):
            return
        require(not volume["Attachments"], "state volume is attached to another instance")
        if instance["State"]["Name"] != "running" or volume["State"] != "available":
            raise Pending("WaitingForStateAttachment")
        self.ec2.attach_volume(InstanceId=instance["InstanceId"], VolumeId=volume_id, Device="/dev/sdf")

    def runtime_template(self, image, subnet, security_group, release):
        name = self.prefix + "-runtime-" + release[:16]
        found = self.items('describe_launch_templates', 'LaunchTemplates', Filters=self.filters("runtime-template-" + release[:16]))
        if found:
            return self.owned(self.one(found))["LaunchTemplateName"]
        profile = self.iam.get_instance_profile(InstanceProfileName=self.prefix + "-guest")["InstanceProfile"]
        self.ec2.create_launch_template(LaunchTemplateName=name,
            ClientToken=hashlib.sha256((self.deployment + release).encode()).hexdigest(),
            TagSpecifications=self.tag_spec("launch-template", "runtime-template-" + release[:16]),
            LaunchTemplateData={"ImageId": image, "InstanceType": INSTANCE_TYPE,
                "IamInstanceProfile": {"Arn": profile["Arn"]}, "CpuOptions": {"AmdSevSnp": "enabled"},
                "MetadataOptions": {"HttpEndpoint": "enabled", "HttpTokens": "required", "HttpPutResponseHopLimit": 1, "InstanceMetadataTags": "enabled"},
                "NetworkInterfaces": [{"DeviceIndex": 0, "SubnetId": subnet, "Groups": [security_group],
                    # Public egress for pinned OCI layers, without a separately
                    # operated NAT gateway. Inbound access remains worker-only.
                    "AssociatePublicIpAddress": True, "DeleteOnTermination": True}],
                "BlockDeviceMappings": [{"DeviceName": "/dev/sda1", "Ebs": {"Encrypted": True, "DeleteOnTermination": True, "VolumeType": "gp3"}}],
                "TagSpecifications": [{"ResourceType": "instance", "Tags": self.tags("runtime") + [
                    {"Key": "nebula-coco-bucket", "Value": self.bucket}, {"Key": "nebula-coco-deployment", "Value": self.deployment}]},
                    {"ResourceType": "volume", "Tags": self.tags("runtime-root")}]})
        return name

    def delete(self, cursors=None):
        """One deletion pass, solely over tags in this installation's namespace.

        The Kubernetes finalizer is retained until all owned AWS dependencies
        have disappeared. Existing platform VPCs, worker groups and gateways are
        never swept by name or by an account-wide delete.
        """
        changed = False
        def inventory(operation, key, **parameters):
            nonlocal changed
            values = self.items(operation, key, **parameters)
            changed |= bool(values)
            return values
        # CAA always launches through this template. Remove it before sweeping
        # instances so a queued Pod cannot recreate a guest during teardown.
        for template in inventory('describe_launch_templates', 'LaunchTemplates', Filters=self.filters()):
            self.remove("delete_launch_template", LaunchTemplateId=self.owned(template)["LaunchTemplateId"])
        reservations = self.items('describe_instances', 'Reservations', Filters=self.filters())
        if any(instance["State"]["Name"] == "shutting-down" for reservation in reservations for instance in reservation["Instances"]):
            raise Pending("TerminatingOwnedGuests")
        live = [self.owned(instance) for reservation in reservations for instance in reservation["Instances"]
                if instance["State"]["Name"] not in ("terminated", "shutting-down")]
        if live:
            for start in range(0, len(live), 1000):
                self.ec2.terminate_instances(InstanceIds=[instance["InstanceId"] for instance in live[start:start + 1000]])
            raise Pending("TerminatingOwnedGuests")
        for volume in inventory('describe_volumes', 'Volumes', Filters=self.filters()):
            self.owned(volume)
            if volume["State"] != "available":
                raise Pending("DetachingOwnedVolumes")
            self.remove("delete_volume", VolumeId=volume["VolumeId"])
        for image in inventory('describe_images', 'Images', Owners=["self"], Filters=self.filters()):
            self.remove("deregister_image", ImageId=self.owned(image)["ImageId"])
        for snapshot in inventory('describe_snapshots', 'Snapshots', OwnerIds=["self"], Filters=self.filters()):
            self.remove("delete_snapshot", SnapshotId=self.owned(snapshot)["SnapshotId"])
        for address in inventory('describe_addresses', 'Addresses', Filters=self.filters()):
            self.owned(address)
            if address.get("AssociationId"):
                self.remove("disassociate_address", AssociationId=address["AssociationId"])
            self.remove("release_address", AllocationId=address["AllocationId"])
        for interface in inventory('describe_network_interfaces', 'NetworkInterfaces', Filters=self.filters()):
            self.owned(interface)
            if interface["Status"] != "available":
                raise Pending("DetachingOwnedInterfaces")
            self.remove("delete_network_interface", NetworkInterfaceId=interface["NetworkInterfaceId"])
        rules = inventory('describe_security_group_rules', 'SecurityGroupRules', Filters=self.filters())
        for rule in rules:
            self.owned(rule)
            operation = "revoke_security_group_egress" if rule["IsEgress"] else "revoke_security_group_ingress"
            self.remove(operation, GroupId=rule["GroupId"], SecurityGroupRuleIds=[rule["SecurityGroupRuleId"]])
        for group in inventory('describe_security_groups', 'SecurityGroups', Filters=self.filters()):
            self.remove("delete_security_group", GroupId=self.owned(group)["GroupId"])
        endpoints = inventory('describe_vpc_endpoints', 'VpcEndpoints', Filters=self.filters())
        if endpoints:
            self.ec2.delete_vpc_endpoints(VpcEndpointIds=[self.owned(endpoint)["VpcEndpointId"] for endpoint in endpoints])
            raise Pending("DeletingOwnedEndpoints")
        for table in inventory('describe_route_tables', 'RouteTables', Filters=self.filters()):
            self.owned(table)
            for association in table["Associations"]:
                require(not association.get("Main"), "owned table became the platform main table")
                self.remove("disassociate_route_table", AssociationId=association["RouteTableAssociationId"])
            self.remove("delete_route_table", RouteTableId=table["RouteTableId"])
        for subnet in inventory('describe_subnets', 'Subnets', Filters=self.filters()):
            self.remove("delete_subnet", SubnetId=self.owned(subnet)["SubnetId"])
        for gateway in inventory('describe_internet_gateways', 'InternetGateways', Filters=self.filters()):
            self.owned(gateway)
            for attachment in gateway["Attachments"]:
                require(attachment["VpcId"] == self.placement["vpcId"], "gateway attached outside placement")
                self.ec2.detach_internet_gateway(InternetGatewayId=gateway["InternetGatewayId"], VpcId=attachment["VpcId"])
            self.remove("delete_internet_gateway", InternetGatewayId=gateway["InternetGatewayId"])
        try:
            try:
                tags = self.s3.get_bucket_tagging(Bucket=self.bucket)["TagSet"]
                require({tag["Key"]: tag["Value"] for tag in tags}.get(OWNER) == self.deployment, "foreign bucket refused")
            except ClientError as error:
                # Deletion can interrupt the same create-before-tag gap that
                # storage() resumes. Never create a bucket just to delete it.
                if not absent(error, "NoSuchTagSet") or (cursors or {}).get("creatingBucket") != self.bucket:
                    raise
                self.s3.head_bucket(Bucket=self.bucket, ExpectedBucketOwner=self.account)
            for page in self.s3.get_paginator("list_objects_v2").paginate(Bucket=self.bucket):
                objects = [{"Key": item["Key"]} for item in page.get("Contents", [])]
                if objects:
                    result = self.s3.delete_objects(Bucket=self.bucket, Delete={"Objects": objects, "Quiet": True})
                    require(not result.get("Errors"), "owned bucket deletion incomplete")
            self.s3.delete_bucket(Bucket=self.bucket)
            changed = True
        except ClientError as error:
            if not absent(error, "NoSuchBucket"):
                raise
        if changed: raise Pending("ConfirmingOwnedResourcesDeleted")
