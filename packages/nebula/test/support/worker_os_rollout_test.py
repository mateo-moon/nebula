import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest

ROOT = Path(__file__).resolve().parents[2] / 'src/modules/infra/aws/worker-os-rollout'
sys.path.insert(0, str(ROOT))
from engine import Replacement, Hold, Unsafe, acknowledged, validate_inventory


class Journal:
    def __init__(self): self.value = {}; self.history = []
    def read(self): return copy.deepcopy(self.value)
    def save(self, value): self.value = copy.deepcopy(value); self.history.append(copy.deepcopy(value))


class Cloud:
    def __init__(self):
        self.source_running = True; self.calls = []; self.block = None; self.fail = None
        self.owner = None; self.old_remote = True; self.user = 'ubuntu'; self.source_terminated = False
    def action(self, name):
        self.calls.append(name)
        if self.block == name: raise Hold(name)
        if self.fail == name: raise Unsafe(name)
    def check_deadline(self): self.action('deadline')
    def acquire(self, owner):
        if self.owner and self.owner != owner: raise Unsafe('Concurrent generation')
        self.owner = owner
    def release(self, owner):
        if self.owner == owner: self.owner = None
    def prepare(self):
        self.action('prepare')
        return {'sourceInstanceId': 'i-original', 'bindings': {'worker': 'uid-original'}, 'eip': 'same-address', 'data': 'same-volume'}
    def validate_bindings(self, baseline): self.action('bindings')
    def validate_target_template(self, baseline): self.action('template')
    def hold_assignment(self, baseline): self.action('hold-assignment')
    def drain(self, baseline): self.action('drain')
    def cleanup_old_machine(self, baseline): self.action('cleanup'); self.old_remote = False
    def stop_writers(self, baseline): self.action('stop-writers')
    def detach_data(self, baseline): self.action('detach')
    def source_is_running(self, iid):
        assert iid == 'i-original'
        return self.source_running
    def terminate_source(self, iid):
        assert iid == 'i-original'
        assert not self.old_remote
        self.source_running = False; self.source_terminated = True
        self.action('terminate:' + iid)
        # Simulate a lost AWS response after the termination actually happened.
        raise Hold('Lost response')
    def replacement(self, baseline):
        self.action('observe-replacement'); return 'i-replacement'
    def verify_host(self, target, baseline):
        assert target == 'i-replacement'; assert not self.source_running
        self.action('verify-host')
    def enroll(self, target, baseline):
        assert not self.old_remote
        self.action('switch-login'); self.user = 'admin'
    def verify_node(self, target, baseline): self.action('verify-node')


class TestReplacement(unittest.TestCase):
    def setUp(self):
        self.journal, self.cloud = Journal(), Cloud()
        self.request = {'generation': 'one', 'targetAmi': 'ami-qualified'}
        self.runner = Replacement(self.request, self.journal, self.cloud)
    def until(self, phase):
        for _ in range(12):
            self.runner.step()
            if self.journal.read().get('phase') == phase: return
        self.fail('Phase not reached: ' + phase)
    def test_restart_after_every_checkpoint_and_lost_terminate_response(self):
        self.until('Replacing')
        self.assertFalse(self.cloud.source_terminated)
        self.runner.step()
        self.assertTrue(self.cloud.source_terminated)
        self.runner = Replacement(self.request, self.journal, self.cloud)
        self.until('Verified')
        self.runner.step()
        self.assertEqual(self.cloud.calls.count('terminate:i-original'), 1)
        self.assertLess(self.cloud.calls.index('cleanup'), self.cloud.calls.index('terminate:i-original'))
        self.assertLess(self.cloud.calls.index('detach'), self.cloud.calls.index('terminate:i-original'))
        self.assertLess(self.cloud.calls.index('verify-host'), self.cloud.calls.index('switch-login'))
        self.assertEqual(self.cloud.user, 'admin')
        self.assertIsNone(self.cloud.owner)
        self.assertEqual([x['phase'] for x in self.journal.history], ['Prepared', 'Quiescing', 'Replacing', 'Enrolling', 'Verified'])
        self.assertEqual(self.journal.value['baseline']['data'], 'same-volume')
    def test_failed_drains_cleanup_and_detach_never_terminate(self):
        for operation in ('drain', 'cleanup', 'stop-writers', 'detach'):
            with self.subTest(operation=operation):
                self.setUp(); self.cloud.block = operation
                self.until('Quiescing')
                for _ in range(3): self.runner.step()
                self.assertFalse(self.cloud.source_terminated)
                self.assertNotIn('switch-login', self.cloud.calls)
    def test_binding_template_kernel_and_node_failures_hold_journal(self):
        for operation in ('bindings', 'template', 'verify-host', 'verify-node'):
            with self.subTest(operation=operation):
                self.setUp(); self.until('Replacing'); self.cloud.fail = operation
                with self.assertRaises(Unsafe):
                    for _ in range(8): self.runner.step()
                count = self.cloud.calls.count('terminate:i-original')
                self.assertEqual(self.runner.step(), 'Failed')
                self.assertEqual(self.cloud.calls.count('terminate:i-original'), count)
                self.assertIsNotNone(self.cloud.owner)
    def test_stale_generation_cannot_reuse_a_journal(self):
        self.until('Prepared')
        with self.assertRaises(Unsafe): Replacement({**self.request, 'generation': 'two'}, self.journal, self.cloud).step()
        self.assertFalse(self.cloud.source_terminated)
    def test_concurrent_attempt_cannot_take_worker_lock(self):
        self.until('Prepared')
        with self.assertRaises(Unsafe): Replacement({**self.request, 'generation': 'two'}, Journal(), self.cloud).step()
        self.assertFalse(self.cloud.source_terminated)
    def test_deadline_failure_retains_state(self):
        self.until('Prepared'); self.cloud.fail = 'deadline'
        with self.assertRaises(Unsafe): self.runner.step()
        self.assertEqual(self.journal.value['phase'], 'Failed')
        self.assertFalse(self.cloud.source_terminated)
    def test_current_provider_generation_is_required(self):
        obj = {'metadata': {'uid': 'owned', 'generation': 4}, 'status': {'conditions': [
            {'type': 'Ready', 'status': 'True'}, {'type': 'Synced', 'status': 'True', 'observedGeneration': 4}]}}
        self.assertTrue(acknowledged(obj))
        for generation in (None, 0, 3):
            obj['status']['conditions'][1]['observedGeneration'] = generation
            self.assertFalse(acknowledged(obj))
    def test_no_activation_has_no_operations(self):
        # Construction is inert; the caller must explicitly start the Job.
        self.assertEqual(self.journal.read(), {})
        self.assertEqual(self.cloud.calls, [])

    def test_foreign_inventory_address_login_key_and_pool_cannot_reach_cleanup(self):
        worker = {'spec': {'sshSecretName': 'worker-key', 'pool': 'node', 'namespace': 'default'}}
        machine = {'address': '192.0.2.1', 'user': 'ubuntu', 'sshKeyRef': {'name': 'worker-key'}}
        pool = {'spec': {'pool': 'node', 'machine': machine}}
        remote = {'spec': {**copy.deepcopy(machine), 'pool': 'node'}}
        validate_inventory(worker, pool, remote, 'node', 'default', '192.0.2.1', 'ubuntu')
        for change in ({'address': '192.0.2.2'}, {'user': 'admin'}, {'pool': 'foreign'}, {'sshKeyRef': {'name': 'other-key'}}, {'port': 23}, {'useSudo': False}):
            with self.subTest(change=change):
                altered = {'spec': {**remote['spec'], **change}}
                with self.assertRaises(Unsafe): validate_inventory(worker, pool, altered, 'node', 'default', '192.0.2.1', 'ubuntu')


# API transition tests use SDK-free transports; no cloud or credential access.
sys.modules.setdefault('boto3', types.ModuleType('boto3'))
sys.modules.setdefault('yaml', types.ModuleType('yaml'))
sys.modules.setdefault('botocore', types.ModuleType('botocore'))
exceptions = types.ModuleType('botocore.exceptions')
exceptions.ClientError = type('ClientError', (Exception,), {})
sys.modules.setdefault('botocore.exceptions', exceptions)
import runtime


class Kube:
    def __init__(self, resources): self.resources = resources; self.patches = []
    def call(self, method, path, body=None):
        assert method == 'GET'
        return copy.deepcopy(self.resources.get(path))
    def patch(self, path, observed, change):
        current = self.resources[path]
        if current['metadata']['resourceVersion'] != observed['metadata']['resourceVersion']: raise Hold('CAS conflict')
        self.patches.append((path, copy.deepcopy(change)))
        def merge(target, values):
            for key, value in values.items():
                if value is None: target.pop(key, None)
                elif isinstance(value, dict): merge(target.setdefault(key, {}), value)
                else: target[key] = value
        merge(current, change)
        current['metadata']['resourceVersion'] = str(int(current['metadata']['resourceVersion']) + 1)


class TestRuntimeBoundaries(unittest.TestCase):
    def setup_enrollment(self, source_user='ubuntu', target_user='admin'):
        request = {'region': 'eu-central-1', 'namespace': 'default', 'nodeName': 'worker', 'hostProfile': {'sshUser': target_user}}
        prefix = '/apis/infrastructure.cluster.x-k8s.io/v1beta2/namespaces/default/pooledremotemachines/worker'
        capi = '/apis/cluster.x-k8s.io/v1beta2/namespaces/default/'
        resources = {
            prefix: {'metadata': {'uid': 'pool', 'resourceVersion': '1'}, 'spec': {'machine': {'user': source_user}}, 'status': {'reserved': False}},
            capi+'machinesets/set': {'metadata': {'uid': 'set', 'resourceVersion': '1', 'annotations': {runtime.PAUSE: 'true'}}},
            capi+'machinedeployments/worker': {'metadata': {'uid': 'deployment', 'resourceVersion': '1', 'annotations': {runtime.PAUSE: 'true'}}},
        }
        kube = Kube(resources)
        ops = runtime.Operations(request, kube, None, aws={})
        baseline = {'poolUid': 'pool', 'machineSet': {'uid': 'set', 'name': 'set', 'pause': None}, 'deployment': {'uid': 'deployment', 'pause': None}}
        return ops, kube, prefix, baseline
    def test_login_changes_before_assignment_resumes_in_both_directions(self):
        for source, target in [('ubuntu', 'admin'), ('admin', 'ubuntu')]:
            with self.subTest(target=target):
                ops, kube, pool, baseline = self.setup_enrollment(source, target)
                ops.enroll('i-target', baseline)
                self.assertEqual(kube.patches[0][0], pool)
                self.assertEqual(kube.resources[pool]['spec']['machine']['user'], target)
                self.assertEqual(len(kube.patches), 3)
                for path in list(kube.resources)[1:]: self.assertNotIn(runtime.PAUSE, kube.resources[path]['metadata']['annotations'])
    def test_reserved_or_rebound_pool_cannot_switch_login(self):
        for field, value in [('reserved', True), ('uid', 'other')]:
            ops, kube, pool, baseline = self.setup_enrollment()
            if field == 'reserved': kube.resources[pool]['status'][field] = value
            else: kube.resources[pool]['metadata'][field] = value
            with self.assertRaises(Unsafe): ops.enroll('i-target', baseline)
            self.assertEqual(kube.patches, [])
    def test_journal_rejects_a_concurrent_checkpoint(self):
        kube = Kube({'state': {'metadata': {'resourceVersion': '1'}, 'data': {}}})
        journal = runtime.Journal(kube, 'state')
        journal.read()
        kube.resources['state']['metadata']['resourceVersion'] = '2'
        with self.assertRaises(Hold): journal.save({'phase': 'Replacing'})
    def test_terminating_source_is_never_terminated_again(self):
        class Asg:
            def describe_auto_scaling_groups(self, **kwargs):
                return {'AutoScalingGroups': [{'MinSize': 1, 'MaxSize': 1, 'DesiredCapacity': 1,
                    'Instances': [{'InstanceId': 'i-source', 'LifecycleState': 'Terminating:Wait'}]}]}
        ops = runtime.Operations({'region': 'eu-central-1', 'namespace': 'default', 'nodeName': 'worker'}, None, None, aws={'autoscaling': Asg()})
        self.assertFalse(ops.source_is_running('i-source'))


if __name__ == '__main__': unittest.main()
