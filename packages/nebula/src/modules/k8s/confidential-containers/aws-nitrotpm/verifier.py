"""AWS NitroTPM evidence -> Trustee passport. No sample-evidence runtime mode."""
import argparse
import base64
import hashlib
import hmac
import io
import json
import re
import secrets
import sqlite3
import ssl
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import cbor2
import jwt
from OpenSSL import crypto
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from pycose.headers import Algorithm
from pycose.algorithms import Es384
from pycose.keys import EC2Key
from pycose.keys.curves import P384
from pycose.messages import Sign1Message

AWS_ROOT_SHA256 = "641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b"
MAX_DOCUMENT = 32768
TTL = 60


class Rejected(ValueError):
    """Safe diagnostic; never include caller evidence, tokens or key material."""


def require(condition, reason):
    if not condition:
        raise Rejected(reason)


def b64(data):
    return base64.b64encode(data).decode("ascii")


def unb64(text, limit=MAX_DOCUMENT):
    require(isinstance(text, str) and len(text) <= (limit + 2) // 3 * 4, "invalid base64 size")
    try:
        result = base64.b64decode(text, validate=True)
    except ValueError:
        raise Rejected("invalid base64") from None
    require(len(result) <= limit, "input too large")
    return result


def b64url_int(number):
    return base64.urlsafe_b64encode(number.to_bytes((number.bit_length() + 7) // 8, "big")).rstrip(b"=").decode()


def decode_one(data):
    stream = io.BytesIO(data)
    try:
        result = cbor2.CBORDecoder(stream).decode()
    except Exception:
        raise Rejected("invalid CBOR") from None
    require(stream.read() == b"", "trailing CBOR")
    return result


def rsa_recipient(der):
    require(isinstance(der, bytes) and 1 <= len(der) <= 1024, "invalid recipient")
    try:
        key = serialization.load_der_public_key(der)
    except ValueError:
        raise Rejected("invalid recipient") from None
    require(isinstance(key, rsa.RSAPublicKey) and key.key_size in (2048, 3072, 4096), "RSA recipient required")
    require(key.public_numbers().e == 65537, "unsupported RSA exponent")
    require(key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo) == der,
            "canonical SPKI required")
    return {"kty": "RSA", "alg": "RSA-OAEP-256", "n": b64url_int(key.public_numbers().n),
            "e": b64url_int(key.public_numbers().e)}


def validate_profiles(profiles):
    require(isinstance(profiles, dict) and 1 <= len(profiles) <= 100, "approved profiles required")
    identities = set()
    for workload, profile in profiles.items():
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", workload) is not None, "invalid workload")
        require(set(profile) == {"profile", "policy_sha256", "pcrs", "resources", "reviewed"}, "invalid profile schema")
        require(profile["reviewed"] is True, "image review required")
        require(re.fullmatch(r"[a-z0-9][a-z0-9-]{0,62}", profile["profile"]) is not None, "invalid profile identity")
        require(re.fullmatch(r"[a-f0-9]{64}", profile["policy_sha256"]) is not None, "invalid policy digest")
        pcrs = profile["pcrs"]
        require(isinstance(pcrs, dict) and {"4", "12"} <= set(pcrs), "PCR4 and PCR12 required")
        require(pcrs["4"] != "0" * 96, "unmeasured boot forbidden")
        identity = (pcrs["4"], pcrs["12"])
        require(identity not in identities, "ambiguous workload boot identity")
        identities.add(identity)
        require(all(re.fullmatch(r"(?:[0-9]|[12][0-9]|3[01])", k) and re.fullmatch(r"[a-f0-9]{96}", v)
                    for k, v in pcrs.items()), "SHA384 PCR values required")
        resources = profile["resources"]
        require(isinstance(resources, list) and 1 <= len(resources) <= 20 and len(set(resources)) == len(resources),
                "exact resource list required")
        require(all(re.fullmatch(r"[a-z0-9-]+/image_key/[a-z0-9-]+", r) for r in resources), "invalid image resource")


class EvidenceVerifier:
    # Overridden only by an explicit subclass in tests, never configuration/CLI.
    ROOT_FINGERPRINT = AWS_ROOT_SHA256

    def __init__(self, root_pem):
        self.root = x509.load_pem_x509_certificate(root_pem)
        require(self.root.fingerprint(hashes.SHA256()).hex() == self.ROOT_FINGERPRINT, "untrusted AWS root")

    def verify(self, blob, now):
        require(isinstance(blob, bytes) and 1 <= len(blob) <= MAX_DOCUMENT, "invalid document size")
        envelope = decode_one(blob)
        if isinstance(envelope, cbor2.CBORTag):
            require(envelope.tag == 18, "COSE Sign1 required")
            envelope = envelope.value
        require(isinstance(envelope, (list, tuple)) and len(envelope) == 4, "COSE Sign1 required")
        protected, unprotected, payload, signature = envelope
        require(isinstance(protected, bytes) and decode_one(protected) == {1: -35} and unprotected == {}, "ES384 required")
        require(isinstance(payload, bytes) and isinstance(signature, bytes) and len(signature) == 96, "invalid COSE fields")
        doc = decode_one(payload)
        required = {"module_id", "timestamp", "digest", "nitrotpm_pcrs", "certificate", "cabundle", "nonce", "public_key"}
        require(isinstance(doc, dict) and required <= set(doc) and set(doc) <= required | {"user_data"}, "AWS NitroTPM schema required")
        require(isinstance(doc["module_id"], str) and 1 <= len(doc["module_id"]) <= 256, "invalid module ID")
        require(type(doc["timestamp"]) is int and (now - TTL) * 1000 <= doc["timestamp"] <= (now + 5) * 1000,
                "stale or future document")
        require(doc["digest"] == "SHA384", "SHA384 required")
        pcrs = doc["nitrotpm_pcrs"]
        require(isinstance(pcrs, dict) and 1 <= len(pcrs) <= 32 and
                all(type(k) is int and 0 <= k <= 31 and isinstance(v, bytes) and len(v) == 48 for k, v in pcrs.items()),
                "invalid PCR map")
        require(isinstance(doc["nonce"], bytes) and len(doc["nonce"]) == 32, "nonce required")
        rsa_recipient(doc["public_key"])
        if "user_data" in doc:
            require(isinstance(doc["user_data"], bytes) and len(doc["user_data"]) <= 1024, "invalid user data")
        bundle = doc["cabundle"]
        require(isinstance(bundle, (list, tuple)) and 1 <= len(bundle) <= 8 and
                all(isinstance(v, bytes) and 1 <= len(v) <= 1024 for v in [doc["certificate"], *bundle]), "invalid certificate bundle")
        try:
            leaf = x509.load_der_x509_certificate(doc["certificate"])
            chain = [crypto.load_certificate(crypto.FILETYPE_ASN1, cert) for cert in bundle]
            store = crypto.X509Store()
            store.add_cert(crypto.X509.from_cryptography(self.root))
            store.set_time(datetime.fromtimestamp(now, timezone.utc))
            crypto.X509StoreContext(store, crypto.X509.from_cryptography(leaf), chain).verify_certificate()
            key = leaf.public_key()
            require(isinstance(key, ec.EllipticCurvePublicKey) and isinstance(key.curve, ec.SECP384R1), "P384 signing key required")
            numbers = key.public_numbers()
            message = Sign1Message.decode(cbor2.dumps(cbor2.CBORTag(18, envelope)))
            require(message.phdr.get(Algorithm) == Es384, "ES384 required")
            message.key = EC2Key(crv=P384, x=numbers.x.to_bytes(48, "big"), y=numbers.y.to_bytes(48, "big"))
            require(message.verify_signature(), "invalid signature")
        except Rejected:
            raise
        except Exception:
            raise Rejected("invalid certificate or signature") from None
        return doc


class PassportIssuer:
    def __init__(self, evidence, profiles, db_path, signing_key_pem, signing_chain_pem, issuer, audience):
        validate_profiles(profiles)
        require(issuer.startswith("https://") and audience.startswith("https://"), "HTTPS issuer/audience required")
        self.evidence, self.profiles = evidence, profiles
        self.db_path, self.issuer, self.audience = db_path, issuer, audience
        self.key = serialization.load_pem_private_key(signing_key_pem, password=None)
        require(isinstance(self.key, ec.EllipticCurvePrivateKey) and isinstance(self.key.curve, ec.SECP256R1), "ES256 issuer key required")
        chain = x509.load_pem_x509_certificates(signing_chain_pem)
        require(len(chain) >= 2 and chain[0].public_key().public_numbers() == self.key.public_key().public_numbers(), "issuer chain mismatch")
        store = crypto.X509Store()
        store.add_cert(crypto.X509.from_cryptography(chain[-1]))
        crypto.X509StoreContext(store, crypto.X509.from_cryptography(chain[0]),
                               [crypto.X509.from_cryptography(v) for v in chain[1:-1]]).verify_certificate()
        jwk = json.loads(jwt.algorithms.ECAlgorithm.to_jwk(self.key.public_key()))
        jwk["alg"] = "ES256"  # stock KBS requires JWK alg and endorses P256 EC keys
        jwk["x5c"] = [b64(cert.public_bytes(serialization.Encoding.DER)) for cert in chain]
        self.header = {"typ": "JWT", "jwk": jwk}
        with self.database() as db:
            db.execute("CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, nonce BLOB, recipient BLOB, workload TEXT, expires INTEGER, consumed INTEGER NOT NULL DEFAULT 0)")

    def database(self):
        return sqlite3.connect(self.db_path, timeout=5)

    def challenge(self, workload, recipient, now=None):
        now = int(time.time()) if now is None else now
        require(workload in self.profiles, "unknown workload")
        rsa_recipient(recipient)
        challenge_id, nonce = secrets.token_urlsafe(32), secrets.token_bytes(32)
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            db.execute("DELETE FROM challenges WHERE expires < ?", (now,))
            require(db.execute("SELECT count(*) FROM challenges").fetchone()[0] < 10000, "challenge capacity exceeded")
            db.execute("INSERT INTO challenges(id,nonce,recipient,workload,expires) VALUES(?,?,?,?,?)",
                       (challenge_id, nonce, hashlib.sha256(recipient).digest(), workload, now + TTL))
        return {"challenge_id": challenge_id, "nonce": b64(nonce), "expires_at": now + TTL}

    def passport(self, challenge_id, document, now=None):
        now = int(time.time()) if now is None else now
        require(isinstance(challenge_id, str) and len(challenge_id) <= 64, "invalid challenge ID")
        doc = self.evidence.verify(document, now)
        with self.database() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT nonce,recipient,workload,expires,consumed FROM challenges WHERE id=?", (challenge_id,)).fetchone()
            require(row is not None and row[3] >= now and row[4] == 0, "expired or consumed challenge")
            require(hmac.compare_digest(doc["nonce"], row[0]) and
                    hmac.compare_digest(hashlib.sha256(doc["public_key"]).digest(), row[1]), "challenge or recipient mismatch")
            profile = self.profiles[row[2]]
            require(all(doc["nitrotpm_pcrs"].get(int(index)) == bytes.fromhex(value)
                        for index, value in profile["pcrs"].items()), "unapproved boot measurements")
            db.execute("UPDATE challenges SET consumed=1 WHERE id=?", (challenge_id,))
        claims = {"iss": self.issuer, "aud": self.audience, "iat": now, "nbf": now, "exp": now + TTL,
                  "jti": secrets.token_urlsafe(32), "tee-pubkey": rsa_recipient(doc["public_key"]),
                  "aws": {"evidence_type": "aws-nitrotpm", "workload": row[2], "profile": profile["profile"],
                          "policy_sha256": profile["policy_sha256"], "resources": profile["resources"],
                          "module_id": doc["module_id"], "pcrs": {str(k): v.hex() for k, v in doc["nitrotpm_pcrs"].items()}}}
        return jwt.encode(claims, self.key, algorithm="ES256", headers=self.header)


def handler_for(issuer):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass  # no HTTP inputs, evidence or bearer tokens in logs

        def do_POST(self):
            self.connection.settimeout(5)
            try:
                require(self.headers.get("Transfer-Encoding") is None, "chunked input forbidden")
                length = int(self.headers.get("Content-Length", "0"))
                require(0 < length <= 48000, "invalid request size")
                request = json.loads(self.rfile.read(length))
                require(isinstance(request, dict), "JSON object required")
                if self.path == "/v1/challenge":
                    require(set(request) == {"workload", "public_key"} and isinstance(request["workload"], str), "invalid challenge schema")
                    response = issuer.challenge(request["workload"], unb64(request["public_key"], 1024))
                elif self.path == "/v1/passport":
                    require(set(request) == {"challenge_id", "document"}, "invalid passport schema")
                    response = {"token": issuer.passport(request["challenge_id"], unb64(request["document"]))}
                else:
                    raise Rejected("unknown endpoint")
                status = 200
            except Exception:
                response, status = {"error": "request rejected"}, 400
            body = json.dumps(response).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    args = parser.parse_args()
    config = json.loads(Path(args.config).read_text())
    # No unsafe root, HTTP, measurement bypass or fixture mode.
    evidence = EvidenceVerifier(Path(config["aws_root"]).read_bytes())
    issuer = PassportIssuer(evidence, config["profiles"], config["database"], Path(config["signing_key"]).read_bytes(),
                            Path(config["signing_chain"]).read_bytes(), config["issuer"], config["audience"])
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    context.load_cert_chain(config["tls_certificate"], config["tls_key"])
    server = HTTPServer(("127.0.0.1", config.get("port", 8443)), handler_for(issuer))
    server.socket = context.wrap_socket(server.socket, server_side=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
