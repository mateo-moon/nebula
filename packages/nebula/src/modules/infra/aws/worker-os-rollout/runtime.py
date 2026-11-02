"""Kubernetes HTTPS + IRSA-backed AWS clients. Credentials stay in mounted files.

Logs and checkpoints contain resource identities, phases and bounded reasons.
They never contain kubeconfigs, user-data, SSM output or bootstrap material.
"""
import base64
import datetime
import json
import os
from pathlib import Path
import shlex
import ssl
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

import boto3
from botocore.exceptions import ClientError
import yaml
from engine import Hold, Unsafe, Replacement, acknowledged, digest, validate_inventory

PAUSE = 'cluster.x-k8s.io/paused'
SKIP = 'cluster.x-k8s.io/skip-remediation'


class Kube:
    def __init__(self, server, context, headers=None):
        self.server, self.context, self.headers = server.rstrip('/'), context, headers or {}

    @classmethod
    def local(cls):
        root = Path('/var/run/secrets/kubernetes.io/serviceaccount')
        client = cls('https://kubernetes.default.svc', ssl.create_default_context(cafile=str(root/'ca.crt')))
        client.token_file = root/'token'
        return client

    @classmethod
    def workload(cls):
        config = yaml.safe_load(Path('/etc/workload/value').read_text())
        current = next(x['context'] for x in config['contexts'] if x['name'] == config['current-context'])
        cluster = next(x['cluster'] for x in config['clusters'] if x['name'] == current['cluster'])
        user = next(x['user'] for x in config['users'] if x['name'] == current['user'])
        if not cluster['server'].startswith('https://') or cluster.get('insecure-skip-tls-verify'):
            raise Unsafe('Workload API requires verified TLS')
        context = ssl.create_default_context(cadata=base64.b64decode(cluster['certificate-authority-data']).decode())
        # Only existing certificate credentials; no kubeconfig exec plugins.
        with tempfile.TemporaryDirectory() as directory:
            cert, key = Path(directory)/'cert', Path(directory)/'key'
            for path, field in ((cert, 'client-certificate-data'), (key, 'client-key-data')):
                path.write_bytes(base64.b64decode(user[field])); path.chmod(0o600)
            context.load_cert_chain(str(cert), str(key))
        return cls(cluster['server'], context)

    def call(self, method, path, body=None, content_type='application/json'):
        headers = dict(self.headers)
        if hasattr(self, 'token_file'): headers['Authorization'] = 'Bearer ' + self.token_file.read_text().strip()
        request = urllib.request.Request(self.server + path, method=method,
            data=None if body is None else json.dumps(body).encode(),
            headers={**headers, 'Content-Type': content_type})
        try:
            with urllib.request.urlopen(request, context=self.context, timeout=30) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            if error.code == 404: return None
            if error.code in (409, 429, 500, 502, 503, 504): raise Hold('Kubernetes API is retrying') from None
            raise Unsafe('Kubernetes request rejected: ' + str(error.code)) from None

    def patch(self, path, obj, change):
        return self.call('PATCH', path, {'metadata': {'resourceVersion': obj['metadata']['resourceVersion']}, **change}, 'application/merge-patch+json')


class Journal:
    def __init__(self, kube, path): self.kube, self.path = kube, path
    def read(self):
        obj = self.kube.call('GET', self.path)
        if not obj: raise Hold('Journal is not available')
        self.observed = obj
        return json.loads(obj.get('data', {}).get('progress', '{}'))
    def save(self, state):
        self.kube.patch(self.path, self.observed, {'data': {'progress': json.dumps(state, sort_keys=True)}})


class Operations:
    def __init__(self, request, kube, workload, aws=None):
        self.r, self.k, self.w = request, kube, workload
        self.aws = aws
        if self.aws is None:
            session = boto3.Session(region_name=request['region'])
            self.aws = {name: session.client(name) for name in ('ec2', 'autoscaling', 'ssm', 'sts')}
        self.ns = '/namespaces/' + request['namespace']
        self.core = '/api/v1' + self.ns
        self.capi = '/apis/cluster.x-k8s.io/v1beta2' + self.ns
        self.infra = '/apis/infrastructure.cluster.x-k8s.io/v1beta2' + self.ns

    def check_deadline(self):
        deadline = datetime.datetime.fromisoformat(self.r['deadline'].replace('Z', '+00:00'))
        if datetime.datetime.now(datetime.timezone.utc) >= deadline: raise Unsafe('Replacement deadline expired')

    def acquire(self, request_hash):
        path = self.core + '/configmaps/' + self.r['lockName']
        obj = self.k.call('GET', path)
        if not obj: raise Hold('Worker lock is not available')
        owner = obj.get('data', {}).get('owner')
        if owner and owner != request_hash: raise Unsafe('Another generation holds the worker lock')
        self.k.patch(path, obj, {'data': {'owner': request_hash}})

    def release(self, request_hash):
        path = self.core + '/configmaps/' + self.r['lockName']
        obj = self.k.call('GET', path)
        if obj.get('data', {}).get('owner') != request_hash: return
        self.k.patch(path, obj, {'data': {'owner': ''}})

    def required(self, path):
        obj = self.k.call('GET', path)
        if not obj: raise Hold('Required resource is not available')
        return obj

    def resources(self):
        node = self.r['nodeName']
        paths = {
            'worker': '/apis/nebula.io/v1alpha1/xworkers/' + node,
            'asg': '/apis/autoscaling.aws.upbound.io/v1beta1/autoscalinggroups/' + node,
            'template': '/apis/ec2.aws.upbound.io/v1beta1/launchtemplates/' + self.r['launchTemplateName'],
            'eip': '/apis/ec2.aws.upbound.io/v1beta1/eips/' + self.r['eipName'],
        }
        if self.r.get('dataVolumeName'): paths['data'] = '/apis/ec2.aws.upbound.io/v1beta1/ebsvolumes/' + self.r['dataVolumeName']
        result = {key: self.required(path) for key, path in paths.items()}
        if result['worker']['metadata'].get('annotations', {}).get('crossplane.io/paused') != 'true':
            raise Unsafe('Worker inventory must be paused for the replacement boundary')
        for key, obj in result.items():
            if key == 'worker': continue
            if not acknowledged(obj): raise Hold('Waiting for current provider acknowledgement')
            spec, observed = obj['spec'], obj['status']['atProvider']
            if spec['providerConfigRef']['name'] != self.r['providerConfigName']:
                raise Unsafe('Foreign provider binding')
            if spec['forProvider']['region'] != self.r['region'] or observed.get('region') != self.r['region']:
                raise Unsafe('Foreign region binding')
            external = obj['metadata'].get('annotations', {}).get('crossplane.io/external-name')
            actual = (observed.get('id') or observed.get('name')) if key == 'asg' else observed.get('id')
            if not external or external != actual: raise Unsafe('Managed-resource external binding mismatch')
            if key in ('eip', 'data') and (spec.get('deletionPolicy') != 'Orphan' or 'Delete' in spec.get('managementPolicies', [])):
                raise Unsafe('Retained address/data must have an orphan policy without Delete')
        return result

    @staticmethod
    def bindings(resources):
        return {key: {'uid': obj['metadata']['uid'], 'generation': obj['metadata']['generation'],
                     'externalName': obj['metadata'].get('annotations', {}).get('crossplane.io/external-name')}
                for key, obj in resources.items()}

    def validate_bindings(self, baseline):
        if self.bindings(self.resources()) != baseline['bindings']: raise Unsafe('Saved resource UID, generation or binding changed')
        self.validate_target_template(baseline)
        images = self.aws['ec2'].describe_images(ImageIds=[self.r['targetAmi']])['Images']
        expected_arch = 'x86_64' if self.r['hostProfile']['architecture'] == 'amd64' else 'arm64'
        if (len(images) != 1 or images[0]['OwnerId'] != self.r['accountId'] or images[0]['State'] != 'available'
            or images[0]['Architecture'] != expected_arch or images[0]['RootDeviceName'] != self.r['hostProfile']['rootDeviceName']):
            raise Unsafe('Target image must be a qualified private image with the requested architecture/root mapping')

    def group(self):
        groups = self.aws['autoscaling'].describe_auto_scaling_groups(AutoScalingGroupNames=[self.r['nodeName']])['AutoScalingGroups']
        if len(groups) != 1: raise Unsafe('Expected one named ASG')
        group = groups[0]
        if (group['MinSize'], group['MaxSize'], group['DesiredCapacity']) != (1, 1, 1): raise Unsafe('Replacement requires unchanged size-one capacity')
        return group

    def instance(self, iid):
        reservations = self.aws['ec2'].describe_instances(InstanceIds=[iid])['Reservations']
        instances = [x for row in reservations for x in row['Instances']]
        if len(instances) != 1: raise Hold('Waiting for exact instance observation')
        return instances[0]

    def validate_target_template(self, baseline):
        group = self.group()
        lt = group.get('LaunchTemplate') or group.get('MixedInstancesPolicy', {}).get('LaunchTemplate', {}).get('LaunchTemplateSpecification')
        if not lt or str(lt['Version']) != self.r['launchTemplateVersion'] or lt['LaunchTemplateId'] != baseline['launchTemplateId']:
            raise Unsafe('ASG launch template must be pinned to the saved numeric version')
        versions = self.aws['ec2'].describe_launch_template_versions(LaunchTemplateId=lt['LaunchTemplateId'], Versions=[self.r['launchTemplateVersion']])['LaunchTemplateVersions']
        if len(versions) != 1 or versions[0]['LaunchTemplateData']['ImageId'] != self.r['targetAmi']:
            raise Unsafe('Target launch-template version/AMI changed')

    def volume(self, volume_id):
        volumes = self.aws['ec2'].describe_volumes(VolumeIds=[volume_id])['Volumes']
        if len(volumes) != 1: raise Unsafe('Retained data volume is missing')
        return volumes[0]

    def ssm(self, iid, command, timeout=120):
        # Only fixed read-only checks or idempotent stop/unmount commands. Do not
        # print command output: it may include private host details on failure.
        info = self.aws['ssm'].describe_instance_information(Filters=[{'Key': 'InstanceIds', 'Values': [iid]}])['InstanceInformationList']
        if len(info) != 1 or info[0]['PingStatus'] != 'Online': raise Hold('Waiting for SSM connectivity')
        cid = self.aws['ssm'].send_command(InstanceIds=[iid], DocumentName='AWS-RunShellScript',
            Parameters={'commands': [command], 'executionTimeout': [str(timeout)]}, TimeoutSeconds=timeout)['Command']['CommandId']
        end = time.monotonic() + timeout + 30
        while time.monotonic() < end:
            try:
                result = self.aws['ssm'].get_command_invocation(CommandId=cid, InstanceId=iid)
            except ClientError as error:
                if error.response['Error']['Code'] == 'InvocationDoesNotExist': time.sleep(2); continue
                raise
            if result['Status'] == 'Success': return result['StandardOutputContent'].strip()
            if result['Status'] in ('Failed', 'Cancelled', 'TimedOut'): raise Unsafe('Host command failed; inspect private SSM evidence')
            time.sleep(2)
        raise Hold('Waiting for bounded SSM command completion')

    def host_identity(self, iid):
        command = 'set -eu; cat /etc/machine-id; hostname; '
        if self.r.get('dataVolumeName'):
            command += "vgs --noheadings -o vg_uuid " + shlex.quote(self.r['dataVgName']) + "; lvs --noheadings --sort lv_uuid -o lv_uuid " + shlex.quote(self.r['dataVgName'])
        return self.ssm(iid, command).splitlines()

    def prepare(self):
        resources = self.resources()
        if self.aws['sts'].get_caller_identity()['Account'] != self.r['accountId']: raise Unsafe('Foreign AWS account')
        group = self.group()
        if len(group['Instances']) != 1 or group['Instances'][0]['LifecycleState'] != 'InService': raise Hold('Source ASG is not stable')
        source = self.instance(group['Instances'][0]['InstanceId'])
        if source['Placement']['AvailabilityZone'] != self.r['availabilityZone']: raise Unsafe('Source AZ changed')
        if source['ImageId'] == self.r['targetAmi']: raise Unsafe('Source already uses target AMI; review a fresh attempt')
        if dict((x['Key'], x['Value']) for x in source.get('Tags', [])).get('aws:autoscaling:groupName') != self.r['nodeName']:
            raise Unsafe('Source does not belong to the named ASG')
        baseline = {'bindings': self.bindings(resources), 'sourceInstanceId': source['InstanceId'],
                    'launchTemplateId': resources['template']['status']['atProvider']['id'],
                    'eipAllocationId': resources['eip']['status']['atProvider']['id'],
                    'sourceRootVolumeId': next(x['Ebs']['VolumeId'] for x in source['BlockDeviceMappings'] if x['DeviceName'] == source['RootDeviceName'])}
        self.validate_target_template(baseline)
        address = self.aws['ec2'].describe_addresses(AllocationIds=[baseline['eipAllocationId']])['Addresses']
        if len(address) != 1 or address[0].get('InstanceId') != source['InstanceId']: raise Unsafe('Source EIP binding mismatch')
        if 'data' in resources:
            baseline['dataVolumeId'] = resources['data']['status']['atProvider']['id']
            volume = self.volume(baseline['dataVolumeId'])
            attachments = volume['Attachments']
            mapping = [x for x in source['BlockDeviceMappings'] if x['Ebs']['VolumeId'] == baseline['dataVolumeId']]
            if (volume['AvailabilityZone'] != self.r['availabilityZone'] or len(attachments) != 1 or attachments[0]['InstanceId'] != source['InstanceId']
                or attachments[0]['State'] != 'attached' or len(mapping) != 1 or mapping[0]['Ebs']['DeleteOnTermination']):
                raise Unsafe('Retained disk ownership or delete-on-termination is unsafe')
        pool = self.required(self.infra + '/pooledremotemachines/' + self.r['nodeName'])
        if pool['spec']['machine']['user'] != self.r['sourceSshUser'] or not pool.get('status', {}).get('reserved'):
            raise Unsafe('Source inventory login or reservation changed')
        remote = self.required(self.infra + '/remotemachines/' + pool['status']['machineRef']['name'])
        validate_inventory(resources['worker'], pool, remote, self.r['nodeName'], self.r['namespace'], address[0]['PublicIp'], self.r['sourceSshUser'])
        if remote['spec']['user'] != self.r['sourceSshUser'] or remote.get('metadata', {}).get('deletionTimestamp'):
            raise Unsafe('Source RemoteMachine login or lifecycle changed')
        machine_ref = next(x for x in remote['metadata']['ownerReferences'] if x['kind'] == 'Machine' and x.get('controller'))
        machine = self.required(self.capi + '/machines/' + machine_ref['name'])
        if machine['metadata']['uid'] != machine_ref['uid'] or machine.get('status', {}).get('nodeRef', {}).get('name') != self.r['nodeName']:
            raise Unsafe('Source Machine/node ownership changed')
        machine_set_ref = next(x for x in machine['metadata']['ownerReferences'] if x['kind'] == 'MachineSet' and x.get('controller'))
        machine_set = self.required(self.capi + '/machinesets/' + machine_set_ref['name'])
        deployment = self.required(self.capi + '/machinedeployments/' + self.r['nodeName'])
        if machine_set['metadata']['uid'] != machine_set_ref['uid'] or not any(x.get('uid') == deployment['metadata']['uid'] and x.get('controller') for x in machine_set['metadata']['ownerReferences']):
            raise Unsafe('Source MachineSet ownership changed')
        if deployment['spec']['replicas'] != 1 or machine.get('metadata', {}).get('deletionTimestamp'): raise Unsafe('Source enrollment is unstable')
        if any(x['metadata'].get('annotations', {}).get(PAUSE) == 'true' for x in (deployment, machine_set)):
            raise Unsafe('Another workflow paused CAPI assignment')
        source_node = self.w.call('GET', '/api/v1/nodes/' + self.r['nodeName'])
        if not source_node: raise Hold('Source Node observation is missing')
        baseline.update(sourceMachine={'name': machine['metadata']['name'], 'uid': machine['metadata']['uid']},
            sourceRemote={'name': remote['metadata']['name'], 'uid': remote['metadata']['uid'], 'specHash': digest(remote['spec'])},
            machineSet={'name': machine_set['metadata']['name'], 'uid': machine_set['metadata']['uid'], 'pause': machine_set['metadata'].get('annotations', {}).get(PAUSE)},
            deployment={'uid': deployment['metadata']['uid'], 'pause': deployment['metadata'].get('annotations', {}).get(PAUSE)},
            poolUid=pool['metadata']['uid'], sourceNodeUid=source_node['metadata']['uid'], sourceIdentity=self.host_identity(source['InstanceId']))
        if len(baseline['sourceIdentity']) < 2 or baseline['sourceIdentity'][1] != self.r['nodeName']: raise Unsafe('Source host identity mismatch')
        if source_node.get('status', {}).get('nodeInfo', {}).get('machineID') != baseline['sourceIdentity'][0]:
            raise Unsafe('Source Node does not belong to the observed cloud instance')
        return baseline

    def hold_assignment(self, b):
        for plural, name, uid in [('machinedeployments', self.r['nodeName'], b['deployment']['uid']),
                                   ('machinesets', b['machineSet']['name'], b['machineSet']['uid'])]:
            path = self.capi + '/' + plural + '/' + name
            obj = self.required(path)
            if obj['metadata']['uid'] != uid: raise Unsafe('CAPI assignment owner changed')
            self.k.patch(path, obj, {'metadata': {'resourceVersion': obj['metadata']['resourceVersion'], 'annotations': {PAUSE: 'true'}}})
        path = self.capi + '/machines/' + b['sourceMachine']['name']
        obj = self.k.call('GET', path)
        if obj:
            if obj['metadata']['uid'] != b['sourceMachine']['uid']: raise Unsafe('Source Machine name was reused')
            self.k.patch(path, obj, {'metadata': {'resourceVersion': obj['metadata']['resourceVersion'], 'annotations': {SKIP: 'true'}}})

    def drain(self, b):
        node_path = '/api/v1/nodes/' + self.r['nodeName']
        node = self.w.call('GET', node_path)
        if node: self.w.patch(node_path, node, {'spec': {'unschedulable': True}})
        pods = self.w.call('GET', '/api/v1/pods?fieldSelector=' + urllib.parse.quote('spec.nodeName=' + self.r['nodeName']))['items']
        waiting = False
        for pod in pods:
            meta = pod['metadata']
            if 'kubernetes.io/config.mirror' in meta.get('annotations', {}) or any(x['kind'] == 'DaemonSet' for x in meta.get('ownerReferences', [])): continue
            if pod.get('status', {}).get('phase') in ('Succeeded', 'Failed'): continue
            waiting = True
            if not meta.get('deletionTimestamp'):
                self.w.call('POST', '/api/v1/namespaces/' + meta['namespace'] + '/pods/' + meta['name'] + '/eviction',
                    {'apiVersion': 'policy/v1', 'kind': 'Eviction', 'metadata': {'name': meta['name'], 'namespace': meta['namespace']},
                     'deleteOptions': {'preconditions': {'uid': meta['uid']}}})
        if waiting: raise Hold('Waiting for PDB-respecting drain')
        attachments = self.w.call('GET', '/apis/storage.k8s.io/v1/volumeattachments')['items']
        if any(x['spec']['nodeName'] == self.r['nodeName'] for x in attachments): raise Hold('Waiting for CSI detach')

    def cleanup_old_machine(self, b):
        path = self.capi + '/machines/' + b['sourceMachine']['name']
        machine = self.k.call('GET', path)
        if machine:
            if machine['metadata']['uid'] != b['sourceMachine']['uid']: raise Unsafe('Source Machine name reused')
            remote = self.k.call('GET', self.infra + '/remotemachines/' + b['sourceRemote']['name'])
            if remote and (remote['metadata']['uid'] != b['sourceRemote']['uid'] or digest(remote['spec']) != b['sourceRemote']['specHash']):
                raise Unsafe('Source RemoteMachine address, login or identity changed before cleanup')
            self.k.call('DELETE', path, {'apiVersion': 'v1', 'kind': 'DeleteOptions', 'preconditions': {'uid': b['sourceMachine']['uid']}})
            raise Hold('Waiting for source Machine cleanup')
        if self.k.call('GET', self.infra + '/remotemachines/' + b['sourceRemote']['name']): raise Hold('Waiting for old RemoteMachine cleanup')
        pool = self.required(self.infra + '/pooledremotemachines/' + self.r['nodeName'])
        if pool['metadata']['uid'] != b['poolUid']: raise Unsafe('Inventory binding changed')
        if pool.get('status', {}).get('reserved'): raise Hold('Waiting for inventory release')
        remotes = self.k.call('GET', self.infra + '/remotemachines')['items']
        if any(x['spec'].get('pool') == self.r['nodeName'] for x in remotes): raise Unsafe('Another RemoteMachine claimed the held pool')

    def stop_writers(self, b):
        command = 'set -eu; if systemctl cat k0sworker >/dev/null 2>&1; then systemctl stop k0sworker; fi; sync; '
        if b.get('dataVolumeId'): command += 'vgchange -an ' + shlex.quote(self.r['dataVgName']) + '; '
        # An active mount or LV makes vgchange fail; never force unmount/detach.
        self.ssm(b['sourceInstanceId'], command + 'true')

    def detach_data(self, b):
        if not b.get('dataVolumeId'): return
        volume = self.volume(b['dataVolumeId'])
        if not volume['Attachments'] and volume['State'] == 'available': return
        if any(x['InstanceId'] != b['sourceInstanceId'] for x in volume['Attachments']): raise Unsafe('Data disk attached to another instance')
        if any(x['State'] == 'attached' for x in volume['Attachments']):
            self.aws['ec2'].detach_volume(VolumeId=b['dataVolumeId'], InstanceId=b['sourceInstanceId'], Force=False)
        raise Hold('Waiting for retained data to detach')

    def source_is_running(self, source):
        if any(x['InstanceId'] == source and x['LifecycleState'].startswith('Terminating') for x in self.group()['Instances']): return False
        return self.instance(source)['State']['Name'] not in ('shutting-down', 'terminated')

    def terminate_source(self, source):
        if not any(x['InstanceId'] == source for x in self.group()['Instances']): raise Unsafe('Source left the named ASG before termination')
        self.aws['autoscaling'].terminate_instance_in_auto_scaling_group(InstanceId=source, ShouldDecrementDesiredCapacity=False)

    def replacement(self, b):
        if self.instance(b['sourceInstanceId'])['State']['Name'] != 'terminated': raise Hold('Waiting for the original instance to terminate')
        members = self.group()['Instances']
        if len(members) != 1 or members[0]['InstanceId'] == b['sourceInstanceId'] or members[0]['LifecycleState'] != 'InService':
            raise Hold('Waiting for one replacement instance')
        return members[0]['InstanceId']

    def verify_host(self, target, b):
        instance = self.instance(target)
        if instance['ImageId'] != self.r['targetAmi'] or instance['Placement']['AvailabilityZone'] != self.r['availabilityZone']:
            raise Unsafe('Replacement AMI or AZ mismatch')
        if instance.get('LaunchTemplate', {}).get('LaunchTemplateId') != b['launchTemplateId'] or str(instance['LaunchTemplate']['Version']) != self.r['launchTemplateVersion']:
            raise Unsafe('Replacement booted a different template version')
        root = [x for x in instance['BlockDeviceMappings'] if x['DeviceName'] == self.r['hostProfile']['rootDeviceName']]
        if len(root) != 1 or root[0]['Ebs']['VolumeId'] == b['sourceRootVolumeId']: raise Unsafe('Replacement root disk mismatch')
        addresses = self.aws['ec2'].describe_addresses(AllocationIds=[b['eipAllocationId']])['Addresses']
        if len(addresses) != 1 or addresses[0].get('InstanceId') != target: raise Hold('Waiting for retained EIP association')
        if b.get('dataVolumeId'):
            attachments = self.volume(b['dataVolumeId'])['Attachments']
            if len(attachments) != 1 or attachments[0]['InstanceId'] != target or attachments[0]['State'] != 'attached': raise Hold('Waiting for retained data attachment')
            mapping = [x for x in instance['BlockDeviceMappings'] if x['Ebs']['VolumeId'] == b['dataVolumeId']]
            if len(mapping) != 1 or mapping[0]['Ebs']['DeleteOnTermination']: raise Unsafe('Replacement data retention is unsafe')
        self.ssm(target, 'set -eu; cloud-init status --wait; ' + self.r['hostCheck'], timeout=600)
        identity = self.host_identity(target)
        if len(identity) < 2 or identity[0] == b['sourceIdentity'][0] or identity[1:] != b['sourceIdentity'][1:]:
            raise Unsafe('Hostname, fresh machine identity or retained VG/LV UUIDs differ')

    def enroll(self, target, b):
        path = self.infra + '/pooledremotemachines/' + self.r['nodeName']
        pool = self.required(path)
        if pool['metadata']['uid'] != b['poolUid']: raise Unsafe('Inventory binding changed')
        if pool['spec']['machine']['user'] != self.r['hostProfile']['sshUser']:
            if pool.get('status', {}).get('reserved'): raise Unsafe('Inventory reserved before login transition')
            self.k.patch(path, pool, {'spec': {'machine': {'user': self.r['hostProfile']['sshUser'], 'useSudo': self.r['hostProfile'].get('useSudo', True)}}})
        for plural, name, original in [('machinesets', b['machineSet']['name'], b['machineSet']), ('machinedeployments', self.r['nodeName'], b['deployment'])]:
            path = self.capi + '/' + plural + '/' + name
            obj = self.required(path)
            if obj['metadata']['uid'] != original['uid']: raise Unsafe('CAPI owner changed at enrollment')
            self.k.patch(path, obj, {'metadata': {'resourceVersion': obj['metadata']['resourceVersion'], 'annotations': {PAUSE: original['pause']}}})

    def verify_node(self, target, b):
        node = self.w.call('GET', '/api/v1/nodes/' + self.r['nodeName'])
        if not node or not any(c['type'] == 'Ready' and c['status'] == 'True' for c in node.get('status', {}).get('conditions', [])): raise Hold('Waiting for replacement Node readiness')
        if node['metadata']['uid'] == b['sourceNodeUid'] or node['status']['nodeInfo']['machineID'] != self.host_identity(target)[0]:
            raise Hold('Waiting for the fresh host Node identity')
        machines = self.k.call('GET', self.capi + '/machines')['items']
        matches = [m for m in machines if m.get('status', {}).get('nodeRef', {}).get('name') == self.r['nodeName']]
        if len(matches) != 1 or matches[0]['metadata']['uid'] == b['sourceMachine']['uid']: raise Hold('Waiting for a new CAPI Machine')
        machine_name = matches[0]['metadata']['name']
        if node['metadata'].get('labels', {}).get('k0smotron.io/machine-name') != machine_name: raise Unsafe('Node enrolled to a different CAPI Machine')
        if node.get('spec', {}).get('unschedulable'):
            self.w.patch('/api/v1/nodes/' + self.r['nodeName'], node, {'spec': {'unschedulable': False}})


def main():
    request = json.loads(Path('/etc/rollout/request.json').read_text())
    kube = Kube.local()
    ops = Operations(request, kube, Kube.workload())
    journal = Journal(kube, ops.core + '/configmaps/' + request['journalName'])
    replacement = Replacement(request, journal, ops)
    while True:
        try:
            phase = replacement.step()
            print(json.dumps({'phase': phase, 'node': request['nodeName'], 'generation': request['generation']}), flush=True)
            if phase == 'Verified': return
            if phase == 'Failed': raise SystemExit(1)
        except Hold: pass
        except Unsafe as error:
            print(json.dumps({'phase': 'Failed', 'reason': str(error)}), flush=True)
            raise SystemExit(1)
        except ClientError as error:
            # AWS response text is intentionally excluded from logs.
            code = error.response.get('Error', {}).get('Code', '')
            if code not in ('Throttling', 'ThrottlingException', 'RequestLimitExceeded', 'InternalError', 'ServiceUnavailable'):
                journal.save({**journal.read(), 'requestHash': digest(request), 'phase': 'Failed', 'reason': 'AWS request rejected: ' + code})
                raise SystemExit(1)
        time.sleep(15)


if __name__ == '__main__': main()
