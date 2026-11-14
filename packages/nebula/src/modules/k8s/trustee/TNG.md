# TNG and Trustee

The self-sufficient deployment is now the main [`Trustee` module](README.md).
`TngTrustee` is a compatibility alias for the same construct. Both use the
official Helm chart with extensions and native genpolicy during synthesis;
there is no separate prepare/bind workflow or external bootstrap Trustee.

TNG runs as a sidecar in the same SNP PodVM as unmodified KBS with built-in
AS/RVPS. It binds CoCo attestation-agent evidence to TLS. The owner uses
[`@nebula/confidential-client`](../../../../../confidential-client/README.md), passing the
construct's generated `identity` directly to `prepareClient`.

The deployed TNG image supports `coco_asr` without modification. The native
client now builds an unmodified upstream revision containing
[merged TNG PR #263](https://github.com/inclavare-containers/TNG/pull/263), including
explicit verifier trust roots and standard Base64 JWT certificate decoding.
Build/installation tooling is separate under
[`tools/tng-client`](../../../../../../tools/tng-client/README.md).
# Confidential clients before encrypted image startup

`nebula-cdk8s/trustee/workload` exports `trusteeClientSidecars` and
`generateAttestedWorkloadPolicy`. The sidecars run the upstream Trustee AS and
upstream TNG inside the consuming PodVM. Supply the independently synthesized
Trustee identity and digest-pinned public bootstrap images. Point native CDH's
KBC at `http://127.0.0.1:18080`; include its `cdh.toml` and `aa.toml` in native
InitData. No external bootstrap KBS is required.

The verifier creates its signing keys in guest memory. Its control API stays on
guest loopback. TNG exposes port 18080 for the native Kubernetes startup probe;
it accepts traffic only after its local verifier is available. The encrypted
application starts after that probe. Native KBS still attests each recipient and
encrypts released resources to that recipient. Restrict network ingress to the
client port, and never expose the verifier API.

The workload policy measures every bootstrap and application image, process,
environment value and tmpfs mount. It denies administrator exec, stream access,
policy replacement, container recreation and late host configuration injection.
It accepts Kubernetes declarations, not a caller-supplied policy artifact.
Creation failures require replacing the PodVM because creation is latched.

