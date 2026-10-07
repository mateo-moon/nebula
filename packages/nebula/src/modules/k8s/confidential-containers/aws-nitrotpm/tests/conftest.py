import copy
import hashlib
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import cbor2
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import NameOID
from pycose.algorithms import Es384
from pycose.headers import Algorithm
from pycose.keys import EC2Key
from pycose.keys.curves import P384
from pycose.messages import Sign1Message

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verifier import EvidenceVerifier, PassportIssuer


def certificate(key, name, issuer=None, issuer_key=None, expired=False):
    now = datetime.now(timezone.utc)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])
    builder = (x509.CertificateBuilder().subject_name(subject)
               .issuer_name(issuer.subject if issuer else subject).public_key(key.public_key())
               .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=2))
               .not_valid_after(now - timedelta(days=1) if expired else now + timedelta(days=1))
               .add_extension(x509.BasicConstraints(ca=issuer is None, path_length=None), critical=True))
    return builder.sign(issuer_key or key, hashes.SHA384())


def pem(cert):
    return cert.public_bytes(serialization.Encoding.PEM)


def private_pem(key):
    return key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())


@pytest.fixture
def flow(tmp_path):
    root_key, leaf_key, issuer_root_key, issuer_key = [ec.generate_private_key(ec.SECP384R1()) for _ in range(4)]
    issuer_key = ec.generate_private_key(ec.SECP256R1())
    root = certificate(root_key, "TEST ONLY synthetic Nitro root")
    leaf = certificate(leaf_key, "TEST ONLY synthetic Nitro leaf", root, root_key)
    issuer_root = certificate(issuer_root_key, "TEST ONLY passport root")
    issuer_leaf = certificate(issuer_key, "TEST ONLY passport issuer", issuer_root, issuer_root_key)

    class SyntheticEvidenceVerifier(EvidenceVerifier):
        ROOT_FINGERPRINT = root.fingerprint(hashes.SHA256()).hex()

    profiles = {"workload-0": {"profile": "workload-0-image-v1", "policy_sha256": hashlib.sha256(b"fixed-policy").hexdigest(),
                           "pcrs": {"4": "44" * 48, "12": "00" * 48},
                           "resources": ["default/image_key/workload-0"], "reviewed": True}}
    evidence = SyntheticEvidenceVerifier(pem(root))
    db = tmp_path / "challenges.sqlite"
    issuer = PassportIssuer(evidence, profiles, db, private_pem(issuer_key), pem(issuer_leaf) + pem(issuer_root),
                            "https://verifier.example", "https://kbs.example")
    recipient = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    recipient_der = recipient.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)

    def document(nonce, public_key=recipient_der, mutate=None, key=leaf_key, cert=leaf, tagged=True, now=None):
        doc = {"module_id": "test-nitro-module", "timestamp": int(time.time() * 1000) if now is None else now * 1000,
               "digest": "SHA384", "nitrotpm_pcrs": {4: b"\x44" * 48, 12: b"\0" * 48},
               "certificate": cert.public_bytes(serialization.Encoding.DER),
               "cabundle": [root.public_bytes(serialization.Encoding.DER)], "public_key": public_key, "nonce": nonce}
        if mutate:
            mutate(doc)
        numbers = key.private_numbers()
        message = Sign1Message(phdr={Algorithm: Es384}, payload=cbor2.dumps(doc))
        message.key = EC2Key(crv=P384, x=numbers.public_numbers.x.to_bytes(48, "big"),
                             y=numbers.public_numbers.y.to_bytes(48, "big"), d=numbers.private_value.to_bytes(48, "big"))
        encoded = message.encode()
        return encoded if tagged else cbor2.dumps(cbor2.loads(encoded).value)

    return SimpleNamespace(**locals())
