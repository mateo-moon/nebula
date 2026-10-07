"""Module-owned admission TLS. These are infrastructure keys, not workload keys.

Rotate by publishing overlapping trust before changing the serving Secret, and
retain the previous CA until every webhook replica completes its rollout.
All checkpoints are Kubernetes objects, so controller restarts resume safely.
"""
import base64
import hashlib
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from kube import ApiError

STAMP = "coco.nebula.io/admission-certificate"


def issue(service, namespace, now):
    name = f"{service}.{namespace}.svc"
    ca_key, key = ec.generate_private_key(ec.SECP256R1()), ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    issuer = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name + " admission CA")])
    ca = (x509.CertificateBuilder().subject_name(issuer).issuer_name(issuer).public_key(ca_key.public_key())
          .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
          .not_valid_after(now + timedelta(days=90)).add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
          .sign(ca_key, hashes.SHA256()))
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(issuer).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(minutes=5))
            .not_valid_after(now + timedelta(days=60)).add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.SubjectAlternativeName([x509.DNSName(name), x509.DNSName(name + ".cluster.local")]), critical=False)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
            .sign(ca_key, hashes.SHA256()))
    # No signing key is retained. Each rotation introduces a fresh CA.
    return {"ca.crt": base64.b64encode(ca.public_bytes(serialization.Encoding.PEM)).decode(),
            "tls.crt": base64.b64encode(cert.public_bytes(serialization.Encoding.PEM)).decode(),
            "tls.key": base64.b64encode(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                        serialization.NoEncryption())).decode()}


def renew(data, service, namespace, now):
    try:
        cert = x509.load_pem_x509_certificate(base64.b64decode(data["tls.crt"], validate=True))
        ca = x509.load_pem_x509_certificate(base64.b64decode(data["ca.crt"], validate=True))
        key = serialization.load_pem_private_key(base64.b64decode(data["tls.key"], validate=True), password=None)
        cert.verify_directly_issued_by(ca)
        names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value.get_values_for_type(x509.DNSName)
        public = lambda value: value.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        return (f"{service}.{namespace}.svc" not in names or public(cert.public_key()) != public(key.public_key())
                or cert.not_valid_after_utc < now + timedelta(days=7) or ca.not_valid_after_utc < now + timedelta(days=7)
                or cert.not_valid_before_utc > now)
    except (ValueError, KeyError, TypeError, InvalidSignature, UnsupportedAlgorithm, x509.ExtensionNotFound):
        return True


def reconcile(kube, runtime, service, deployment, configuration, now=None):
    now = now or datetime.now(timezone.utc)
    namespace, name = kube.namespace, runtime["metadata"]["name"] + "-admission"
    secret_path = f"/api/v1/namespaces/{namespace}/secrets/{name}"
    webhook_path = f"/apis/admissionregistration.k8s.io/v1/mutatingwebhookconfigurations/{configuration}"
    deployment_path = f"/apis/apps/v1/namespaces/{namespace}/deployments/{deployment}"
    # Wait for all chart resources. No certificate-manager installation or
    # synthesis-time private key is needed, even on a fresh Kubernetes cluster.
    try:
        webhook, workload = kube.get(webhook_path), kube.get(deployment_path)
    except ApiError as error:
        if error.status == 404: return False
        raise
    if len(webhook["webhooks"]) != 1:
        raise ValueError("admission webhook contract changed")
    def trust(*certificates):
        bundle = base64.b64encode(b"".join(base64.b64decode(value, validate=True) for value in certificates if value)).decode()
        if webhook["webhooks"][0]["clientConfig"].get("caBundle") != bundle:
            hooks = webhook["webhooks"]
            hooks[0]["clientConfig"]["caBundle"] = bundle
            kube.patch(webhook_path, {"metadata": {"resourceVersion": webhook["metadata"]["resourceVersion"]}, "webhooks": hooks})
    try:
        secret = kube.get(secret_path)
    except ApiError as error:
        if error.status != 404: raise
        data = issue(service, namespace, now)
        secret = kube.request("POST", f"/api/v1/namespaces/{namespace}/secrets", {
            "apiVersion": "v1", "kind": "Secret", "type": "kubernetes.io/tls",
            "metadata": {"name": name, "namespace": namespace, "ownerReferences": [{
                "apiVersion": runtime["apiVersion"], "kind": runtime["kind"], "name": runtime["metadata"]["name"],
                "uid": runtime["metadata"]["uid"], "controller": True}]}, "data": data})
    data = secret["data"]
    if not data.get("next.ca.crt") and renew(data, service, namespace, now):
        pending = {"next." + key: value for key, value in issue(service, namespace, now).items()}
        secret = kube.patch(secret_path, {"metadata": {"resourceVersion": secret["metadata"]["resourceVersion"]}, "data": pending})
        data = secret["data"]
    if data.get("next.ca.crt"):
        trust(data.get("ca.crt"), data["next.ca.crt"])
        update = {key: data["next." + key] for key in ("ca.crt", "tls.crt", "tls.key")}
        update.update({"previous.ca.crt": data.get("ca.crt"), **{"next." + key: None for key in ("ca.crt", "tls.crt", "tls.key")}})
        secret = kube.patch(secret_path, {"metadata": {"resourceVersion": secret["metadata"]["resourceVersion"]}, "data": update})
        data = secret["data"]
        # A fresh read avoids reusing the pre-trust resourceVersion below.
        webhook = kube.get(webhook_path)
    trust(data.get("previous.ca.crt"), data["ca.crt"])
    stamp = hashlib.sha256(data["tls.crt"].encode()).hexdigest()
    if workload["spec"]["template"]["metadata"].get("annotations", {}).get(STAMP) != stamp:
        kube.patch(deployment_path, {"spec": {"template": {"metadata": {"annotations": {STAMP: stamp}}}}})
        return False
    status, replicas = workload.get("status", {}), workload["spec"].get("replicas", 1)
    ready = (status.get("observedGeneration", 0) >= workload["metadata"]["generation"]
             and status.get("updatedReplicas", 0) == replicas and status.get("availableReplicas", 0) == replicas
             and status.get("replicas", 0) == replicas)
    if ready and data.get("previous.ca.crt"):
        webhook = kube.get(webhook_path)
        trust(data["ca.crt"])
        kube.patch(secret_path, {"metadata": {"resourceVersion": secret["metadata"]["resourceVersion"]}, "data": {"previous.ca.crt": None}})
    return ready
