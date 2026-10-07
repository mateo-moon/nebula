"""Build the public installation probe and its measured, deny-by-default policy.

Uses upstream ocicrypt via skopeo and coco_keyprovider. The well-known test key
is intentionally public. No customer input or credentials enter the image.
"""
import argparse
import base64
import gzip
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import tarfile
import threading
import time

from build import run, require, json_file

PAUSE = "registry.k8s.io/pause@sha256:278fb9dbcca9518083ad1e11276933a2e96f23de604a3a08cc3c80002767d24c"
RESOURCE = "nebula-canary/image_key/v1"
PUBLIC_KEY = hashlib.sha256(b"nebula-coco-public-canary-v1").digest()


def blob(layout, data, media):
    digest = hashlib.sha256(data).hexdigest()
    path = layout / "blobs/sha256" / digest
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return {"mediaType": media, "digest": "sha256:" + digest, "size": len(data)}


def encoded(value):
    return json.dumps(value, separators=(",", ":")).encode()


def manifest(layout, name="canary"):
    index = json.loads((layout / "index.json").read_text())
    selected = [item for item in index["manifests"] if item.get("annotations", {}).get("org.opencontainers.image.ref.name") == name]
    require(len(selected) == 1, "one named OCI platform required")
    descriptor = selected[0]
    raw = (layout / "blobs/sha256" / descriptor["digest"].split(":")[1]).read_bytes()
    require("sha256:" + hashlib.sha256(raw).hexdigest() == descriptor["digest"], "OCI manifest digest mismatch")
    return descriptor, json.loads(raw)


def sandbox(work):
    layout = work / "pause-oci"
    if not layout.exists():
        run("skopeo", "copy", "--override-arch", "amd64", "docker://" + PAUSE, "oci:" + str(layout) + ":pause")
    _, image = manifest(layout, "pause")
    config = json.loads((layout / "blobs/sha256" / image["config"]["digest"].split(":")[1]).read_text())["config"]
    require(config["Entrypoint"] == ["/pause"] and config["User"] == "65535:65535", "upstream sandbox contract changed")
    bundle = work / "pause_bundle"; (bundle / "rootfs").mkdir(parents=True, exist_ok=True)
    require(len(image["layers"]) == 1, "unexpected sandbox layers")
    layer = image["layers"][0]
    data = (layout / "blobs/sha256" / layer["digest"].split(":")[1]).read_bytes()
    require("sha256:" + hashlib.sha256(data).hexdigest() == layer["digest"], "sandbox layer digest mismatch")
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        item = archive.getmember("pause")
        require(item.isfile() and item.size < 4 * 1024**2, "unexpected sandbox executable")
        (bundle / "rootfs/pause").write_bytes(archive.extractfile(item).read())
        (bundle / "rootfs/pause").chmod(0o755)
    json_file(bundle / "config.json", {"ociVersion": "1.0.2", "root": {"path": "rootfs", "readonly": True},
        "process": {"terminal": False, "user": {"uid": 65535, "gid": 65535}, "args": ["/pause"],
            "env": config.get("Env", []), "cwd": "/", "noNewPrivileges": True}})


def probe(work, repository):
    require(repository.startswith("ghcr.io/") and all(c.isalnum() or c in "/-_." for c in repository), "public canary repository required")
    executable = work / "canary"
    run("go", "build", "-trimpath", "-ldflags=-s -w -buildid=", "-o", executable,
        Path(__file__).with_name("canary.go"), env={"CGO_ENABLED": "0", "GOOS": "linux", "GOARCH": "amd64", "GOTOOLCHAIN": "local"})
    archive = io.BytesIO()
    with tarfile.open(fileobj=archive, mode="w", format=tarfile.USTAR_FORMAT) as output:
        info = tarfile.TarInfo("canary"); info.mode = 0o555; info.size = executable.stat().st_size
        with executable.open("rb") as source: output.addfile(info, source)
    raw = archive.getvalue(); layout = work / "canary-plain"
    layer = blob(layout, gzip.compress(raw, mtime=0), "application/vnd.oci.image.layer.v1.tar+gzip")
    config = blob(layout, encoded({"architecture": "amd64", "os": "linux", "config": {
        "User": "65532:65532", "Entrypoint": ["/canary"], "WorkingDir": "/", "Env": ["PATH=/"]},
        "rootfs": {"type": "layers", "diff_ids": ["sha256:" + hashlib.sha256(raw).hexdigest()]}}), "application/vnd.oci.image.config.v1+json")
    descriptor = blob(layout, encoded({"schemaVersion": 2, "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": config, "layers": [layer]}), "application/vnd.oci.image.manifest.v1+json")
    descriptor["annotations"] = {"org.opencontainers.image.ref.name": "canary"}
    json_file(layout / "index.json", {"schemaVersion": 2, "manifests": [descriptor]})
    json_file(layout / "oci-layout", {"imageLayoutVersion": "1.0.0"})
    key, providers = work / "public-canary.key", work / "ocicrypt.json"
    key.write_bytes(PUBLIC_KEY)
    json_file(providers, {"key-providers": {"attestation-agent": {"grpc": "127.0.0.1:50000"}}})
    encrypted = work / "canary-encrypted"
    with (work / "keyprovider.log").open("wb") as log:
        server = subprocess.Popen([str(work / "binaries/coco_keyprovider"), "--socket", "127.0.0.1:50000"], stdout=log, stderr=log)
        try:
            for _ in range(100):
                require(server.poll() is None, "canary key provider failed")
                try:
                    with socket.create_connection(("127.0.0.1", 50000), timeout=0.1): break
                except OSError: time.sleep(0.1)
            else: raise ValueError("canary key provider unavailable")
            run("skopeo", "copy", "--encryption-key", f"provider:attestation-agent:keyid=kbs:///{RESOURCE}::keypath={key}",
                "oci:" + str(layout) + ":canary", "oci:" + str(encrypted) + ":canary",
                env={"OCICRYPT_KEYPROVIDER_CONFIG": str(providers)})
        finally:
            server.terminate()
            try: server.wait(timeout=10)
            except subprocess.TimeoutExpired: server.kill(); server.wait()
    descriptor, image = manifest(encrypted)
    require(len(image["layers"]) == 1 and image["layers"][0]["mediaType"].endswith("+encrypted"), "canary layer was not encrypted")
    annotation = image["layers"][0].get("annotations", {}).get("org.opencontainers.image.enc.keys.provider.attestation-agent")
    require(annotation and json.loads(base64.b64decode(annotation))["kid"] == "kbs:///" + RESOURCE, "canary key scope mismatch")
    # Generate against the exact encrypted manifest through a build-local,
    # read-only registry. Replace only its address with the published reference;
    # the digest, OCI config and encrypted layers are identical.
    digest = descriptor["digest"]
    manifest_bytes = (encrypted / "blobs/sha256" / digest.split(":")[1]).read_bytes()
    class Registry(BaseHTTPRequestHandler):
        def log_message(self, *_): pass
        def do_HEAD(self): self.respond(False)
        def do_GET(self): self.respond(True)
        def respond(self, body):
            if self.path.rstrip("/") == "/v2": data, media = b"{}", "application/json"
            elif self.path == "/v2/canary/manifests/" + digest: data, media = manifest_bytes, descriptor["mediaType"]
            elif self.path.startswith("/v2/canary/blobs/sha256:"):
                value = self.path.removeprefix("/v2/canary/blobs/sha256:")
                if len(value) != 64 or any(c not in "0123456789abcdef" for c in value): self.send_error(404); return
                path = encrypted / "blobs/sha256" / value
                if not path.is_file(): self.send_error(404); return
                data, media = path.read_bytes(), "application/octet-stream"
            else: self.send_error(404); return
            self.send_response(200); self.send_header("Content-Type", media); self.send_header("Content-Length", str(len(data)))
            self.send_header("Docker-Distribution-Api-Version", "registry/2.0"); self.end_headers()
            if body: self.wfile.write(data)
    registry = ThreadingHTTPServer(("127.0.0.1", 0), Registry)
    threading.Thread(target=registry.serve_forever, daemon=True).start()
    local = f"127.0.0.1:{registry.server_port}"
    published = repository + "@" + digest
    pod = {"apiVersion": "v1", "kind": "Pod", "metadata": {"name": "nebula-runtime-canary"}, "spec": {
        "runtimeClassName": "kata-remote-aws-nitrotpm", "restartPolicy": "Never",
        "containers": [{"name": "canary", "image": local + "/canary@" + digest,
            "securityContext": {"runAsUser": 65532, "allowPrivilegeEscalation": False,
                "readOnlyRootFilesystem": True, "capabilities": {"drop": ["ALL"]}},
            "resources": {"requests": {"cpu": "10m", "memory": "16Mi"}, "limits": {"cpu": "100m", "memory": "64Mi"}}}]}}
    settings = json.loads((work / "kata/src/tools/genpolicy/genpolicy-settings.json").read_text())
    settings["cluster_config"]["pause_container_image"] = PAUSE
    # Kubernetes-only automountServiceAccountToken/runAsNonRoot controls are set
    # by the controller. This genpolicy version accepts the guest-visible UID,
    # but does not parse those two admission/kubelet fields.
    json_file(work / "canary-pod.json", pod); json_file(work / "canary-settings.json", settings)
    try:
        result = subprocess.run([str(work / "binaries/genpolicy"), "--raw-out", "--yaml-file", str(work / "canary-pod.json"),
            "--json-settings-path", str(work / "canary-settings.json"), "--rego-rules-path", str(work / "kata/src/tools/genpolicy/rules.rego"),
            "--insecure-registry", local], stdout=subprocess.PIPE, check=True, cwd=work)
    finally: registry.shutdown(); registry.server_close()
    policy = result.stdout.decode()
    require(local + "/canary@" + digest in policy and "package agent_policy" in policy, "generated canary policy missing image commitment")
    policy = policy.replace(local + "/canary@" + digest, published)
    require(local not in policy and len(policy.encode()) < 240 * 1024, "unexpected generated canary policy")
    json_file(work / "canary.json", {"image": published, "policy": policy})
    sandbox(work)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--work", type=Path, required=True)
    parser.add_argument("--repository", required=True)
    args = parser.parse_args()
    probe(args.work.resolve(), args.repository)
