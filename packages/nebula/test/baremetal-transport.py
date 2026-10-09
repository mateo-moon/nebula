"""Exercise the packaged agent and sanitized transport errors without a host."""

import copy
import io
import json
import os
import ssl
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

from baremetal_fixtures import (
    SPEC,
    ProvisioningError,
    RetryableError,
    build_agent,
    host_agent,
    transport,
)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        credentials = self.root / "credentials"
        for name in ("initial", "worker"):
            (credentials / name).mkdir(parents=True)
            (credentials / name / "value").write_text("private-fixture-key")
        scratch = self.root / "scratch"
        scratch.mkdir()
        self.ssh = transport.SSH(
            {"spec": copy.deepcopy(SPEC), "metadata": {"uid": "transport-test"}},
            scratch,
            credentials,
        )

    def test_zipapp_imports_in_isolation_and_cleans_up_after_failure(self):
        # Invalid UID or lack of root stops dispatch before host discovery. All
        # production imports still run, with no access to the checkout's modules.
        temporary = self.root / "agent-tmp"
        temporary.mkdir()
        result = subprocess.run(
            [sys.executable, "-I", "-B", "-c", build_agent(), "probe"],
            input=json.dumps({"uid": "invalid/uid", "spec": SPEC}),
            text=True,
            capture_output=True,
            cwd=self.root,
            env={**os.environ, "TMPDIR": str(temporary)},
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr, "")
        response = json.loads(result.stdout)
        self.assertTrue(response["terminal"])
        self.assertIn(
            response["error"], ("invalid request UID", "root or passwordless sudo is required")
        )
        self.assertEqual(list(temporary.iterdir()), [])

    def test_successful_responses_require_a_json_object(self):
        for output in ("not-json", "[]", '"private-fixture-key"'):
            result = subprocess.CompletedProcess([], 0, stdout=output, stderr="")
            with patch.object(transport.subprocess, "run", return_value=result):
                with self.assertRaises(ProvisioningError) as error:
                    self.ssh.call("verify", installed=True)
            self.assertNotIn(output, str(error.exception))

    def test_connection_failures_never_publish_ssh_output(self):
        result = subprocess.CompletedProcess(
            [], 255, stdout="private-fixture-key", stderr="private stderr"
        )
        with patch.object(transport.subprocess, "run", return_value=result):
            with self.assertRaises(RetryableError) as error:
                self.ssh.call("verify", installed=True)
        self.assertNotIn("private", str(error.exception))

    def test_timeout_and_os_errors_are_retryable_without_exception_payloads(self):
        for failure in (
            subprocess.TimeoutExpired(["private-fixture-key"], 45),
            OSError("private-fixture-key"),
        ):
            with patch.object(transport.subprocess, "run", side_effect=failure):
                with self.assertRaises(RetryableError) as error:
                    self.ssh.call("uefi-verify", installed=True)
            self.assertNotIn("private", str(error.exception))

    def test_host_rejection_is_terminal_but_os_boot_wait_remains_retryable(self):
        result = subprocess.CompletedProcess(
            [], 1, stdout=json.dumps({"error": "not ready", "terminal": True}), stderr=""
        )
        with patch.object(transport.subprocess, "run", return_value=result):
            with self.assertRaises(ProvisioningError):
                self.ssh.call("uefi-verify", installed=True)
            with self.assertRaises(ProvisioningError):
                self.ssh.call("probe")
            result.stdout = json.dumps({"error": "not ready", "terminal": False})
            with self.assertRaises(RetryableError):
                self.ssh.call("verify", installed=True)

    def test_request_data_stays_on_stdin_and_agent_uses_isolated_python(self):
        result = subprocess.CompletedProcess([], 0, stdout='{"verified":true}', stderr="")
        with patch.object(transport.subprocess, "run", return_value=result) as command:
            self.assertTrue(
                self.ssh.call("verify", installed=True, marker="private-fixture-payload")[
                    "verified"
                ]
            )
        args = command.call_args.args[0]
        self.assertIn("python3 -I -B", args[-1])
        self.assertNotIn("private-fixture-payload", " ".join(args))
        self.assertIn("private-fixture-payload", command.call_args.kwargs["input"])

    def test_unknown_actions_fail_before_host_operations(self):
        with patch.object(host_agent, "probe") as probe:
            with self.assertRaisesRegex(ProvisioningError, "unknown host action"):
                host_agent.dispatch("unknown", {"uid": "request", "spec": SPEC})
        probe.assert_not_called()

    def test_host_protocol_classifies_failures_without_leaking_details(self):
        for action, failure, terminal in (
            ("verify", FileNotFoundError("private path"), False),
            ("uefi-verify", FileNotFoundError("private path"), True),
            ("stage", ProvisioningError("disk changed"), True),
        ):
            output = io.StringIO()
            with (
                patch.object(host_agent.os, "geteuid", return_value=0),
                patch.object(host_agent.sys, "argv", ["agent.pyz", action]),
                patch.object(host_agent.sys, "stdin", io.StringIO("{}")),
                patch.object(host_agent.sys, "stdout", output),
                patch.object(host_agent, "dispatch", side_effect=failure),
                self.assertRaises(SystemExit),
            ):
                host_agent.main()
            response = json.loads(output.getvalue())
            self.assertEqual(response["terminal"], terminal)
            self.assertNotIn("private", response["error"])

    def test_api_token_rotates_and_http_errors_do_not_expose_body(self):
        tokens = iter(("first-token", "second-token"))
        api = transport.Kubernetes(
            "https://kubernetes.example.test", ssl.create_default_context(), lambda: next(tokens)
        )
        responses = [io.BytesIO(b'{"metadata":{}}'), io.BytesIO(b'{"metadata":{}}')]
        with patch.object(transport.urllib.request, "urlopen", side_effect=responses) as request:
            api.request("GET", "/fixture")
            api.request("GET", "/fixture")
        self.assertEqual(
            [call.args[0].get_header("Authorization") for call in request.call_args_list],
            ["Bearer first-token", "Bearer second-token"],
        )
        api.token = None
        failure = urllib.error.HTTPError(
            "https://kubernetes.example.test", 409, "private body", {}, None
        )
        with patch.object(transport.urllib.request, "urlopen", side_effect=failure):
            with self.assertRaisesRegex(RetryableError, "HTTP 409") as error:
                api.request("PATCH", "/fixture", {})
        self.assertNotIn("private", str(error.exception))


if __name__ == "__main__":
    unittest.main()
