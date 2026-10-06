"""Image-description staging checks; fixtures are not bootable Linux images."""
import hashlib
import json
from pathlib import Path

import pytest

import prepare_image
from verifier import Rejected


@pytest.fixture
def inputs(tmp_path, monkeypatch):
    base, caa = tmp_path / "base", tmp_path / "caa"
    description = base / prepare_image.BASE_DESCRIPTION
    description.mkdir(parents=True)
    (description / "appliance.kiwi").write_text(
        '<image><preferences><type filesystem="xfs" overlayroot="true"/></preferences>'
        '<packages type="image"><package name="zram-generator"/></packages></image>'
    )
    files = caa / "src/cloud-api-adaptor/podvm/files"
    for name in ["kata-agent", "confidential-data-hub", "agent-protocol-forwarder", "netns@"]:
        unit = files / f"etc/systemd/system/{name}.service"
        unit.parent.mkdir(parents=True, exist_ok=True)
        unit.write_text("[Service]\nExecStart=/fixture\n")
    (files / "etc/ocicrypt_config.json").write_text("{}")
    policy = tmp_path / "policy.rego"
    policy.write_text("package agent_policy\n" + "\n".join(f"default {rpc} := false" for rpc in [
        "ExecProcessRequest", "ReadStreamRequest", "WriteStreamRequest", "SetPolicyRequest",
        "GetDiagnosticDataRequest", "CreateContainerRequest",
    ]) + "\n")
    config = tmp_path / "bootstrap.json"
    config.write_text(json.dumps({"workload": "sample", "verifier_url": "https://verifier.example",
                                 "kbs_url": "https://kbs.example", "resources": ["default/image_key/sample"]}))
    ca = tmp_path / "ca.crt"
    ca.write_text("public test fixture, not a certificate")
    binary = tmp_path / "binary"
    binary.write_bytes(b"\x7fELFnon-bootable-test-fixture")
    binaries = {name: {"path": str(binary), "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                       "revision": "a" * 40} for name in prepare_image.BINARY_NAMES}
    dirty = set()

    def git(args, text):
        assert text and args[:2] == ["git", "-C"]
        repo = Path(args[2])
        assert repo in [base, caa]
        if args[3:] == ["rev-parse", "HEAD"]:
            return (prepare_image.BASE_REVISION if repo == base else prepare_image.CAA_REVISION) + "\n"
        assert args[3:] == ["status", "--porcelain", "--untracked-files=all"]
        return " M source\n" if repo in dirty else ""

    monkeypatch.setattr(prepare_image.subprocess, "check_output", git)
    return [base, caa, policy, config, ca, binaries, tmp_path / "image"], dirty


def test_staging_enables_the_runtime_without_a_post_install_command(inputs):
    args, _ = inputs
    prepare_image.stage(*args)
    root = args[-1] / "root"
    units = root / "etc/systemd/system"
    enabled = units / "multi-user.target.wants/agent-protocol-forwarder.service"
    assert enabled.is_symlink()
    assert enabled.resolve() == units / "agent-protocol-forwarder.service"
    assert (root / "usr/share/nebula/bootstrap.json").read_bytes() == args[3].read_bytes()
    assert (units / "process-user-data.service").readlink() == Path("/dev/null")
    assert (units / "scratch-storage.service").readlink() == Path("/dev/null")
    assert (root / "usr/lib/systemd/system/aws-caa-transport.service").is_file()
    assert (root / "usr/lib/systemd/system/run-peerpod.mount").is_file()
    # Source staging is not a production approval, even after successful staging.
    manifest = json.loads((root / "usr/share/nebula/build-manifest.json").read_text())
    assert manifest["deployment_enabled"] is False


@pytest.mark.parametrize("index", [0, 1], ids=["kiwi", "caa"])
def test_a_pinned_revision_does_not_allow_modified_build_inputs(inputs, index):
    args, dirty = inputs
    dirty.add(args[index])
    with pytest.raises(Rejected, match="must be clean"):
        prepare_image.stage(*args)
    assert not args[-1].exists()
