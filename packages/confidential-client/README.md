# Confidential client

Deploy an encrypted image to a Nebula Confidential stack from one page:

```sh
confidential-client ui
```

1. Open the public connection settings provided by your administrator.
2. Select a local `linux/amd64` image and paste your temporary access token.
3. Provide registry access and any existing disk keys requested by the page.
4. Review the prepared stack, then select **Encrypt & deploy**.

The page shows publication, independent measurement, attestation, ownership and startup progress. It provisions keys only after verifying the approved VM/workload and proving control with your own local owner key. **Verify again & check status** rechecks the enrolled instance. Reopen the same local client and select **Resume saved release** to retry without the temporary token or re-entering saved credentials. No Kubernetes access or further administrator action is required for this deployment.

Install the reviewed client package, local Docker, qualified TNG and native CoCo `genpolicy` once. Put the native tools on PATH, or start with `ui --tng /opt/tng/bin/tng --genpolicy /opt/kata/bin/genpolicy`. Native tools are installed separately; the UI never downloads or builds them. `--connection stack.json` preloads the public settings and `--no-open` prints the address. Private releases default to `~/.nebula/confidential`; override with `--directory`.

The browser is a presentation layer backed by your local client, following the UI/local-custody separation used by Polkadot.js. Signing, plaintext image processing, registry credentials and attestation verification stay on your computer. The owner private key is never returned to the page. The service binds only `127.0.0.1`, uses a random per-process browser capability, checks Origin/Host, and serves all assets locally with a restrictive CSP. Keep its private local address private while it runs.

Use an image with an absolute executable path in its ENTRYPOINT or CMD. The page shows the prepared UID, mounts and ports; your image must support them. OCI commands are hash-bound to the immutable manifest and enter native policy. Registry tags are release slots: replacing a running measured guest or changing its contract is a separate, explicitly approved lifecycle operation.

For registry access, enter a username and push token, choose an existing auth JSON, or use a local AWS profile for ECR. Registry credentials are stored only in the private local release directory.

## Administrator handoff

Pass `accessToken` to the Nebula `ConfidentialWorkload` construct during deployment. Use 32 random bytes encoded as 64 hex digits. The construct retains/emits only its SHA-256 commitment; the token is temporary first-claim authority. Keep plaintext tokens out of Git. For deterministic GitOps replay, retain the resulting public `ownerClaimSha256` in the deployment declaration. Set `commandFromImage: true` for a generic image slot.

Export one public connection file from the prepared declarations:

```sh
confidential-client connection workload.yaml --name workload \
  --host owner.example.test --port 8443 \
  --vcek /public/vcek.der --output stack.json
```

Give the user `stack.json`, their token and registry push access. Route raw TCP to `<workload-name>-owner:8443`. The connection file contains the reviewed workload/storage declaration, endpoint and optional public AMD certificate; it contains no token or key. The native verifier validates the certificate's AMD chain. The [full Nebula example](../nebula/example/confidential-workload-stack.ts) includes the operator, CRDs, retained disk, device helper and owner route.

The controller waits for publication, verifies encrypted layer annotations, pins the manifest digest and creates the measured guest automatically. It needs registry read access; it never needs a decryption key. The user independently reviews the public settings and pinned helpers before provisioning. An administrator who claims first can deny service; the client then refuses to release its keys. No external bootstrap Trustee is used.

## CLI and recovery

The browser uses the same TypeScript API as the CLI. Headless deployment accepts the temporary token directly, without an invitation file:

```sh
confidential-client deploy workload.yaml --name workload \
  --host owner.example.test --source-image my-app:release \
  --access-token "$CONFIDENTIAL_ACCESS_TOKEN" \
  --release-dir ./private-release --tng /opt/tng/bin/tng
```

Alternatively set `CONFIDENTIAL_ACCESS_TOKEN` and omit the argument. The CLI removes it from subprocess environments. `--registry-auth-file` supplies a private skopeo auth JSON; ECR uses your local AWS profile. `--vcek` enables native offline endorsement verification, avoiding AMD service throttling. `--volume-key name=/private/key` supplies an existing 32-byte volume key; new keys are generated only for an `IfEmpty` disk. `--resource-file repository/type/tag=/private/file` supplies declared application resources. Legacy `--claim-token <file>` remains supported.

Preserve your private release directory: owner key, image/disk keys, publication receipt and instance enrollment are required for recovery. Retrying uses the same ciphertext and keys. The UI stops safely and retains the release on failure. A new guest has a different TLS identity and empty Trustee; it must never be silently accepted as the enrolled instance.

Connected CLI commands use `--state <release>/owner-state --owner-key <release>/owner.key --audience <profile> --tng /opt/tng/bin/tng`:

| Command | Purpose |
| --- | --- |
| `attest`, `verify` | Verify SNP, workload identity and owner authorization. |
| `status`, `storage-status`, `bootstrap-status` | Read non-secret startup/storage diagnostics. |
| `put-resource`, `delete-resource` | Provision/remove an explicitly named resource. |
| `list-resource-policies`, `set-resource-policy`, `set-attestation-policy` | Manage reviewed Trustee policy. |
| `renew <new-state>` | Renew local verifier credentials while preserving enrollment. Add `--vcek` to cache a public AMD endorsement. |

Advanced `encrypt-publish`, `prepare-workload`, `enroll` and `configure-workload` expose individual stages. `owner-key` and `owner-header` support explicit key administration. `invite` is retained for legacy file-based invitations. See `confidential-client --help` for options.

Enrollment selects one approved instance; it does not enforce a global singleton. Disk rollback resistance and automatic Trustee replacement custody are not provided. The local machine and Docker runtime remain in the owner's trust boundary.
