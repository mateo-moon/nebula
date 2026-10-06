import json
import tomli as tomllib
from pathlib import Path

import pytest
from approved_profile import candidate
from deployment import integration_contract, kbs_config, resource_policy
from verifier import Rejected, validate_profiles
from kbs_launcher import check_policy_seed


def test_measurements_produce_unapproved_review_candidate(flow):
    profile = candidate("workload-0", "v1", b"policy", {"Measurements": {"HashAlgorithm": "SHA384", "PCR4": "44" * 48, "PCR12": "00" * 48}},
                        ["default/image_key/workload-0"])
    with pytest.raises(Rejected, match="review"):
        validate_profiles(profile)


def test_pre_advisory_measurements_cannot_be_promoted():
    with pytest.raises(Rejected, match="PCR"):
        candidate("workload-0", "v1", b"policy", {"Measurements": {"HashAlgorithm": "SHA384", "PCR4": "44" * 48}}, ["default/image_key/workload-0"])


def test_generated_kbs_configuration_has_explicit_trust_and_denied_admin():
    config = tomllib.loads(kbs_config("/storage", "/issuer.crt", "/tls.crt", "/tls.key", 8080))
    assert config["attestation_token"]["insecure_header_jwk"] is False
    assert config["admin"]["authorization_mode"] == "DenyAll"
    assert config["http_server"]["insecure_http"] is False
    assert config["http_server"]["tls_min_version"] == "1.3"


def test_integration_contract_never_enables_deployment(flow):
    result = integration_contract(flow.profiles)
    assert result["deployment_enabled"] is False
    assert result["runtime_class"] == "kata-remote-aws-nitrotpm"
    assert result["runtime_handler"] == "kata-remote"
    assert "replicas" not in result
    assert result["workloads"][0]["policy_sha256"] == flow.profiles["workload-0"]["policy_sha256"]
    with pytest.raises(Rejected):
        integration_contract({})


def test_kbs_policy_binds_scope_and_measurements(flow):
    policy = resource_policy(flow.profiles, "https://verifier.example", "https://kbs.example")
    for field in ["input.iss", "input.aud", "input.aws.profile", "input.aws.policy_sha256", "input.aws.pcrs", "data.query", "input.exp"]:
        assert field in policy


def test_service_gates_and_fixed_configuration():
    root = Path(__file__).resolve().parents[1] / "image/root"
    mount = (root / "usr/lib/systemd/system/run-nebula-secrets.mount").read_text()
    assert "Where=/run/nebula/secrets" in mount and "Type=tmpfs" in mount
    for option in ["mode=0700", "nosuid", "nodev", "noexec"]:
        assert option in mount
    for service in ["kata-agent", "confidential-data-hub", "agent-protocol-forwarder"]:
        content = (root / f"usr/lib/systemd/system/{service}.service.d/90-attested-keys.conf").read_text()
        assert "Requires=aws-trustee-bootstrap.service" in content
        assert "BindsTo=run-nebula-secrets.mount" in content
        assert "StandardOutput=null" in content
    agent = tomllib.loads((root / "usr/share/nebula/agent.toml").read_text())
    assert agent["policy_file"] == "/usr/share/nebula/policy.rego"
    assert agent["debug_console"] is False and agent["dev_mode"] is False


def test_kbs_cannot_start_with_missing_or_permissive_policy(flow, tmp_path):
    config = tmp_path / "kbs.toml"
    storage = tmp_path / "storage"
    config.write_text(kbs_config(storage, "/issuer.crt", "/tls.crt", "/tls.key", 8080))
    with pytest.raises(Rejected, match="missing"):
        check_policy_seed(config, flow.profiles, "https://verifier.example", "https://kbs.example")
    policy = storage / "kbs/resource-policy.rego"
    policy.parent.mkdir(parents=True)
    policy.write_text("package policy\ndefault allow := true\n")
    with pytest.raises(Rejected, match="differs"):
        check_policy_seed(config, flow.profiles, "https://verifier.example", "https://kbs.example")
    policy.write_text(resource_policy(flow.profiles, "https://verifier.example", "https://kbs.example"))
    check_policy_seed(config, flow.profiles, "https://verifier.example", "https://kbs.example")
