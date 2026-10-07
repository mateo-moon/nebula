"""Refuse stock KBS startup unless the exact restrictive policy is preseeded."""
import argparse
import json
import os
from pathlib import Path

import tomli
from deployment import resource_policy
from verifier import require


def check_policy_seed(config_path, profiles, issuer, audience):
    config = tomli.loads(config_path.read_text())
    require(config["admin"]["authorization_mode"] == "DenyAll", "KBS admin must be denied")
    token = config["attestation_token"]
    require(token.get("insecure_header_jwk", False) is False and len(token["trusted_certs_paths"]) == 1
            and not token.get("trusted_jwk_sets"), "explicit issuer trust required")
    require(config["http_server"].get("insecure_http", False) is False
            and config["http_server"]["tls_min_version"] == "1.3", "TLS 1.3 required")
    require(config["storage_backend"]["storage_type"] == "LocalFs", "qualified local policy storage required")
    storage = Path(config["storage_backend"]["backends"]["local_fs"]["dir_path"])
    policy_file = storage / "kbs/resource-policy.rego"
    require(policy_file.is_file() and not policy_file.is_symlink(), "restrictive KBS policy missing")
    require(policy_file.read_text() == resource_policy(profiles, issuer, audience), "KBS policy differs from approved workloads")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument("--profiles", type=Path, required=True)
    parser.add_argument("--issuer", required=True)
    parser.add_argument("--audience", required=True)
    args = parser.parse_args()
    check_policy_seed(args.config, json.loads(args.profiles.read_text()), args.issuer, args.audience)
    os.execv(args.binary, [args.binary, "--config-file", str(args.config)])


if __name__ == "__main__":
    main()
