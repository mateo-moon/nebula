# TNG and Trustee

The self-sufficient deployment is now the main [`Trustee` module](README.md).
`TngTrustee` is a compatibility alias for the same construct. Both use the
official Helm chart with extensions and native genpolicy during synthesis;
there is no separate prepare/bind workflow or external bootstrap Trustee.

TNG runs as a sidecar in the same SNP PodVM as unmodified KBS with built-in
AS/RVPS. It binds CoCo attestation-agent evidence to TLS. The owner uses
[`@nebula/trustee-client`](../../../../../trustee-client/README.md), passing the
construct's generated `identity` directly to `prepareClient`.

The deployed TNG image supports `coco_asr` without modification. The native
client now builds an unmodified upstream revision containing
[merged TNG PR #263](https://github.com/inclavare-containers/TNG/pull/263), including
explicit verifier trust roots and standard Base64 JWT certificate decoding.
Build/installation tooling is separate under
[`tools/tng-client`](../../../../../../tools/tng-client/README.md).
