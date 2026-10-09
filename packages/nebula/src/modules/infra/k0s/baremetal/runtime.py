"""Small shared primitives with explicit failure semantics and safe diagnostics."""

import hashlib
import json
import subprocess
from typing import Any

from models import JsonObject, WorkerSpec


class ProvisioningError(ValueError):
    """The operation needs inspection; retries cannot authorize destructive work."""


class RetryableError(RuntimeError):
    """Communication failed; the recorded operation may be resumed."""


def canonical(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def fingerprint(spec: WorkerSpec) -> str:
    fields = ("address", "hostname", "ssh", "installation")
    return hashlib.sha256(canonical({key: spec.get(key) for key in fields}).encode()).hexdigest()


def json_object(value: Any, description: str) -> JsonObject:
    """Validate an envelope without including its potentially private contents."""
    if not isinstance(value, dict) or not all(isinstance(key, str) for key in value):
        raise ProvisioningError(description + " must be a JSON object")
    return value


def command(args: list[str]) -> str:
    """Capture stderr so command failures never echo private host data."""
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE).strip()


def json_command(args: list[str]) -> Any:
    return json.loads(command(args))
