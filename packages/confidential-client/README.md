# Confidential client

`confidential-client` is the owner-side interface to a Nebula Confidential stack. It publishes an encrypted OCI image, independently measures the declared guest with native CoCo `genpolicy`, verifies SEV-SNP through TNG, claims the guest with the owner's public key, and provisions image and volume keys only to that verified instance. It also exposes Trustee administration and storage diagnostics.

## First deployment

DevOps installs `ConfidentialOperator`, `ConfidentialWorkload` and any `ConfidentialStorage` resources, reserves an image tag, and routes raw TCP to the operator-created `<workload-name>-owner` Service on port 8443. DevOps generates a private one-use invitation with `confidential-client invite claim-token.txt`, commits **only its printed SHA-256 hash** to `ownerClaimSha256`, and gives the token file and reviewed public declaration to the user. The user independently reviews the pinned helper images, SNP launch identity, network and storage bindings. The invitation authenticates first claim; it never authorizes later Trustee administration.

Build or load a local `linux/amd64` image whose absolute command and mount points match the declaration. Then run one command on a trusted owner machine with local Docker, registry credentials, native `genpolicy` and the qualified TNG binary:

```sh
confidential-client deploy reviewed-workload.yaml \
  --name workload --host owner.example.test --port 8443 \
  --source-image my-local-image:release \
  --claim-token ./claim-token.txt \
  --release-dir ./private-release \
  --tng /opt/tng/bin/tng
```

The client creates its own private P-256 owner key and random image/volume keys, encrypts every OCI layer to the declared Trustee key path, uploads only ciphertext, and checks the registry's exact manifest digest. The controller retries policy rendering until the publication tag exists, then creates the Pod with that **digest**, not the mutable tag. The client independently generates the policy for the published digest and compares the attested guest to its reviewed identity before submitting the invitation or any key. It then verifies that its own key controls the claimed Trustee, installs policies, provisions keys and waits for guest-local bootstrap. The output includes the verified SNP identity, instance TLS key fingerprint, immutable image digest and bootstrap status. No user Kubernetes access or manual resource creation is required.

For ECR, the client uses the local AWS profile and `--aws-profile` if needed. For another registry, provide a private skopeo auth JSON through `--registry-auth-file`. The operator needs read access to the published image so it can resolve and measure the same digest. Reserve an immutable tag at the registry; changing a tag after the guest is created cannot change the running Pod or its measured digest, but it can prevent a fresh deployment. The local Docker daemon and owner machine are part of the owner's trust boundary.

If the default local ports are busy, choose unused ports with `--local-port` and `--verifier-port` on the first deployment. Retries must use the same prepared state and port choices.

To avoid AMD certificate-service rate limits, pass a public AMD VCEK certificate
with `deploy --vcek /path/vcek.der`. Trustee uses its native offline certificate
store and still verifies the AMD signing chain and the approved guest identity.
For existing state, `renew ./new-state --state ./private-release/owner-state
--vcek /path/vcek.der` preserves the enrolled instance and workload approval while
changing the endorsement source. Use the new state for later commands; never
re-enroll to work around a certificate-service failure.

`--volume-key name=/private/existing.key` supplies a retained 32-byte disk key; the client generates a new key only for `initialization: IfEmpty`. Preserve `private-release/` securely. A replacement VM has a new TLS key and empty Trustee; it requires explicit re-enrollment and key reprovisioning. Neither the claim token nor Kubernetes metadata proves a unique global instance. An administrator who uses the invitation first can block deployment, but a client that cannot prove control with its own key releases no image or disk key.

If the declaration includes additional application resources, pass each private
file as `--resource-file repository/type/tag=/private/file`. The client refuses
to start provisioning until every declared resource has a corresponding file.

## Later operations

All connected commands use `--state ./private-release/owner-state`, `--tng /opt/tng/bin/tng`, `--owner-key ./private-release/owner.key` and `--audience <profile>`:

| Command | Purpose |
| --- | --- |
| `attest` | Verify SNP and the pinned instance again; print the approved identity. |
| `status` | Read owner-authorized bootstrap and storage status without key bytes. |
| `verify` | Verify attested TLS and owner authorization. |
| `list-resource-policies` | List installed Trustee policy IDs. |
| `put-resource`, `delete-resource` | Provision or remove an explicitly named resource. |
| `set-resource-policy`, `set-attestation-policy` | Install reviewed Trustee policy. |
| `renew <new-state>` | Renew local verifier credentials without selecting a new instance. |

Advanced commands `encrypt-publish`, `prepare-workload`, `enroll` and `configure-workload` expose individual stages for review or recovery. `owner-header` writes a short-lived native admin header to a private file. See `confidential-client --help` for options. The TypeScript API exports `deploy`, `publishImage`, `prepareWorkload`, `enrollInstance`, `TrusteeClient` and policy helpers.

The Node package ships TypeScript sources and uses a matching reviewed `nebula-cdk8s` revision. Native TNG and `genpolicy` are separate reviewed executables; the client never downloads or builds them. The [TNG workflow](../../.github/workflows/build-tng-client.yml) and [workload guide](../nebula/src/modules/k8s/confidential-workloads/README.md) describe their provenance and guest boundary.
