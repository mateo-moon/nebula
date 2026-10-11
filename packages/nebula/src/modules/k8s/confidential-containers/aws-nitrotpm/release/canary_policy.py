"""Compatibility data for the immutable public installation probe only.

Keep upstream authorization rules byte-for-byte. Each supported OCI version is
an exact alternative with the same commands, images, mounts and process limits.
Owner-signed workload policies never pass through this build-time function.
"""
import copy
import json

from build import require

OCI_VERSIONS = ("1.1.0", "1.2.0", "1.3.0")
RESOURCE_ANNOTATIONS = {
    r"^io\.katacontainers\.config\.hypervisor\.default_memory$": "^64$",
    r"^io\.katacontainers\.config\.hypervisor\.default_vcpus$": "^1$",
}


def compatible_policy(generated):
    marker = "\npolicy_data := "
    require(generated.count(marker) == 1, "one generated policy data document required")
    rules, raw = generated.split(marker)
    data = json.loads(raw)
    containers = data["containers"]
    require(len(containers) == 2 and [c["OCI"]["Process"]["Args"] for c in containers] == [["/pause"], ["/canary"]],
            "fixed installation probe containers required")
    require(all(c["OCI"]["Version"] == OCI_VERSIONS[0] for c in containers), "upstream OCI policy default changed")
    require(all(not set(c["runtime_anno_patterns"]) & set(RESOURCE_ANNOTATIONS) for c in containers),
            "upstream resource annotation policy changed")
    data["containers"] = []
    for version in OCI_VERSIONS:
        for original in containers:
            container = copy.deepcopy(original)
            container["OCI"]["Version"] = version
            # Kata adds these two annotations from the probe's fixed resource
            # limits. Permit their exact values, not arbitrary hypervisor keys.
            container["runtime_anno_patterns"].update(RESOURCE_ANNOTATIONS)
            data["containers"].append(container)
    return rules + marker + json.dumps(data, indent=2) + "\n"
