# Confidential browser

The browser interface can be served from a measured SEV-SNP guest through TNG. No client installation, browser extension or settings upload is required. The user authenticates the first page by independently checking the browser's actual TLS certificate and attestation.

## User

1. Open the endpoint supplied by DevOps. Its self-signed certificate may produce a browser warning; accepting that warning alone does not verify attestation.
2. Export the certificate through the browser's own certificate viewer and follow [Check the browser's certificate](#check-the-browsers-certificate). Independently verify its AMD evidence, approved VM/native workload-policy measurements and binding to the certificate's public key. Obtain those expected measurements from an independently trusted release or review. Checking another connection to the same address alone is insufficient.
3. Confirm that independent check in the page. Enter the separately supplied one-time access token and an owner/recovery password of at least 12 characters. The page's certificate checker is available for convenience; it cannot authenticate its own initial JavaScript.
4. Choose a local `linux/amd64` Docker save archive within the limit shown by the verified stack. Review the complete application command, arguments and environment. Image defaults are used unless you separately approve the displayed overrides. Type the registry host you independently trust for your credentials, then enter push credentials, supply any requested existing disk key, and select **Encrypt & deploy**. Keep the latest encrypted recovery backup and its password.
5. Check **Data readiness**. It shows whether the required secrets are available, each encrypted disk is unlocked, and the application process is running. Application health remains separate: use the application's own health endpoint to check that it works.

Storage cards show the application mount paths, allocated capacity, persistence and key requirements. **Encrypted disk** is retained storage; usable filesystem space is smaller than its allocated size. **Temporary memory** is lost when the VM ends, but survives a supervised application restart. Names such as `audit` do not automatically enable logging. A configured mount is not a live mount check. Keep the retained disks and original image archive: the encrypted recovery backup contains keys and settings, not the disk's files or a copy of that archive.

The browser encrypts image layers locally in a worker using the native OCIcrypt AES-256-CTR/HMAC-SHA256 format and CoCo A256GCM key wrapping. TNG WASM verifies the preparation VM and its enrolled transport key before sending ciphertext or registry credentials. That VM publishes the encrypted layers and independently runs native CoCo genpolicy without the image key. Kubernetes starts the final workload when its reserved tag becomes available. The browser then verifies that workload, enrolls its unique transport key, claims its unmodified Trustee and provisions keys directly to it. Image and disk keys never go to the preparation service. The image key is provisioned directly to the verified final Trustee. No external bootstrap Trustee is used.

Returning users repeat the certificate check, then unlock their password-encrypted browser vault or restore the latest encrypted recovery file. This mode stores no usable signing or wrapping keys in browser storage. Once the image is published, the page hides the upload and registry fields. Use **Verify again & refresh status** to continue or check the same release; it does not require republishing. Saved progress is distinct from current readiness, and failed checks leave previous observations labelled as such. The downloadable verification record contains the attestation and enrollment results. A saved owner that has not generated any release keys can resume setup with its original preparation instance. Current recovery files can resume before the final pin is saved by consulting the owner-authenticated journal in the same pinned preparation VM. The journal commits the first final instance before any claim or key release and refuses replacements. Older recovery files without this protocol or a final pin still fail closed; loss of the preparation VM cannot reset that trust.

New setup accepts only the preparation release reviewed with the current frontend. Earlier approved releases remain available solely to recover an existing saved preparation pin, with the same instance-key and owner checks. A server response or routing URL cannot enable legacy fallback for a new owner. The current preparation service and client also require the current reviewed final-workload runtime for a new binding; historical runtime profiles cannot authorize a new deployment.

## Check the browser's certificate

Use the certificate viewer for the **same tab that will receive your secrets**. Export its leaf/site certificate as DER or PEM, rather than its issuer or a chain. Chrome and Edge expose it in DevTools → Security → View certificate; Firefox exposes it through the site's connection details → More information → View Certificate. See the official [Chrome](https://developer.chrome.com/docs/devtools/security), [Edge](https://learn.microsoft.com/en-us/microsoft-edge/devtools/security/) and [Firefox](https://support.mozilla.org/en-US/kb/secure-website-certificate) guides. If an embedded view cannot show its certificate, open the portal in a browser that can and verify that connection.

Read a DER export's SHA-256 fingerprint and validity:

```sh
openssl x509 -inform DER -in browser-leaf.der \
  -noout -fingerprint -sha256 -dates
```

For PEM, omit `-inform DER` and use your PEM filename. Add `-text` to inspect the X.509 fields and extensions. This reads certificate data; it does **not** verify the embedded AMD evidence. The certificate fingerprint hashes the entire DER certificate. The TLS public-key fingerprint hashes its DER SubjectPublicKeyInfo (SPKI), so those two values differ. Certificate renewal can change the certificate fingerprint while retaining its public key. The OHTTP instance pin is a separate transport-key field.

Use your own trusted verifier, or obtain a reviewed TNG build through the [native verifier build guide](../../tools/tng-client/README.md). Verify its source, workflow and artifact checksums independently. Do not obtain the verifier or its expected policy solely from the page being checked. An approved `approved-verify.json` uses this built-in CoCo configuration, with the base64-encoded Rego policy approved for the deployment:

```json
{
  "model": "background_check",
  "as_provider": "coco",
  "as_type": "builtin",
  "attestation_policy": { "type": "inline", "content": "BASE64_OF_THE_INDEPENDENTLY_APPROVED_POLICY" },
  "reference_values": []
}
```

The policy must enforce the approved SNP launch measurement, native workload-policy digest (`HOST_DATA` / `init_data`), minimum reported TCB, and disabled debug and migration; pin chip identity where required. TNG also verifies the AMD evidence and its binding to the certificate's public key. Run the reviewed native tool against the exported certificate:

```sh
tng tools rats-tls verify --cert browser-leaf.der \
  --verify "$(cat approved-verify.json)"
```

The same command accepts PEM. `--verify` takes JSON text, not a filename. The built-in verifier needs no external Trustee; it may fetch public AMD endorsements. Success exits with code 0 and prints `verified OK` followed by an attestation-result JWT. Stop on any error or nonzero exit. Decoding a JWT makes its claims readable; decoding alone does not verify its signature, key binding or policy.

The page's checker and `/certificate.der` download are conveniences. Verify the browser-exported bytes. If you use a reported download instead, first compare its complete certificate fingerprint with this tab's actual leaf. Matching the public-key fingerprint alone is not a full attestation check. A fresh nonce does not establish trust in JavaScript displaying its own result. Enter tokens, passwords and registry credentials only after the independent check succeeds. Keep the verification record for review; it does not replace your encrypted recovery backup.

### Where the expected measurements come from

The certificate checker's VM field is prefilled from a release profile bundled with the UI. Maintainers calculate this reference offline from reviewed guest boot files, the exact kernel command line and virtual CPU settings, then manually commit it to that profile. The page does not calculate an expected value from the running VM or adopt the value in its report.

See [Where the VM measurement comes from](measurement-reference.md) for the complete configuration → calculation → release profile → UI path, public boot-file checksums, the [current calculation record](qualification/snp-launch-2026-11-12.json), and links to the pinned calculator, Kata release and relevant source code. Obtain the reference from a commit or review you independently trust. The older `qualification/snp-launch.json` belongs to the previous guest-kernel configuration.

The separate workload-policy field needs the frontend's native genpolicy **Init-Data SHA-256** from its reviewed deployment plan. The VM launch measurement alone does not approve the container workload. Preparation and final guests have their own workload-policy bindings.

### Download the verification record

Select **Download verification record**, then check your browser's Downloads for `nebula-verification.json`. The page confirms that the download was requested and keeps **Download this record again** visible for retries. This link downloads the same snapshot; use the button to prepare a new one. Its `checkedAt` is the export time, and its preparation/final evidence is the most recent available result. Exporting does not run a fresh attestation. Use **Verify again & refresh status** first when you need a new final-workload check.

## Administrator

Use `ConfidentialOperator`, `ConfidentialStorage` and `ConfidentialWorkload` for the generic workload, a `ConfidentialBrowser` preparation VM, and a separate diskless `ConfidentialBrowser` frontend:

```ts
new ConfidentialBrowser(chart, "browser-ui", {
  name: "browser-ui", namespace, agentImage: frontendImage, tngImage: http1TngImage,
  nodeSelector, network,
  manualTls: {
    preparationEndpoint: "https://preparation.example.org/",
    stackEndpoint: "https://stack.example.org/",
    attestationReady: true, // Current frontend publishes the guest-memory readiness marker.
  },
});
```

Enable `manualTls.attestationReady` only for a frontend release that supports attestation prewarming. Older frontend images omit it and retain their original startup. This setting coordinates startup; it does not approve an image or replace attestation.

Pin the images and generate native policy during synthesis. The frontend image contains the reviewed browser assets and approved preparation profiles. Forward public TCP directly to its TNG service on port 10443; TLS must terminate inside the guest. This first-page path needs no ACME, DNS-custodian key or administrator-controlled CA. Do not put TLS private keys in Kubernetes.

The frontend serves the first page and verifier; preparation publishes ciphertext and generates the final workload policy. Both use the agent entrypoint. Separate releases let the verifier pin the preparation image and policy without embedding its own image hash. For a small qualification image, `runtime: { memoryMiB: 2048 }` can size either guest. CoCo needs space to unpack both images inside the guest; a 1 GiB frontend is insufficient. Omission keeps the existing 4 GiB default. Larger upload limits retain their required memory floor; check host capacity before creating additional guests.

For archives up to 4 GiB, configure the preparation VM with a reviewed image containing chunk-upload support:

```ts
new ConfidentialBrowser(chart, "preparation", {
  name: "preparation", namespace, agentImage: preparationImage, tngImage,
  nodeSelector, network, maxImageSizeMiB: 4096,
});
```

This allocates a 32 GiB preparation VM with 20 GiB of guest-memory workspace. Ensure the existing host has capacity. The application VM's own memory remains a separate workload setting. Omit `maxImageSizeMiB` to preserve the 256 MiB limit and existing 4 GiB VM plan. Limits are bound by native genpolicy and fetched through the attested channel; users do not supply a settings file.

A browser worker encrypts one MiB at a time and temporarily stores only ciphertext and standard public OCI metadata in private browser file storage (OPFS). Allow enough local free space for one encrypted copy. The password-encrypted owner vault binds its manifest for retries; it contains the image key separately from this ciphertext cache. Its encrypted recovery backup includes the public encrypted manifest/configuration. If local ciphertext is lost, select the unchanged original archive: the worker verifies every plaintext layer before reusing its saved encryption parameters, then verifies every regenerated ciphertext digest before uploading. After publication is confirmed the browser removes the cache. **Clear local ciphertext cache** removes only the current owner's cached files and retains recovery metadata.

Uploads use owner-authenticated requests of at most 8 MiB. The service accepts only version-2 encrypted OCI metadata and layer blobs, checks every chunk and complete layer digest, and rejects plaintext archive, registry-source and image-key inputs. Interrupted uploads resume from owner-authenticated offsets, accept byte-identical retries and reject changed manifests/chunks. It publishes immutable ciphertext with Skopeo and preserves native genpolicy.

OCI image encryption protects filesystem layers; the manifest and configuration (entrypoint, environment, labels and history) remain readable. Put secrets in Trustee resources instead of image configuration. The browser never executes the selected image.

The frontend keeps its six-hour TLS certificate stable for five hours so browser exceptions survive setup and SDK downloads. Renewal requires a new manual certificate check. `manualTls.certificateRefreshSeconds` can preserve an older measured renewal interval; its maximum is five hours. Preparation and final OHTTP requests retain their fresh attestation checks.

Configure the workload with `browserOwner: true` and `accessLink.browser.manualTls: true`. Set `loaderUrl` to the frontend's dedicated HTTPS origin, `invitationEndpoint` to the preparation's internal `/invitation` service on port 8089, and `workloadEndpoint`/`ownerEndpoint` to its preparation/final OHTTP endpoints. Allow only its named access Secret in the operator.

The preparation VM generates the disposable token in guest memory. The operator stores the frontend endpoint in Secret `url` and the credential separately in Secret `token`. Give them to the user separately. Neither the URL nor its fragment may contain a usable token. After ownership is claimed, owner signatures authenticate subsequent operations. Never publish the invitation port or guest-loopback services. If the operator has a custom name or namespace, set preparation `invitationAccess: { namespace: "operators", podSelector: { app: "custom-operator" } }`; this changes only its NetworkPolicy.

If preparation restarts before ownership or final-guest creation, the operator refreshes the unused token from that guest. Retrieve the current Secret again. A user whose unused setup saved an outdated token can enter its replacement when unlocking; the client retains their owner key and preparation pin and verifies that the same preparation instance is still unclaimed. Claimed invitations and existing guest enrollments are never reset this way. A host-only kernel patch does not change the guest's software measurement; a guest restart still changes its memory-held instance keys and requires fresh verification or explicit owner recovery.

**Recover interrupted empty-disk setup** offers an action only when the enrolled guest proves its owned sealed header has no existing filesystem and an empty ciphertext payload. Each explicit approval is bound to that guest's inner TLS key, header fingerprint and a short-lived challenge. Other disk contents require manual recovery. Supervisor status reports helper process liveness; it does not prove application health.

Ordinary proxies may carry the preparation/final OHTTP endpoints: their contents remain encrypted to the separately attested VM. Their DNS/HTTPS authority does not authenticate the initial page. The generic [full-stack example](../nebula/example/confidential-workload-stack.ts) includes a TCP route for the frontend; the DevOps testcase uses the existing SNP host and preserves earlier guests and disks.

## Build and limits

This package contains browser assets and encryption code. The backend modules and single service entrypoint live in [confidential-agent](../confidential-agent/README.md). Frontend and preparation images build that same agent and enable only their measured module; neither can activate workload storage modules through an HTTP request.

Build the pinned SNP SDK with `sh tools/tng-browser/build.sh NEW_SOURCE OUTPUT`, then run `TNG_WASM_PATH=OUTPUT pnpm --dir packages/confidential-browser build`. Build `docker/confidential-browser/Dockerfile.tls` with the resulting public `dist/loader` directory as its `browser-assets` build context. The frontend has no owner credentials, persistent disk, Kubernetes credential or certificate-enrollment API. Its private TLS key stays in TNG memory. Recheck renewed certificates and changed guest keys.

`LARGE_IMAGE_UPLOAD_TEST=1 pnpm --dir packages/confidential-browser test` also exercises an exact 4 GiB transfer into a temporary archive, using bounded chunks and deleting the test file afterward.

The independent user check, browser and approved guest software are trusted. The served checker and server-reported fingerprints are conveniences, not independent authorities. Administrators can deny service or claim first; a legitimate owner must stop before uploading secrets to an already claimed stack. Instance substitution is rejected after enrollment. Global singleton enforcement, disk rollback protection and automatic Trustee replacement custody remain outside scope.

Earlier independently hosted loader releases remain compatible with retained testcases. Their browser qualification is recorded in [the existing report](qualification/sev-snp-browser-2026-10-27.json); it does not qualify the new manual TLS frontend.
