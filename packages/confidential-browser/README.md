# Confidential browser

The browser interface can be served from a measured SEV-SNP guest through TNG. No client installation, browser extension or settings upload is required. The user authenticates the first page by independently checking the browser's actual TLS certificate and attestation.

## User

1. Open the endpoint supplied by DevOps. Its self-signed certificate may produce a browser warning; accepting that warning alone does not verify attestation.
2. Export the certificate through the browser's own certificate viewer. Independently verify its AMD evidence, approved VM/native workload-policy measurements and binding to the certificate's public key. Obtain those expected measurements from an independently trusted release or review. Checking another connection to the same address alone is insufficient.
3. Confirm that independent check in the page. Enter the separately supplied one-time access token and an owner/recovery password of at least 12 characters. The page's certificate checker is available for convenience; it cannot authenticate its own initial JavaScript.
4. Choose a local `linux/amd64` image archive, up to 256 MiB, or an owner-controlled registry image pinned by digest. Enter registry push credentials, supply any requested existing disk key, and select **Encrypt & deploy**. Keep the latest encrypted recovery backup and its password.

TNG WASM verifies the preparation VM and its enrolled transport key before sending the image or credentials. That VM encrypts and publishes the image and independently runs native CoCo genpolicy. Kubernetes starts the final workload when its reserved tag becomes available. The browser then verifies that workload, enrolls its unique transport key, claims its unmodified Trustee and provisions keys directly to it. Disk keys never go to the preparation service. No external bootstrap Trustee is used.

Returning users repeat the certificate check, then unlock their password-encrypted browser vault or restore the latest encrypted recovery file. This mode stores no usable signing or wrapping keys in browser storage. **Verify again & check status**, **Check key and policy isolation**, and the downloadable verification record show the final enrollment, attestation and access-control results. An old recovery file without the final instance pin cannot silently enroll a replacement.

## Administrator

Use `ConfidentialOperator`, `ConfidentialStorage` and `ConfidentialWorkload` for the generic workload, a `ConfidentialBrowser` preparation VM, and a separate diskless `ConfidentialBrowser` frontend:

```ts
new ConfidentialBrowser(chart, "browser-ui", {
  name: "browser-ui", namespace, image: frontendImage, tngImage: http1TngImage,
  nodeSelector, network,
  manualTls: {
    preparationEndpoint: "https://preparation.example.org/",
    stackEndpoint: "https://stack.example.org/",
  },
});
```

Pin the images and generate native policy during synthesis. The frontend image contains the reviewed browser assets and approved preparation profiles. Forward public TCP directly to its TNG service on port 10443; TLS must terminate inside the guest. This first-page path needs no ACME, DNS-custodian key or administrator-controlled CA. Do not put TLS private keys in Kubernetes.

Configure the workload with `browserOwner: true` and `accessLink.browser.manualTls: true`. Set `loaderUrl` to the frontend's dedicated HTTPS origin, `invitationEndpoint` to the preparation's internal `/invitation` service on port 8089, and `workloadEndpoint`/`ownerEndpoint` to its preparation/final OHTTP endpoints. Allow only its named access Secret in the operator.

The preparation VM generates the disposable token in guest memory. The operator stores the frontend endpoint in Secret `url` and the credential separately in Secret `token`. Give them to the user separately. Neither the URL nor its fragment may contain a usable token. After ownership is claimed, owner signatures authenticate subsequent operations. Never publish the invitation port or guest-loopback services.

Ordinary proxies may carry the preparation/final OHTTP endpoints: their contents remain encrypted to the separately attested VM. Their DNS/HTTPS authority does not authenticate the initial page. The generic [full-stack example](../nebula/example/confidential-workload-stack.ts) includes a TCP route for the frontend; the DevOps testcase uses the existing SNP host and preserves earlier guests and disks.

## Build and limits

Build the pinned SNP SDK with `sh tools/tng-browser/build.sh NEW_SOURCE OUTPUT`, then run `TNG_WASM_PATH=OUTPUT pnpm --dir packages/confidential-browser build`. Build `docker/confidential-browser/Dockerfile.tls` with the resulting public `dist/loader` directory as its `browser-assets` build context. The frontend has no owner credentials, persistent disk, Kubernetes credential or certificate-enrollment API. Its private TLS key stays in TNG memory. Recheck renewed certificates and changed guest keys.

The independent user check, browser and approved guest software are trusted. The served checker and server-reported fingerprints are conveniences, not independent authorities. Administrators can deny service or claim first; a legitimate owner must stop before uploading secrets to an already claimed stack. Instance substitution is rejected after enrollment. Global singleton enforcement, disk rollback protection and automatic Trustee replacement custody remain outside scope.

Earlier independently hosted loader releases remain compatible with retained testcases. Their browser qualification is recorded in [the existing report](qualification/sev-snp-browser-2026-10-27.json); it does not qualify the new manual TLS frontend.
