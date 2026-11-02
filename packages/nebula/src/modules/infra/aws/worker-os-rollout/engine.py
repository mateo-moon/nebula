"""Finite replacement of one named ASG member. No fleet-wide refresh API.

The journal is saved before each destructive boundary. An ambiguous terminate
response can only retry the original instance ID, never its replacement.
"""
import hashlib
import json


class Hold(Exception):
    """An observation is not ready; keep the current checkpoint."""


class Unsafe(Exception):
    """The immutable request or a saved binding changed; hold for review."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def acknowledged(resource):
    m = resource['metadata']
    conditions = resource.get('status', {}).get('conditions', [])
    return (not m.get('deletionTimestamp') and
            any(c['type'] == 'Ready' and c['status'] == 'True' for c in conditions) and
            any(c['type'] == 'Synced' and c['status'] == 'True' and
                c.get('observedGeneration') == m['generation'] for c in conditions))


class Replacement:
    def __init__(self, request, journal, operations):
        self.request, self.journal, self.ops = request, journal, operations
        self.request_hash = digest(request)

    def checkpoint(self, state, **changes):
        result = {**state, **changes, 'requestHash': self.request_hash}
        self.journal.save(result)
        return result

    def step(self):
        state = self.journal.read()
        if state and state.get('requestHash') != self.request_hash:
            raise Unsafe('Journal belongs to a different request')
        if state.get('phase') == 'Verified':
            self.ops.release(self.request_hash)
            return 'Verified'
        if state.get('phase') == 'Failed':
            return state['phase']
        try:
            self.ops.check_deadline()
            self.ops.acquire(self.request_hash)
            if not state:
                baseline = self.ops.prepare()
                self.checkpoint(state, phase='Prepared', baseline=baseline)
                return 'Prepared'
            self.ops.validate_bindings(state['baseline'])
            phase = state['phase']
            if phase == 'Prepared':
                self.checkpoint(state, phase='Quiescing')
            elif phase == 'Quiescing':
                # All steps are idempotent. Cleanup uses the source SSH login.
                self.ops.hold_assignment(state['baseline'])
                self.ops.drain(state['baseline'])
                self.ops.cleanup_old_machine(state['baseline'])
                self.ops.stop_writers(state['baseline'])
                self.ops.detach_data(state['baseline'])
                self.checkpoint(state, phase='Replacing')
            elif phase == 'Replacing':
                source = state['baseline']['sourceInstanceId']
                self.ops.validate_target_template(state['baseline'])
                if self.ops.source_is_running(source):
                    # This exact source ID was persisted before the call. A
                    # restart never selects a different ASG member to terminate.
                    self.ops.terminate_source(source)
                    raise Hold('Waiting for source instance termination')
                target = self.ops.replacement(state['baseline'])
                self.ops.verify_host(target, state['baseline'])
                self.checkpoint(state, phase='Enrolling', targetInstanceId=target)
            elif phase == 'Enrolling':
                self.ops.verify_host(state['targetInstanceId'], state['baseline'])
                self.ops.enroll(state['targetInstanceId'], state['baseline'])
                self.ops.verify_node(state['targetInstanceId'], state['baseline'])
                self.checkpoint(state, phase='Verified')
                self.ops.release(self.request_hash)
            else:
                raise Unsafe('Unknown checkpoint phase')
        except Hold:
            return state.get('phase', 'Preparing')
        except Unsafe as error:
            self.checkpoint(state, phase='Failed', reason=str(error))
            raise
        return self.journal.read()['phase']
