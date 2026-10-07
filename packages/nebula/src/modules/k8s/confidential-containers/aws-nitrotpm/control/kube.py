"""Small in-cluster API client. Reads projected credentials anew on every call."""
import json
import os
import ssl
import urllib.error
import urllib.request
from pathlib import Path


class ApiError(Exception):
    def __init__(self, status):
        self.status = status
        super().__init__(f"Kubernetes API returned {status}")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Kubernetes redirects are not permitted")


class Kube:
    def __init__(self):
        directory = Path("/var/run/secrets/kubernetes.io/serviceaccount")
        self.token = directory / "token"
        self.namespace = (directory / "namespace").read_text().strip()
        self.base = "https://kubernetes.default.svc"
        self.client = urllib.request.build_opener(NoRedirect(), urllib.request.ProxyHandler({}),
            urllib.request.HTTPSHandler(context=ssl.create_default_context(cafile=str(directory / "ca.crt"))))

    def request(self, method, path, value=None, content_type="application/json"):
        if not path.startswith(("/api/", "/apis/")) or ".." in path:
            raise ValueError("invalid Kubernetes path")
        body = None if value is None else json.dumps(value, separators=(",", ":")).encode()
        request = urllib.request.Request(self.base + path, data=body, method=method, headers={
            "Authorization": "Bearer " + self.token.read_text().strip(), "Content-Type": content_type})
        try:
            with self.client.open(request, timeout=20) as response:
                data = response.read(4 * 1024 * 1024 + 1)
                if len(data) > 4 * 1024 * 1024: raise ValueError("Kubernetes response too large")
                return json.loads(data) if data else {}
        except urllib.error.HTTPError as error:
            raise ApiError(error.code) from None

    def get(self, path):
        return self.request("GET", path)

    def patch(self, path, value):
        return self.request("PATCH", path, value, "application/merge-patch+json")

    def items(self, path):
        from urllib.parse import quote
        query = "&" if "?" in path else "?"
        continuation = ""
        while True:
            page = self.get(path + query + "limit=100" + ("&continue=" + quote(continuation, safe="") if continuation else ""))
            yield from page["items"]
            continuation = page.get("metadata", {}).get("continue")
            if not continuation: return


def credential_environment(directory):
    # provider-aws AccessKey connection-details contract. Reading files instead
    # of environment variables also observes provider-driven key rotation.
    root = Path(directory)
    return {"aws_access_key_id": (root / "username").read_text().strip(),
            "aws_secret_access_key": (root / "password").read_text().strip()}
