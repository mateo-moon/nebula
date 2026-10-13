"""Exercise the pinned CDH image client without a registry or workload keys."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import tomllib

AUTH_ENV = "CDH_DEFAULT_IMAGE_AUTHENTICATED_REGISTRY_CREDENTIALS"


def check_config(binary, source):
    overlay = source / "image/root"
    config_text = (overlay / "usr/share/nebula/cdh.toml").read_text()
    config = tomllib.loads(config_text)
    assert config["kbc"] == {"name": "offline_fs_kbc", "url": "null"}
    assert config["image"]["anonymous_fallback_on_unauthorized"] is False
    assert "authenticated_registry_credentials_uri" not in config["image"]
    unit = overlay / "usr/lib/systemd/system/confidential-data-hub.service.d/90-attested-keys.conf"
    settings, unset = {}, set()
    for line in unit.read_text().splitlines():
        key, _, value = line.partition("=")
        if key == "Environment":
            for entry in shlex.split(value):
                name, separator, content = entry.partition("=")
                assert separator
                settings[name] = content
        elif key == "UnsetEnvironment":
            unset.update(shlex.split(value))
    assert AUTH_ENV in unset and AUTH_ENV not in settings, "remove the inherited override instead of assigning an empty URI"
    with tempfile.TemporaryDirectory(prefix="nebula-cdh-config-") as temporary:
        root = Path(temporary)
        # Only the test work directory changes; the deployed CDH settings and
        # upstream config loader/image client are used without source patches.
        text = config_text.replace('work_dir = "/run/nebula-images"', 'work_dir = ' + json.dumps(str(root / "images")))
        assert text != config_text
        config_path = root / "cdh.toml"
        config_path.write_text(text)
        credentials = root / "auth.json"
        credentials.write_text('{"auths":{}}')
        base = {**os.environ, **settings, "RUST_LOG": "error", "OCICRYPT_KEYPROVIDER_CONFIG": str(root / "ocicrypt.json")}
        cases = [("empty-override", "", False), ("missing-override", (root / "missing.json").as_uri(), False),
                 ("explicit-valid-override", credentials.as_uri(), True), ("released-unset-override", None, True)]
        for name, override, initialized in cases:
            environment = {**base, AUTH_ENV: override if override is not None else "file:///run/peerpod/auth.json"}
            if override is None:
                for variable in unset: environment.pop(variable, None)
            result = subprocess.run([str(binary), "--config", str(config_path), "pull-image", "--image-url", "invalid image reference",
                "--bundle-path", str(root / "bundle")], env=environment, capture_output=True, text=True, timeout=30)
            assert result.returncode != 0, "the deliberately invalid reference must be rejected"
            output = result.stdout + result.stderr
            if initialized:
                assert "IllegalImageReference" in output and "InitializeResourceProviderFailed" not in output, name + ": image client did not initialize"
            else:
                assert "InitializeResourceProviderFailed" in output and "ReadLocalFile" in output, name + ": missing credential regression did not reproduce"
        print(json.dumps({"cdhImageClientConfigurationCases": len(cases), "passed": True}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", type=Path, required=True)
    parser.add_argument("--source", type=Path, default=Path(__file__).resolve().parents[1])
    args = parser.parse_args()
    check_config(args.binary, args.source)
