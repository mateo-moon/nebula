"""Render isolated review inputs. This module never creates or deploys resources."""
import argparse
import json
from pathlib import Path
from verifier import require, validate_profiles


def resource_policy(profiles, issuer, audience):
    validate_profiles(profiles)
    return '''package policy
import rego.v1

default allow := false

approvals := ''' + json.dumps(profiles, sort_keys=True) + '''

allow if {
    input.iss == ''' + json.dumps(issuer) + '''
    input.aud == ''' + json.dumps(audience) + '''
    input.aws.evidence_type == "aws-nitrotpm"
    approved := approvals[input.aws.workload]
    input.aws.profile == approved.profile
    input.aws.policy_sha256 == approved.policy_sha256
    input.aws.resources == approved.resources
    every index, value in approved.pcrs {
        input.aws.pcrs[index] == value
    }
    input.exp - input.iat <= 60
    now := time.now_ns() / 1000000000
    input.nbf <= now
    now < input.exp
    data.plugin == "resource"
    data.query == {}
    requested := concat("/", data["resource-path"])
    requested in approved.resources
}
'''


def kbs_config(storage, issuer_root, tls_cert, tls_key, port):
    # DenyAll administration is intentional. Seed the exact policy and image keys
    # out of band before startup; never accept the upstream sample policy default.
    return f'''[http_server]
sockets = ["127.0.0.1:{port}"]
insecure_http = false
worker_count = 1
certificate = {json.dumps(str(tls_cert))}
private_key = {json.dumps(str(tls_key))}
tls_min_version = "1.3"

[attestation_token]
trusted_certs_paths = [{json.dumps(str(issuer_root))}]
insecure_header_jwk = false

[admin]
authorization_mode = "DenyAll"

[storage_backend]
storage_type = "LocalFs"

[storage_backend.backends.local_fs]
dir_path = {json.dumps(str(storage))}

[[plugins]]
name = "resource"
storage_backend_type = "kvstorage"
'''


def integration_contract(profiles):
    validate_profiles(profiles)
    return {"status": "blocked-pending-qualification",
            "runtime_class": "kata-remote-aws-nitrotpm", "runtime_handler": "kata-remote",
            "cloud_api_adaptor": "v0.23.0", "nebula_module": "ConfidentialContainers",
            "workloads": [{"kind": "confidential", "workload": name, "profile": p["profile"],
                           "policy_sha256": p["policy_sha256"], "resources": p["resources"]} for name, p in profiles.items()],
            "required_gates": ["same-recipient-fresh-SNP-and-NitroTPM-proof", "immutable-guest-real-evidence",
                               "restricted-CAA-transport-user-data", "measured-workload-network-authorization",
                               "deny-exec-logs-debug-policy-overrides", "guest-memory-only-storage",
                               "real-replicas-reboot-and-snapshot-tests"],
            "deployment_enabled": False}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profiles", required=True)
    parser.add_argument("--issuer", required=True)
    parser.add_argument("--audience", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    profiles = json.loads(Path(args.profiles).read_text())
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    (output / "resource-policy.rego").write_text(resource_policy(profiles, args.issuer, args.audience))
    (output / "integration.json").write_text(json.dumps(integration_contract(profiles), indent=2) + "\n")
    (output / "kbs-config.toml").write_text(kbs_config("/var/lib/kbs", "/etc/kbs/issuer-root.crt",
                                                     "/etc/kbs/tls.crt", "/etc/kbs/tls.key", 8080))


if __name__ == "__main__":
    main()
