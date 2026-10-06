"""Explicit local interoperability proof; no real AWS or image secrets are used."""
import base64
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path
from http.server import HTTPServer

import jwt
import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

from conftest import certificate, pem, private_pem
from deployment import kbs_config, resource_policy
from verifier import handler_for
from kbs_launcher import check_policy_seed


def test_stock_kbs_passport_and_guest_consumption(flow, tmp_path):
    binary = os.environ.get("NEBULA_KBS_BINARY")
    if not binary:
        pytest.skip("set NEBULA_KBS_BINARY to the built pinned stock KBS executable")
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    tls_root_key, tls_key = [ec.generate_private_key(ec.SECP384R1()) for _ in range(2)]
    tls_root = certificate(tls_root_key, "TEST ONLY TLS root")
    now = datetime.now(timezone.utc)
    tls_leaf = (x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
                .issuer_name(tls_root.subject).public_key(tls_key.public_key()).serial_number(x509.random_serial_number())
                .not_valid_before(now - timedelta(hours=1)).not_valid_after(now + timedelta(hours=1))
                .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
                .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
                .add_extension(x509.KeyUsage(digital_signature=True, content_commitment=False, key_encipherment=False,
                                            data_encipherment=False, key_agreement=False, key_cert_sign=False, crl_sign=False,
                                            encipher_only=None, decipher_only=None), critical=True)
                .add_extension(x509.SubjectAlternativeName([x509.IPAddress(ipaddress.ip_address("127.0.0.1")), x509.DNSName("localhost")]), critical=False)
                .sign(tls_root_key, hashes.SHA384()))
    for filename, content in {"issuer-root.crt": pem(flow.issuer_root), "tls-root.crt": pem(tls_root),
                              "tls.crt": pem(tls_leaf) + pem(tls_root), "tls.key": private_pem(tls_key)}.items():
        (tmp_path / filename).write_bytes(content)
    storage = tmp_path / "storage"
    (storage / "kbs").mkdir(parents=True)
    (storage / "repository").mkdir()
    (storage / "kbs/resource-policy.rego").write_text(resource_policy(flow.profiles, "https://verifier.example", "https://kbs.example"))
    for path in ["default/image_key/workload-0", "default/image_key/other"]:
        (storage / "repository" / path.replace("/", "\\x2F")).write_bytes(b"TEST ONLY fixture image key")
    config_path = tmp_path / "kbs.toml"
    config_path.write_text(kbs_config(storage, tmp_path / "issuer-root.crt", tmp_path / "tls.crt", tmp_path / "tls.key", port))
    check_policy_seed(config_path, flow.profiles, "https://verifier.example", "https://kbs.example")
    context = ssl.create_default_context(cafile=str(tmp_path / "tls-root.crt"))
    origin = f"https://127.0.0.1:{port}"
    def get(path, token=None):
        headers = {} if token is None else {"Authorization": "Bearer " + token}
        request = urllib.request.Request(origin + path, headers=headers)
        try:
            with urllib.request.urlopen(request, context=context, timeout=2) as response:
                return response.status, response.read()
        except urllib.error.HTTPError as error:
            return error.code, error.read()
    log = (tmp_path / "kbs-test.log").open("wb")
    process = subprocess.Popen([binary, "--config-file", str(config_path)], stdout=log, stderr=log,
                               env={**os.environ, "RUST_LOG": "error"})
    verifier_server = HTTPServer(("127.0.0.1", 0), handler_for(flow.issuer))
    verifier_tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    verifier_tls.minimum_version = ssl.TLSVersion.TLSv1_3
    verifier_tls.load_cert_chain(tmp_path / "tls.crt", tmp_path / "tls.key")
    verifier_server.socket = verifier_tls.wrap_socket(verifier_server.socket, server_side=True)
    verifier_thread = threading.Thread(target=verifier_server.serve_forever, daemon=True)
    verifier_thread.start()
    verifier_origin = f"https://127.0.0.1:{verifier_server.server_port}"
    def post(path, data):
        request = urllib.request.Request(verifier_origin + path, data=json.dumps(data).encode(),
                                         headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, context=context, timeout=2) as response:
            assert response.headers["Cache-Control"] == "no-store"
            return json.loads(response.read())
    try:
        last_error = "no response"
        for _ in range(100):
            if process.poll() is not None:
                pytest.fail("stock KBS startup failed: " + (tmp_path / "kbs-test.log").read_text()[:1000])
            try:
                get("/kbs/v0/resource/default/image_key/workload-0")
                break
            except (urllib.error.URLError, ConnectionError) as error:
                last_error = str(error)
                time.sleep(0.05)
        else:
            pytest.fail("stock KBS did not become ready: " + last_error)
        challenge = post("/v1/challenge", {"workload": "workload-0", "public_key": base64.b64encode(flow.recipient_der).decode()})
        doc = flow.document(base64.b64decode(challenge["nonce"]))
        passport_request = {"challenge_id": challenge["challenge_id"], "document": base64.b64encode(doc).decode()}
        token = post("/v1/passport", passport_request)["token"]
        with pytest.raises(urllib.error.HTTPError) as replay:
            post("/v1/passport", passport_request)
        assert replay.value.code == 400 and replay.value.read() == b'{"error": "request rejected"}'
        status, body = get("/kbs/v0/resource/default/image_key/workload-0", token)
        assert status == 200, body.decode()[:1200]
        response = json.loads(body)
        assert {"protected", "encrypted_key", "iv", "ciphertext", "tag"} <= set(response)
        assert b"TEST ONLY fixture image key" not in body
        assert get("/kbs/v0/resource/default/image_key/other", token)[0] != 200
        assert get("/kbs/v0/resource/default/image_key/workload-0?override=1", token)[0] != 200
        assert get("/kbs/v0/resource/default/image_key/workload-0")[0] != 200
        claims = jwt.decode(token, options={"verify_signature": False})
        for field, value in [("aud", "https://other-kbs.example"), ("iss", "https://other-verifier.example")]:
            altered = {**claims, field: value}
            signed = jwt.encode(altered, flow.issuer_key, algorithm="ES256", headers=flow.issuer.header)
            assert get("/kbs/v0/resource/default/image_key/workload-0", signed)[0] != 200
        rogue_key = ec.generate_private_key(ec.SECP256R1())
        rogue_header = {"jwk": json.loads(jwt.algorithms.ECAlgorithm.to_jwk(rogue_key.public_key()))}
        rogue = jwt.encode(claims, rogue_key, algorithm="ES256", headers=rogue_header)
        assert get("/kbs/v0/resource/default/image_key/workload-0", rogue)[0] != 200
        (tmp_path / "bootstrap.json").write_text(json.dumps({"workload": "workload-0", "verifier_url": verifier_origin + "/",
                                                            "kbs_url": origin + "/", "resources": ["default/image_key/workload-0"]}))
        (tmp_path / "passport.jwt").write_text(token)
        (tmp_path / "recipient-test.key").write_bytes(flow.recipient.private_bytes(
            serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption()))
        cargo_env = {**os.environ, "NEBULA_INTEROP_FIXTURE": str(tmp_path)}
        result = subprocess.run(["cargo", "test", "--locked", "--offline", "--manifest-path", "guest/Cargo.toml",
                                 "--test", "passport_interop", "--", "--ignored", "--test-threads=1"],
                                cwd=Path(__file__).resolve().parents[1], env=cargo_env, capture_output=True, text=True, timeout=120)
        assert result.returncode == 0, result.stdout[-2000:] + result.stderr[-2000:]
    finally:
        verifier_server.shutdown()
        verifier_server.server_close()
        verifier_thread.join(timeout=2)
        process.terminate()
        try:
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        log.close()
