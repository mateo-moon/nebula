# Confidential client

For an installation-free deployment, open the one-time HTTPS link supplied by your administrator. The independent browser loader verifies the preparation VM with TNG WASM and fetches its UI through the attested encrypted channel. Choose your image, enter registry access, review the stack and select **Encrypt & deploy**. Keep the latest encrypted recovery backup. No settings file, Kubernetes access or administrator follow-up is needed.

The [browser guide](../confidential-browser/README.md) covers this flow, recovery and administrator setup. The page shows the expected VM/workload measurements, pinned software, transport enrollment, fresh attestation and startup/storage status. A cluster cannot approve itself by supplying its own trust profile. Subsequent access uses your browser's owner signature; the temporary invitation is consumed.

## Native CLI

The TypeScript `confidential-client` package remains available for headless administration and owners who prefer local image processing. Install the reviewed package, Docker, qualified native TNG and CoCo `genpolicy`. These native tools are unnecessary for the browser flow.

```sh
confidential-client deploy workload.yaml --name workload \
  --host owner.example.test --source-image my-app:release \
  --access-token "$CONFIDENTIAL_ACCESS_TOKEN" \
  --release-dir ./private-release --tng /opt/tng/bin/tng
```

Alternatively set `CONFIDENTIAL_ACCESS_TOKEN` and omit the argument. `--registry-auth-file` supplies a private skopeo auth JSON; ECR can use your local AWS profile. `--volume-key name=/private/key` supplies an existing 32-byte disk key. `--resource-file repository/type/tag=/private/file` supplies a declared application resource. A new key is generated only for an `IfEmpty` disk. Legacy token-file invitations and public connection files remain supported.

Preserve the private release directory: owner key, encryption keys, publication receipt and instance enrollment are needed for recovery. Retries reuse the same ciphertext and keys. `confidential-client ui` still starts the optional native-backed local interface; it does not serve or authenticate the installation-free browser loader.

Connected commands take `--state <release>/owner-state --owner-key <release>/owner.key --audience <profile> --tng /opt/tng/bin/tng`:

| Command | Purpose |
| --- | --- |
| `attest`, `verify` | Verify SNP, measured workload and owner authorization. |
| `status`, `storage-status`, `bootstrap-status` | Read non-secret startup and storage diagnostics. |
| `put-resource`, `delete-resource` | Provision or remove a named resource. |
| `list-resource-policies`, `set-resource-policy`, `set-attestation-policy` | Manage Trustee policy as its owner. |
| `renew <new-state>` | Renew verifier credentials while preserving instance enrollment. |

`encrypt-publish`, `prepare-workload`, `enroll` and `configure-workload` expose individual stages. `owner-key` and `owner-header` support explicit key administration. `--vcek` supplies a cached public AMD endorsement for native verification. See `confidential-client --help` for all options.

Registry publication tags are release slots. The operator resolves a published encrypted image to its immutable digest, binds OCI Entrypoint/Cmd to its manifest and creates the measured guest automatically. Native and browser clients refuse a changed enrolled instance. A new release or replacement guest needs explicit enrollment; neither native CoCo nor this client enforces a global singleton or prevents disk rollback.
