# Confidential client

For an installation-free deployment, open the endpoint supplied by your administrator and independently verify the browser's actual RA-TLS certificate and approved measurements before entering the separately supplied access token. The page's checker is a convenience, not an independent trust anchor. TNG WASM then verifies the preparation and final workload connections. Choose a local Docker save archive, review the complete application settings and registry destination, and select **Encrypt & deploy**. The browser encrypts layers locally; only ciphertext and public OCI metadata reach preparation, and the image key goes directly to the verified final Trustee. Keep the latest encrypted recovery backup. No settings file, Kubernetes access or administrator follow-up is needed.

The [browser guide](../confidential-browser/README.md) covers this flow, recovery and administrator setup. The page shows the expected VM/workload measurements, pinned software, transport enrollment, fresh attestation and startup/storage status. A cluster cannot approve itself by supplying its own trust profile. Subsequent access uses your browser's owner signature; the temporary invitation is consumed.

## Native CLI

The TypeScript `confidential-client` package remains available for headless administration and owners who prefer local image processing. Install the reviewed package, qualified native TNG and CoCo `genpolicy`. Local image encryption/publication also uses a trusted local Docker runtime. Verification itself starts no Docker AS and opens no shared TCP verifier/proxy ports. These native tools are unnecessary for the browser flow.

Export the application contract, then independently review its command overrides, complete environment, UID/GID, mounts, resources, exposed ports, network and registry routes. Exporting the document does not approve it. Pass it to deployment only after approving those settings; a reviewed runtime profile alone does not approve administrator-selected application behavior. Without a command override, execution comes from your image.

```sh
confidential-client application-approval workload.yaml --name workload \
  --output application-approval.json

confidential-client deploy workload.yaml --name workload \
  --host owner.example.test --source-image my-app:release \
  --application-approval application-approval.json \
  --release-dir ./private-release --tng /opt/tng/bin/tng
```

Supply the first-claim credential through `CONFIDENTIAL_ACCESS_TOKEN` or `--access-token`. `--registry-auth-file` supplies a private skopeo auth JSON; ECR can use your local AWS profile. Confirm that credentials belong to the approved destination registry. `--volume-key name=/private/key` supplies an existing 32-byte disk key. `--resource-file repository/type/tag=/private/file` supplies a declared application resource. A new key is generated only for an `IfEmpty` disk. Legacy token-file invitations and public connection files remain supported. Changed application settings require a new explicit approval; the original reserved tag is bound separately to the verified encrypted publication digest.

Preserve the private release directory: owner key, encryption keys, application approval, publication receipt and instance enrollment are needed for recovery. Retries reuse the same ciphertext and keys. `confidential-client ui` starts the optional native-backed local interface. Open its printed session URL yourself and keep that URL private; the CLI does not pass its capability to a browser-opening process. It does not serve or authenticate the installation-free browser loader.

Each native connection uses a private Unix socket and TLS 1.3 with `rats-tls` ALPN. Qualified TNG appraises the certificate from that same live connection against the approved SNP identity before forwarding owner bytes. Enrolled administration additionally uses pinned inner TLS. A renewed inner certificate is accepted only after fresh outer verification and confirmation of the existing instance public key; a changed key requires explicit replacement enrollment.

Connected commands take `--state <release>/owner-state --owner-key <release>/owner.key --audience <profile> --tng /opt/tng/bin/tng`:

| Command | Purpose |
| --- | --- |
| `attest`, `verify` | Verify SNP, measured workload and owner authorization. |
| `status`, `storage-status`, `bootstrap-status` | Read non-secret startup and storage diagnostics. |
| `storage-recovery-plan`, `recover-storage` | Review and explicitly authorize resuming one verified empty interrupted filesystem. |
| `put-resource`, `delete-resource` | Provision or remove a named resource. |
| `list-resource-policies`, `set-resource-policy`, `set-attestation-policy` | Manage Trustee policy as its owner. |
| `renew <new-state>` | Renew legacy local state credentials while preserving instance enrollment. |

`encrypt-publish`, `prepare-workload`, `enroll` and `configure-workload` expose individual stages. `owner-key` and `owner-header` support explicit key administration. See `confidential-client --help` for all options.

Storage recovery never reformats unknown or nonzero data. The native helper can propose a short-lived plan only for an authenticated owned LUKS header with an entirely zero ciphertext payload. `storage-recovery-plan --storage <name> --output <file>` saves that exact instance/header challenge. After reviewing it, `recover-storage <file> --acknowledge 'RESUME ONLY THIS VERIFIED EMPTY FILESYSTEM'` authorizes the one action; inspect `storage-status` afterward. A partially written filesystem requires manual recovery instead. Existing data and keys are retained when a plan is refused.

The current state format retains and validates the earlier AS configuration, policy and signing files for compatibility; they do not start a local AS or establish trust in the new runtime. An optional `--vcek` supplies a public AMD endorsement cache to builtin TNG verification. TNG still checks the endorsement chain, report signature and approved chip/TCB; the cache is not an approval authority. It avoids repeated KDS downloads when the guest evidence omits the endorsement. A future state-format migration is separate from this compatibility path.

Registry publication tags are release slots. The operator resolves a published encrypted image to its immutable digest, binds OCI Entrypoint/Cmd to its manifest and creates the measured guest automatically. Native and browser clients refuse a changed enrolled instance. A new release or replacement guest needs explicit enrollment; neither native CoCo nor this client enforces a global singleton or prevents disk rollback.
