"""Evaluate the release's real policy with Kata's pinned Regorus interpreter.

The sandbox fixture uses synthetic identifiers and contains no attestation,
credentials or deployment data. This is a software regression gate, not hardware
qualification or a substitute for the encrypted workload's successful exit.
"""
import copy
import json
from pathlib import Path
import subprocess

from build import require
from canary_policy import OCI_VERSIONS


def policy_cases():
    request = json.loads(Path(__file__).with_name("fixtures").joinpath("sandbox-request.json").read_text())
    cases = []

    def add(name, value, allowed=False, query="CreateContainerRequest", data=None):
        cases.append({"name": name, "input": value, "allowed": allowed,
                      "query": "data.agent_policy." + query, "data": data or {"pstate": {}}})

    for version in OCI_VERSIONS:
        value = copy.deepcopy(request)
        value["OCI"]["Version"] = version
        add("sandbox-oci-" + version, value, True)
        value = copy.deepcopy(value)
        for key in ("default_memory", "default_vcpus"):
            value["OCI"]["Annotations"].pop("io.katacontainers.config.hypervisor." + key)
        add("sandbox-without-resource-annotations-" + version, value, True)

    changes = [
        ("unknown-oci", ("OCI", "Version"), "1.4.0"),
        ("oci-suffix", ("OCI", "Version"), "1.3.0-extra"),
        ("oci-missing", ("OCI", "Version"), ""),
        ("command", ("OCI", "Process", "Args"), ["/bin/sh"]),
        ("uid", ("OCI", "Process", "User", "UID"), 0),
        ("privilege-escalation", ("OCI", "Process", "NoNewPrivileges"), False),
        ("terminal", ("OCI", "Process", "Terminal"), True),
        ("writable-root", ("OCI", "Root", "Readonly"), False),
        ("memory", ("OCI", "Annotations", "io.katacontainers.config.hypervisor.default_memory"), "65"),
        ("vcpus", ("OCI", "Annotations", "io.katacontainers.config.hypervisor.default_vcpus"), "2"),
        ("debug-annotation", ("OCI", "Annotations", "io.katacontainers.config.agent.debug_console"), "true"),
        ("hypervisor-annotation", ("OCI", "Annotations", "io.katacontainers.config.hypervisor.kernel_params"), "init=/bin/sh"),
        ("mount", ("OCI", "Mounts"), request["OCI"]["Mounts"] + [
            {"destination": "/secrets", "source": "/run/nebula/secrets", "type_": "bind", "options": ["rbind"]}]),
        ("extra-env", ("OCI", "Process", "Env"), request["OCI"]["Process"]["Env"] + ["INJECTED=1"]),
    ]
    for name, path, replacement in changes:
        value = copy.deepcopy(request)
        target = value
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = replacement
        add("reject-" + name, value)
    for query in ("SetPolicyRequest", "GetDiagnosticDataRequest", "ReadStreamRequest", "WriteStreamRequest", "AllowRequestsFailingPolicy"):
        add("reject-" + query, {}, query=query)
    for path in ("/run/nebula/workload/policy.rego", "/run/nebula/secrets/key", "/etc/systemd/system/evil.service"):
        add("reject-copy-" + path, {"file_type": "Regular", "path": path}, query="CopyFileRequest")
    add("reject-exec", {"container_id": request["container_id"], "process": {"Args": ["/bin/sh"]}},
        query="ExecProcessRequest", data={"pstate": {request["container_id"]: 4}})
    return cases


def check_policy(policy, engine):
    cases = policy_cases()
    result = subprocess.run([str(engine)], input=json.dumps([{**case, "policy": policy} for case in cases]),
                            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    require(result.returncode == 0, "canary policy interpreter failed")
    values = [json.loads(line) for line in result.stdout.splitlines()]
    require(len(values) == len(cases), "incomplete canary policy evaluation")
    for case, value in zip(cases, values):
        allowed = value is True or isinstance(value, dict) and value.get("allowed") is True
        require(allowed == case["allowed"], "canary policy regression: " + case["name"])
    print(json.dumps({"canaryPolicyCases": len(cases), "passed": True}), flush=True)
