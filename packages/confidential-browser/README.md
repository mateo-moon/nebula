# Confidential browser

For the workload-hosted first page, see the [attested HTTPS PoC](HTTPS.md).
It requires DNS and certificate custody independent of the administrators being excluded.

Open the one-time HTTPS link supplied by your administrator. Nothing is installed on your computer. The independent Nebula loader verifies AMD SEV-SNP evidence in TNG WASM, checks the approved VM and native workload-policy measurements, and pins the preparation VM's transport key. It then fetches **all UI assets through that attested encrypted channel**.

Choose a `linux/amd64` image archive (up to 256 MiB), or an image in the destination registry. For a registry source, use an owner-controlled registry and an immutable `@sha256:…` reference; its plaintext source remains in that registry. Enter registry push credentials, supply an existing disk key only when requested, and choose a recovery password. Review the stack, then select **Encrypt & deploy**. Keep the latest downloaded encrypted recovery file and its password.

The preparation VM encrypts and publishes the image and independently runs native CoCo `genpolicy`. Kubernetes automatically creates the final workload when its reserved tag becomes available. Your browser verifies its resulting measurement, enrolls its transport key, claims its unmodified Trustee and sends image, disk and application keys directly to that enrolled VM. Disk keys are never sent to the preparation service. No external bootstrap Trustee is used.

Reopen the same link to use the owner key saved in this browser. The one-time token is no longer needed. A different browser needs your latest encrypted recovery file. **Verify again & check status** performs fresh attestation of the enrolled instance. Startup/key-delivery status is shown separately from application health.

Keep the updated recovery file, which includes the final instance enrollment. If an automatic download is blocked, use its visible download link. Returning owners can enter a recovery password and choose **Back up current enrollment** to export it again. **Check key and policy isolation** checks that remote key reads and unauthorized policy changes are refused.

## Administrator setup

Use `ConfidentialBrowser` alongside `ConfidentialOperator`, `ConfidentialStorage` and `ConfidentialWorkload`. Pin a reviewed preparation image and its native policy in the independently hosted loader release. Configure `browserOwner: true` and `accessLink.browser` with:

- `invitationEndpoint`: the preparation service's internal `/invitation` endpoint on port 8089.
- `workloadEndpoint`: the public HTTPS preparation OHTTP endpoint (service port 8445).
- `ownerEndpoint`: the public HTTPS final OHTTP endpoint (owner service port 8445).
- `loaderUrl`: the independent HTTPS loader release.

Route public stack discovery to `confidential-operator-access:8083` and allow only the named access Secret in the operator. Publish neither port 8089 nor guest-loopback services. The preparation VM generates the one-time token in guest memory; the operator exports the resulting URL into the named Kubernetes Secret. Retrieve its `url` entry and give that link and registry access to the user.

The loader's trusted profile comes from the reviewed release, never from discovery or the workload it verifies. A new preparation image, native policy template or guest launch identity needs a reviewed profile. A reverse proxy may terminate ordinary HTTPS: application credentials and keys remain encrypted inside OHTTP. Keep the loader origin independently controlled from the cluster administrators whose workloads it authenticates. Publish each loader release to a new versioned directory and give deployments that release URL, so browser caching cannot mix SDK or policy versions.

## Release and trust boundary

Build the pinned SNP SDK with `sh tools/tng-browser/build.sh NEW_SOURCE OUTPUT`. Then run `TNG_WASM_PATH=OUTPUT pnpm --dir packages/confidential-browser build`. Host `dist/loader` on an independent HTTPS origin. `_headers` supplies isolation/CSP headers on supporting hosts; the release-owned `coi.js` enables isolation on static hosts such as GitHub Pages. The build refuses unresolved native crypto imports. The service image contains `dist/ui` and the native encryption/policy tools; the loader carries no replacement UI.

The independent loader origin, browser, approved guest image and preparation software are trusted. Owner signing and wrapping keys are non-extractable WebCrypto keys; local state and exported backups are encrypted. The preparation service handles plaintext images and registry credentials in guest tmpfs and erases them after publication. Kubernetes holds temporary claim authority and public owner metadata, never decryption keys.

Administrators can deny service or claim first; the real owner then stops before uploading their image. An enrolled instance key cannot silently change. An older backup missing the final pin cannot enroll a replacement automatically. Global singleton enforcement, disk rollback prevention and automatic Trustee replacement custody remain outside scope.

The [SEV-SNP hardware qualification](qualification/sev-snp-browser-2026-10-27.json) records the tested software, measurements, fresh and returning browser flows, encrypted storage, application isolation and preserved resources. Its fixture was an owner-controlled registry image pinned by digest.
