# Confidential client

Deploy an encrypted image to a Nebula Confidential stack from one page:

```sh
confidential-client ui
```

1. Paste the access link provided by your administrator: `https://stack.example:443/#one-time-token`.
2. Select a local `linux/amd64` image.
3. Provide registry access and any existing disk keys requested by the page.
4. Review the prepared stack, then select **Encrypt & deploy**.

The page shows publication, independent measurement, attestation, ownership and startup progress. It provisions keys only after verifying the approved VM/workload and proving control with your own local owner key. **Verify again & check status** rechecks the enrolled instance. Reopen the same local client and select **Resume saved release** to retry without the temporary token or re-entering saved credentials. No Kubernetes access or further administrator action is required for this deployment.

Settings are fetched automatically; no settings file is needed. The client
checks the advertised software and VM against a reviewed profile shipped with
the client. A stack cannot approve itself by advertising its own measurements.
The security overview shows expected VM/workload measurements, pinned software,
storage, the enrolled guest and owner fingerprints, last local attestation time
and the checks performed by native TNG/Trustee AS. Kubernetes status is labelled
separately as operational information. A downloadable verification record
contains public check results, not a fabricated raw quote or any private key.

Install the reviewed client package, local Docker, qualified TNG and native CoCo `genpolicy` once. Put the native tools on PATH, or start with `ui --tng /opt/tng/bin/tng --genpolicy /opt/kata/bin/genpolicy`. Native tools are installed separately; the UI never downloads or builds them. `--connection stack.json` preloads the public settings and `--no-open` prints the address. Private releases default to `~/.nebula/confidential`; override with `--directory`.

The browser is a presentation layer backed by your local client, following the UI/local-custody separation used by Polkadot.js. Signing, plaintext image processing, registry credentials and attestation verification stay on your computer. The owner private key is never returned to the page. The service binds only `127.0.0.1`, uses a random per-process browser capability, checks Origin/Host, and serves all assets locally with a restrictive CSP. Keep its private local address private while it runs.

Use an image with an absolute executable path in its ENTRYPOINT or CMD. The page shows the prepared UID, mounts and ports; your image must support them. OCI commands are hash-bound to the immutable manifest and enter native policy. Registry tags are release slots: replacing a running measured guest or changing its contract is a separate, explicitly approved lifecycle operation.

For registry access, enter a username and push token, choose an existing auth JSON, or use a local AWS profile for ECR. Registry credentials are stored only in the private local release directory.

## Administrator handoff

Set `spec.accessLink` on the workload and allow that Secret in the operator:

```ts
// ConfidentialOperator options:
accessLinkSecrets: [{ namespace: "confidential", name: "workload-access" }]

// ConfidentialWorkload spec (instead of ownerClaimSha256):
accessLink: {
  url: "https://stack.example/",
  ownerPort: 8443,
  secretName: "workload-access",
}
```

Route HTTPS for that unique host to `confidential-operator-access:8083` and raw
TCP on the owner port to `<workload-name>-owner:8443`. The owner connection must
keep TNG and guest TLS intact. Use `commandFromImage: true` for the generic slot.
The operator generates 32 random bytes at reconciliation and stores the URL in
the Secret's `url` entry. Synthesis stays deterministic. Retrieve and give the
user that URL plus registry push access:

```sh
kubectl -n confidential get secret workload-access -o jsonpath='{.data.url}' | base64 --decode
```

The token authorizes only first claim. The local client checks attestation and
owner authorization before consuming it and provisioning keys. Consumption
removes the token and URL from the current Secret. Subsequent metadata access
uses the user's signature with a separate audience; Trustee administration uses
the user's owner JWT through the attested, pinned guest channel. No permanent
user credential or decryption key is stored in Kubernetes. An administrator can
claim first and deny service; the real client then refuses key release.

The selected runtime/VM profile must be supported by the reviewed client
release. A new measured runtime requires a reviewed matching client profile;
discovery never downloads a replacement trust policy from the stack itself.

Legacy deployments can still supply `accessToken` during synthesis, emit its
public commitment and hand off public settings manually. The advanced file
import and the following export command remain available for those deployments:

Export one public connection file from the prepared declarations:

```sh
confidential-client connection workload.yaml --name workload \
  --host owner.example.test --port 8443 \
  --vcek /public/vcek.der --output stack.json
```

The legacy connection file contains the reviewed workload/storage declaration, endpoint and optional public AMD certificate; it contains no token or key. The native verifier validates the certificate's AMD chain. An automatic deployment can supply that public certificate as `accessLink.vcekCertificate`. The [full Nebula example](../nebula/example/confidential-workload-stack.ts) includes the operator, CRDs, retained disk, device helper and both routes.

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
