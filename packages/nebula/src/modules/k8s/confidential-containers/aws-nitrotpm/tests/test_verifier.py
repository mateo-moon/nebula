import base64
import copy
import time
from concurrent.futures import ThreadPoolExecutor

import cbor2
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives import serialization

from conftest import certificate, pem, private_pem
from verifier import EvidenceVerifier, PassportIssuer, Rejected, validate_profiles


def request(flow, **kwargs):
    challenge = flow.issuer.challenge("workload-0", flow.recipient_der)
    document = flow.document(base64.b64decode(challenge["nonce"]), **kwargs)
    return challenge["challenge_id"], document


@pytest.mark.parametrize("tagged", [True, False])
def test_signed_passport_contains_only_verified_authority(flow, tagged):
    challenge_id, document = request(flow, tagged=tagged, mutate=lambda d: d.update(user_data=b'{"resources":["other/key"]}'))
    token = flow.issuer.passport(challenge_id, document)
    claims = jwt.decode(token, flow.issuer_key.public_key(), algorithms=["ES256"], audience="https://kbs.example")
    assert claims["aws"]["resources"] == ["default/image_key/workload-0"]
    assert claims["aws"]["policy_sha256"] == flow.profiles["workload-0"]["policy_sha256"]
    assert claims["tee-pubkey"]["alg"] == "RSA-OAEP-256"
    assert claims["exp"] - claims["iat"] == 60
    assert "snp" not in claims["aws"]
    assert len(jwt.get_unverified_header(token)["jwk"]["x5c"]) == 2


@pytest.mark.parametrize("mutate", [
    lambda d: d["nitrotpm_pcrs"].update({4: b"\x55" * 48}),  # image/policy/rootfs changed
    lambda d: d["nitrotpm_pcrs"].update({12: b"\x55" * 48}),  # kernel args changed
    lambda d: d["nitrotpm_pcrs"].pop(12),
    lambda d: d.update(digest="SHA256"),
    lambda d: d.update(timestamp=int((time.time() - 120) * 1000)),
    lambda d: d.update(timestamp=int((time.time() + 120) * 1000)),
    lambda d: d.update(nonce=b"X" * 32),
    lambda d: d.update(nonce=b""),
    lambda d: d.update(module_id=""),
    lambda d: d.update(pcrs=d.pop("nitrotpm_pcrs")),  # Enclaves/generic evidence schema
    lambda d: d["nitrotpm_pcrs"].update({True: b"X" * 48}),
    lambda d: d["nitrotpm_pcrs"].update({32: b"X" * 48}),
    lambda d: d["nitrotpm_pcrs"].update({4: b"X" * 32}),
    lambda d: d.update(user_data=b"X" * 1025),
])
def test_bad_evidence_never_issues_token(flow, mutate):
    challenge_id, document = request(flow, mutate=mutate)
    with pytest.raises(Rejected):
        flow.issuer.passport(challenge_id, document)


def test_recipient_substitution(flow):
    other = rsa.generate_private_key(public_exponent=65537, key_size=2048).public_key()
    der = other.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    challenge_id, document = request(flow, public_key=der)
    with pytest.raises(Rejected, match="recipient mismatch"):
        flow.issuer.passport(challenge_id, document)


def test_invalid_signature(flow):
    challenge_id, document = request(flow)
    document = document[:-1] + bytes([document[-1] ^ 1])
    with pytest.raises(Rejected):
        flow.issuer.passport(challenge_id, document)


def test_wrong_and_expired_certificates(flow):
    rogue = certificate(flow.leaf_key, "rogue self signed")
    expired = certificate(flow.leaf_key, "expired leaf", flow.root, flow.root_key, expired=True)
    for cert in [rogue, expired]:
        challenge_id, document = request(flow, cert=cert)
        with pytest.raises(Rejected):
            flow.issuer.passport(challenge_id, document)


def test_evidence_root_cannot_enroll_itself(flow):
    with pytest.raises(Rejected, match="AWS root"):
        EvidenceVerifier(pem(flow.root))


def test_replay_survives_issuer_restart(flow):
    challenge_id, document = request(flow)
    flow.issuer.passport(challenge_id, document)
    restarted = PassportIssuer(flow.evidence, flow.profiles, flow.db, private_pem(flow.issuer_key),
                              pem(flow.issuer_leaf) + pem(flow.issuer_root), "https://verifier.example", "https://kbs.example")
    with pytest.raises(Rejected, match="consumed"):
        restarted.passport(challenge_id, document)


def test_atomic_replay_rejection(flow):
    challenge_id, document = request(flow)
    def attempt(_):
        try:
            return flow.issuer.passport(challenge_id, document)
        except Rejected:
            return None
    with ThreadPoolExecutor(max_workers=4) as pool:
        assert len([token for token in pool.map(attempt, range(4)) if token]) == 1


def test_expired_challenge_even_with_fresh_evidence(flow):
    now = int(time.time())
    challenge = flow.issuer.challenge("workload-0", flow.recipient_der, now=now - 61)
    with pytest.raises(Rejected, match="expired"):
        flow.issuer.passport(challenge["challenge_id"], flow.document(base64.b64decode(challenge["nonce"]), now=now), now=now)


def test_multiple_replica_and_reboot_keys_are_independent(flow):
    tokens = []
    for _ in range(3):
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        der = key.public_key().public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
        challenge = flow.issuer.challenge("workload-0", der)
        tokens.append(flow.issuer.passport(challenge["challenge_id"], flow.document(base64.b64decode(challenge["nonce"]), public_key=der)))
    claims = [jwt.decode(t, flow.issuer_key.public_key(), algorithms=["ES256"], audience="https://kbs.example") for t in tokens]
    assert len({c["tee-pubkey"]["n"] for c in claims}) == 3
    assert len({c["jti"] for c in claims}) == 3


@pytest.mark.parametrize("mutate", [
    lambda p: p["workload-0"]["pcrs"].pop("12"),
    lambda p: p["workload-0"]["pcrs"].update({"4": "0" * 96}),
    lambda p: p["workload-0"].update(reviewed=False),
    lambda p: p["workload-0"].update(resources=["default/image_key/../other"]),
    lambda p: p["workload-0"].update(policy_sha256="controller-asserted"),
])
def test_invalid_approvals_rejected(flow, mutate):
    profiles = copy.deepcopy(flow.profiles)
    mutate(profiles)
    with pytest.raises(Rejected):
        validate_profiles(profiles)


def test_unknown_workload_and_non_rsa_recipient(flow):
    with pytest.raises(Rejected):
        flow.issuer.challenge("tool-other", flow.recipient_der)
    key = ec.generate_private_key(ec.SECP384R1()).public_key()
    with pytest.raises(Rejected):
        flow.issuer.challenge("workload-0", key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo))


def test_identical_boot_identity_cannot_authorize_other_workload(flow):
    profiles = copy.deepcopy(flow.profiles)
    profiles["tool-other"] = copy.deepcopy(profiles["workload-0"])
    profiles["tool-other"]["resources"] = ["default/image_key/other"]
    with pytest.raises(Rejected, match="ambiguous"):
        validate_profiles(profiles)


@pytest.mark.parametrize("blob", [b"", b"X" * 32769, b"not cbor", cbor2.dumps([b"", {}, b"", b""]),
                                 cbor2.dumps(cbor2.CBORTag(19, [b"", {}, b"", b""]))])
def test_invalid_envelope(flow, blob):
    with pytest.raises(Rejected):
        flow.evidence.verify(blob, int(time.time()))


def test_trailing_cbor_and_algorithm_confusion(flow):
    challenge_id, document = request(flow)
    with pytest.raises(Rejected):
        flow.issuer.passport(challenge_id, document + b"\0")
    envelope = list(cbor2.loads(document).value)
    envelope[0] = cbor2.dumps({1: -7})
    with pytest.raises(Rejected):
        flow.issuer.passport(challenge_id, cbor2.dumps(cbor2.CBORTag(18, envelope)))
