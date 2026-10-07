# AWS immutable PodVM and Trustee passport prototype

Status: isolated research/prototype. Separately authorized disposable AWS experiments are recorded in [HARDWARE_QUALIFICATION.md](HARDWARE_QUALIFICATION.md); no live cluster was changed. Registration of the prototype RuntimeClass is not deployment qualification. Neither a production appliance nor a real NitroTPM attestation document has been qualified.

The required module contract is now [self-contained installation and lifecycle](SELF_CONTAINED.md), including protection from **management-cluster administrators**. That document and the [architecture research](RESEARCH.md) supersede the caller-operated build/review/service setup below as the deployment design. The research proposes generic images, measured signed initdata and an explicit AWS-Nitro trust profile; the current prototype still uses per-workload images and its existing qualification gates. These protocols and staging tools remain research components until the module owns the complete lifecycle; running them manually is not an acceptable installation requirement.

## Ownership and pinned inputs

Runtime configuration and these assets belong to `packages/nebula/src/modules/k8s/confidential-containers`. The opt-in `awsNitroTpm` route adds `RuntimeClasses.AWS_NITRO_TPM` with the actual `kata-remote` handler, alongside local SNP/TDX classes. The verifier, policies and guest bootstrap accept arbitrary workload IDs and resource scopes. Synthetic tests cannot approve deployment.

| Component | Revision / contract |
| --- | --- |
| Trustee KBS | `3b7c99069a7c89ea51713dcf7cf98c16dbe2d3db`; stock passport, no default attestation verifiers needed |
| guest-components | `17ad60d88f9b7e4b3b54d01200985ae72723e8ab`; stock `kbs_protocol` passport client and `offline_fs_kbc` |
| cloud-api-adaptor | v0.23.0, `e3e0f00480b41c08e3e4dbc6b64aba7722fb65f9`; existing Nebula module installs runtime |
| NitroTPM-Tools | `441fe310cce206efc79d88287fa2ee00355f5ce3`; PCR compute 1.1.2 includes PCR12 advisory fix |
| Nebula | reusable `ConfidentialContainers.awsNitroTpm` option; asset sources ship with the package |

Python cryptographic libraries are pinned in `requirements.txt`; dependency resolution is recorded separately. The Rust guest uses the exact guest-components revision, its stock RSA-OAEP-256 JWE handling, and Cargo.lock. No custom signature, X.509 path-validation, JWT or JWE algorithms.

## Protocol

1. The guest reads only `/usr/share/nebula/bootstrap.json`, embedded in the authenticated read-only root. It generates an RSA recipient key inside the guest, obtains a server challenge for its fixed workload and DER SubjectPublicKeyInfo key, and passes the nonce and that key to stock `nitro-tpm-attest`.
2. `POST /v1/challenge` accepts `{workload, public_key}` (standard base64 DER). Server stores a random 32-byte nonce, SHA256 of the DER key, workload, expiry and consumed bit. SQLite transactionally consumes it once. Restart preserves consumed state; replicas use a shared durable database in production, not independent SQLite copies. Unused challenges expire after 60 seconds. Invalid evidence cannot resurrect consumed challenges.
3. `POST /v1/passport` accepts `{challenge_id, document}` (standard base64 binary COSE_Sign1). Evidence must be at most 32 KiB, tagged or untagged COSE Sign1 ES384, have the AWS schema `nitrotpm_pcrs`, SHA384, valid certificate chain at verification time, correct signature, timestamp within 60 seconds, matching 32-byte nonce and identical DER recipient key. All approved PCRs must match exactly, including PCR4 and PCR12; do not permit PCR7-only broad approvals. User data is never an authorization claim.
4. Issuer emits an ES256 JWT valid for 60 seconds. Evidence remains ES384; the pinned KBS only endorses P256 EC signing keys through its `x5c` interface. Header `jwk` includes `alg=ES256`, issuer public key and DER `x5c` signing chain. Body includes `iss`, `aud`, `iat`, `nbf`, `exp`, `jti`, generic `tee-pubkey` with Trustee RSA JWK fields `kty`, `alg`, `n`, `e`, and `aws` verified claims (workload, profile ID, policy digest, allowed resource paths, module ID, measurements). Identity and resource authority come from the approved profile; a request cannot add resources or policy. Different workloads must have distinct PCR4/PCR12 identities so one approved boot cannot select another workload's resources.
5. Stock KBS verifies that chain against an explicitly provisioned issuer CA with `insecure_header_jwk=false`. Stock KBS disables audience validation, so its resource Rego must require the exact issuer and audience, evidence type, workload/profile/policy digest and requested resource path. `kbs_launcher.py` refuses startup without the exact preseeded restrictive policy; stock KBS's default policy otherwise permits non-sample claims broadly. Resources return only through encrypted stock JWE. The guest uses stock `kbs_protocol` to decrypt.
6. Guest atomically writes `{ "default/image_key/<name>": "<base64 bytes>" }` to `/run/nebula/secrets/resources.json`, mode 0600, on a dedicated nonswappable tmpfs. CDH receives the immutable `OFFLINE_FS_KBC_EXTRA_FILE_PATH` and offline KBC config. No guest key is ever written to disk. Kata/CDH/forwarder startup requires successful provisioning. Failure removes partial files and leaves services stopped; reboot creates new recipient keys and challenges.

## Trust and threat model

The production verifier accepts only the commercial AWS Nitro root SHA256 fingerprint `641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b`. AWS explicitly documents this root for NitroTPM; its filename refers to Nitro Enclaves but its usage here is backed by the NitroTPM documentation. Roots from the evidence are untrusted chain material. Test roots must exist only in test subclasses/fixtures, with no runtime insecure option.

Trust includes AWS Nitro hypervisor/PKI, measured guest kernel/initramfs/rootfs, Kata policy implementation, guest bootstrap, pinned endpoint TLS trust, verifier configuration and signer, KBS policy/storage and image publishers. NitroTPM is AWS-rooted measured boot; **it does not prove SEV-SNP is enabled or replace an AMD-rooted SNP report**. The current SNP requirement remains a deployment blocker until supported joint verification binds fresh SNP evidence to this same boot identity, key and challenge. CPU options in a launch template are not proof. No code may label NitroTPM alone as SNP/CVM qualification.

Host/Kubernetes/cloud account operators may change AMI selection, boot parameters, EBS contents, user data, init data, annotations, mounts, network routing, VM launch settings, snapshots and replayed traffic. These must not grant keys. Operators can deny service. Measured boot proves an initial approved state, not the absence of later kernel/Kata/application vulnerabilities. Approved guest copies may obtain the same workload key. AWS [documents the instance ID in the NitroTPM module ID](https://docs.aws.amazon.com/kms/latest/developerguide/ct-nitro-tpm.html); that is an identity primitive, not workload/account authorization, and this prototype does not use it for replica membership. Do not treat unverified module ID parsing, AMI tags, caller-supplied user data or controller assertions as attested tenancy/replica authorization. Different per-replica keys require distinct approved profiles or a separately authenticated in-guest assignment protocol.

## Guest build and policy boundary

Start from AWS's AL2023 KIWI attestable image sample, pinned to a reviewed commit. Install CoCo/Kata binaries from reviewed build outputs (record source revision and SHA256), compiled with `AGENT_POLICY=yes` and embedded default policy. Include bootstrap, endpoint trust and generated policy in the dm-verity protected root. UKI embeds kernel, initrd and verity root hash. Build-time `nitro-tpm-pcr-compute` generates SHA384 PCR4/12 (PCR7 additionally if used). Approved profiles are promoted by the image reviewer, outside CAA/controller credentials. Policy digest is metadata attached to that reviewed image manifest, not a separately attested arbitrary guest claim.

Disable cloud-init, SSH, SSM, serial/debug shells, gettys, persistent journal, swap, hibernation and crash/core dumps. Secrets and decrypted layers must never use EBS scratch or a writable root overlay. Stock CAA scratch-storage and Kata guest-pull paths need inspection and replacement with bounded guest tmpfs before snapshot confidentiality can be claimed. Tmpfs alone is insufficient if swap remains enabled.

Stock `process-user-data` provisions mutable `/run/peerpod/policy.rego`, CDH config and init-data. The staged replacement, `aws-trustee-bootstrap --transport`, accepts only the pinned CAA network/forwarder TLS envelope and rejects code, policy, init-data, registry credentials and extra files. It requires IMDSv2 with no proxy/redirect/fallback, restricts APF to TLS 1.3, and writes only a private tmpfs configuration. This has local tests but no real-boot qualification. Fixed Kata configuration must select the embedded policy, reject `SetPolicy`, `ExecProcess`, streams/logs, diagnostics and unsafe `CopyFile`; remove kernel-argument policy overrides. Do not mask user data processing indiscriminately and claim CAA works: its transport provisioning is required and is an outstanding integration proof.

Generate the workload's exact Kata policy with pinned genpolicy from the application's exact Pod specification. Bake the policy into the guest image, strip runtime policy/init-data annotations for this route only, and deny extra containers/commands/env/mounts, debug and attach. Use a bounded runtime metadata CopyFile policy after validating it against remote Kata. CAA and cleanup lifecycle stay stock. HTTP workload APIs need measured authorization (e.g. embedded TLS client trust); security groups/Kubernetes RBAC alone do not protect against the account operator. No permissive sample policy is shipped here.

## Deployment and validation gates

Dedicated workload cluster/account/network, private PodVMs, no SSH key/SSM/IAM guest profile, immutable AMI, UEFI+NitroTPM enabled, encrypted/delete-on-termination EBS for the public image only, deny hibernation/snapshots as defense in depth. Separate CAA/cleanup roles, finite PodVM limits, TLS transport and intended workload callers. Verifier and KBS are independent trust services unavailable to workload operators; isolate signing and resource administration. TLS is mandatory for verifier/KBS, independent of token issuer trust. Rate limits and durable transactional nonce store are required before exposing the verifier.

Local proof checks actual stock KBS JWT trust, authorization and JWE delivery, stock client decryption and actual offline KBC consumption using **synthetic** Nitro-format evidence. Negative tests cover PCR4/PCR12/policy changes, nonce/key substitution, signatures/chain validity, freshness/replay, wrong workload/resource, issuer/audience, and refusal to provision outside tmpfs. Real AWS evidence, immutable root/UKI tampering, runtime policy overrides, deny exec/log/debug, real CAA lifecycle, guest network authorization, SNP joint proof, multiple actual replicas, reboot and disk/snapshot inspection remain qualification gates. Failure to obtain these proofs blocks deployment; synthetic fixtures cannot satisfy them.

No operating cost estimate is offered without instance/region/storage/load and service deployment choices. The prototype introduces a per-approved-image rollout, image-review service, verifier signer/nonce database and KBS availability dependency.

## Sources

- [AWS NitroTPM document validation and published PKI](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/nitrotpm-attestation-document-validate.html)
- [AWS Attestable AMIs and measurement generation](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/attestable-ami.html)
- [Kernel argument advisory](https://github.com/aws/nitrotpm-attestation-samples/security/advisories/GHSA-xrv8-2pf5-f3q7)
- [Trustee token verification](https://github.com/confidential-containers/trustee/blob/3b7c99069a7c89ea51713dcf7cf98c16dbe2d3db/kbs/docs/attestation_token_verification.md)
- [CAA default policy interface](https://github.com/confidential-containers/cloud-api-adaptor/blob/v0.23.0/src/cloud-api-adaptor/docs/policy.md)
- [Stock offline KBC](https://github.com/confidential-containers/guest-components/blob/17ad60d88f9b7e4b3b54d01200985ae72723e8ab/confidential-data-hub/kms/src/plugins/kbs/offline_fs.rs)
