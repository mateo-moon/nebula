"""Real TLS and interrupted certificate rotation; no AWS access."""
import base64
import copy
import json
import socket
import ssl
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

import admission
from kube import ApiError


RUNTIME = {"apiVersion": "coco.nebula.io/v1alpha1", "kind": "AwsConfidentialRuntime",
           "metadata": {"name": "example", "namespace": "example", "uid": "fixture"}}
SECRET = "/api/v1/namespaces/example/secrets/example-admission"
WEBHOOK = "/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations/example"
DEPLOYMENT = "/apis/apps/v1/namespaces/example/deployments/example"


class Interrupted(Exception):
    pass


class Kube:
    namespace = "example"
    def __init__(self):
        self.objects = {
            WEBHOOK: {"metadata": {"resourceVersion": "1"}, "webhooks": [{"clientConfig": {"service": {"name": "example"}}}]},
            DEPLOYMENT: {"metadata": {"resourceVersion": "1", "generation": 1},
                         "spec": {"replicas": 2, "template": {"metadata": {}}}},
        }
        self.writes = []; self.interrupt_after = None

    def get(self, path):
        if path not in self.objects: raise ApiError(404)
        return copy.deepcopy(self.objects[path])

    def committed(self, path):
        self.writes.append((path, copy.deepcopy(self.objects)))
        if self.interrupt_after == len(self.writes): raise Interrupted()
        return self.get(path)

    def request(self, method, path, value):
        assert method == "POST" and path == "/api/v1/namespaces/example/secrets"
        assert SECRET not in self.objects
        self.objects[SECRET] = copy.deepcopy(value)
        self.objects[SECRET]["metadata"]["resourceVersion"] = "1"
        return self.committed(SECRET)

    def patch(self, path, value):
        old = self.objects[path]
        assert value.get("metadata", {}).get("resourceVersion", old["metadata"]["resourceVersion"]) == old["metadata"]["resourceVersion"]
        def merge(target, patch):
            for key, item in patch.items():
                if item is None: target.pop(key, None)
                elif isinstance(item, dict): merge(target.setdefault(key, {}), item)
                else: target[key] = copy.deepcopy(item)
        merge(old, value)
        old["metadata"]["resourceVersion"] = str(int(old["metadata"]["resourceVersion"]) + 1)
        if path == DEPLOYMENT and "spec" in value: old["metadata"]["generation"] += 1
        return self.committed(path)

    def rollout_ready(self):
        obj = self.objects[DEPLOYMENT]
        obj["status"] = {"observedGeneration": obj["metadata"]["generation"], "updatedReplicas": 2, "availableReplicas": 2, "replicas": 2}


class AdmissionTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime.now(timezone.utc)
        self.kube = Kube()

    def reconcile(self, now=None):
        return admission.reconcile(self.kube, RUNTIME, "example", "example", "example", now or self.now)

    def bootstrap(self):
        self.assertFalse(self.reconcile())
        self.kube.rollout_ready()
        self.assertTrue(self.reconcile())
        return copy.deepcopy(self.kube.objects[SECRET]["data"])

    def test_real_tls_hostname_and_ca_and_idempotent_renewal(self):
        data = self.bootstrap()
        self.assertEqual(self.kube.objects[SECRET]["metadata"]["ownerReferences"][0]["uid"], "fixture")
        self.assertFalse(admission.renew(data, "example", "example", self.now))
        self.assertTrue(admission.renew(data, "different", "example", self.now))
        self.assertTrue(admission.renew(data, "example", "example", self.now + timedelta(days=54)))
        count = len(self.kube.writes)
        self.assertTrue(self.reconcile())
        self.assertEqual(len(self.kube.writes), count)
        with tempfile.TemporaryDirectory() as directory:
            for name in ("tls.crt", "tls.key"):
                Path(directory, name).write_bytes(base64.b64decode(data[name]))
            server = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            server.minimum_version = ssl.TLSVersion.TLSv1_3
            server.load_cert_chain(str(Path(directory, "tls.crt")), str(Path(directory, "tls.key")))
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0)); listener.listen(2); listener.settimeout(5)
                errors = []
                def serve():
                    try:
                        for _ in range(2):
                            connection, _ = listener.accept()
                            with connection:
                                try:
                                    with server.wrap_socket(connection, server_side=True) as channel: channel.sendall(b"ready")
                                except ssl.SSLError: pass
                    except Exception as error: errors.append(error)
                thread = threading.Thread(target=serve); thread.start()
                client = ssl.create_default_context(cadata=base64.b64decode(data["ca.crt"]).decode())
                with socket.create_connection(listener.getsockname(), timeout=5) as connection:
                    with client.wrap_socket(connection, server_hostname="example.example.svc") as channel:
                        self.assertEqual(channel.version(), "TLSv1.3")
                        self.assertEqual(channel.recv(5), b"ready")
                with socket.create_connection(listener.getsockname(), timeout=5) as connection:
                    with self.assertRaises(ssl.SSLCertVerificationError): client.wrap_socket(connection, server_hostname="wrong.example.svc")
                thread.join(5); self.assertFalse(thread.is_alive()); self.assertEqual(errors, [])

    def test_rotation_publishes_overlap_before_key_switch_and_prunes_only_after_rollout(self):
        old = self.bootstrap()
        begin = len(self.kube.writes)
        later = self.now + timedelta(days=54)
        self.assertFalse(self.reconcile(later))
        new = self.kube.objects[SECRET]["data"]
        self.assertNotEqual(new["tls.key"], old["tls.key"])
        self.assertEqual(new["previous.ca.crt"], old["ca.crt"])
        for path, state in self.kube.writes[begin:]:
            secret = state[SECRET]["data"]
            if secret["tls.crt"] != old["tls.crt"]:
                trust = base64.b64decode(state[WEBHOOK]["webhooks"][0]["clientConfig"]["caBundle"])
                self.assertIn(base64.b64decode(old["ca.crt"]), trust)
                self.assertIn(base64.b64decode(secret["ca.crt"]), trust)
        self.assertFalse(self.reconcile(later))
        self.kube.rollout_ready()
        self.assertTrue(self.reconcile(later))
        self.assertEqual(self.kube.objects[WEBHOOK]["webhooks"][0]["clientConfig"]["caBundle"], new["ca.crt"])
        self.assertNotIn("previous.ca.crt", self.kube.objects[SECRET]["data"])

    def test_every_persisted_rotation_step_can_resume_after_a_lost_response(self):
        self.bootstrap()
        initial = copy.deepcopy(self.kube.objects)
        for point in range(1, 7):
            with self.subTest(point=point):
                self.kube = Kube(); self.kube.objects = copy.deepcopy(initial); self.kube.interrupt_after = point
                later = self.now + timedelta(days=54)
                for _ in range(6):
                    try:
                        self.reconcile(later)
                        self.kube.rollout_ready()
                    except Interrupted: self.kube.interrupt_after = None
                self.assertTrue(self.reconcile(later))
                data = self.kube.objects[SECRET]["data"]
                self.assertEqual(set(data), {"ca.crt", "tls.crt", "tls.key"})
                self.assertFalse(admission.renew(data, "example", "example", later))
                self.assertEqual(self.kube.objects[WEBHOOK]["webhooks"][0]["clientConfig"]["caBundle"], data["ca.crt"])

    def test_missing_chart_and_invalid_key_material_are_recoverable(self):
        del self.kube.objects[WEBHOOK]
        self.assertFalse(self.reconcile()); self.assertEqual(self.kube.writes, [])
        self.kube = Kube()
        data = self.bootstrap()
        for value in ("invalid", admission.issue("example", "example", self.now)["tls.key"]):
            self.assertTrue(admission.renew({**data, "tls.key": value}, "example", "example", self.now))


if __name__ == "__main__": unittest.main()
