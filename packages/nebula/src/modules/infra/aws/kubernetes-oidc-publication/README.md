# Kubernetes OIDC publication

`AwsKubernetesOidcPublicationSetup` installs an XRD and composition once on the
management cluster. `AwsKubernetesOidcPublication` declares one self-hosted
Kubernetes issuer using explicit bucket, region, account, and kubeconfig Secret
inputs. It does not change API server flags, signing keys, or IAM trust.

The reconciliation path is:

1. Observe the child kubeconfig Secret through provider-kubernetes and select its
   current context. Extract embedded CA, client certificate, and private key into
   a native Secret in `tlsSecretNamespace`.
2. Continuously GET `/openid/v1/jwks` with provider-http using verified mTLS and
   references to that Secret. No cloud credentials or TLS private keys appear in
   the Request or S3 resources.
3. Validate a public RSA/RS256 signing JWKS, with one to eight distinct key IDs,
   canonical base64url public parameters, and 2048–8192-bit moduli. Extra fields,
   including private key parameters, are rejected.
4. Adopt the named bucket without permission to create or delete it. Explicit
   `createBucket: true` enables initial creation only; deletion stays disabled.
   Observe bucket versioning with the expected AWS account ID, then configure
   the public access block and narrowly scoped HTTPS-only discovery policy.
5. Publish `.well-known/openid-configuration` and `keys.json` as retained S3
   objects only after those prerequisites are observed healthy. Rotation updates
   the same keys, preserves the API server's overlap/removal decisions, and
   keeps the existing bucket versioning behavior.

`versioning: "preserve"` is the default. The BucketVersioning resource is
Observe-only, with no Create, Update, Delete or LateInitialize permissions and
no desired versioning configuration. Its successful expected-owner observation
is still a prerequisite for publication, whether the bucket is unversioned,
suspended or enabled. It cannot enable retained object versions or suspend an
already versioned bucket. Existing objects remain protected from deletion.
The versioning import identity is `bucket,account`, because the provider's read
path derives the expected owner from that identity. Publication also requires
the observed `expectedBucketOwner` to match. A bucket-only import cannot bypass
the account gate.

Use `versioning: "enabled"` only for an explicitly approved versioned bucket.
This mode manages Enabled and requires that observed state before publishing.
Enabling it on an unversioned bucket introduces retained versions and potential
storage charges; it is not necessary to automate an existing unversioned issuer.

Signing-key rotation must expose `[old]`, then `[old, new]` before switching the
signer, then `[new]` after the old tokens and discovery caches have expired. The
publisher mirrors the authenticated API's trusted JWKS exactly. It never extends
the lifetime of a key removed or revoked by the API server.

Missing or invalid observations leave the last valid composed documents in
place and explicitly mark a required composed resource unready. The XR reports
`status.publicationReady: false`; an error never publishes an empty key set.
Malformed kubeconfig YAML causes the function to fail without changing desired
resources. Bucket, issuer, region, account, and resource prefix are immutable on
an existing XR. The construct does not install lifecycle rules or backups.

For an existing issuer, use its existing bucket and URL with `createBucket:
false`. Initial missing observations do not create S3 documents or erase the
existing ones; the bucket is observed and the two existing object paths are
adopted once authenticated observations and the expected-owner check are healthy. Management
clusters whose AWS provider uses their own issuer must retain that bootstrapped
public bucket and existing documents so provider authentication can start before
the publisher reconciles. This construct is not a replacement for the initial
management-cluster identity bootstrap.

Requirements: provider-kubernetes with permission to observe the source Secret,
provider-http **v1.0.14 or later** with access to the derived TLS Secret,
provider-aws-s3 with the v1beta1 Bucket, BucketVersioning, BucketPublicAccessBlock,
BucketPolicy, and Object APIs, function-go-templating **v0.9.0 or later**, and
function-auto-ready. The configured AWS provider needs the corresponding S3
read/update permissions. Requests use the provider's regular reconciliation poll
interval; there is no one-shot Job or manual publishing step.

Tests execute the emitted template using Go's template engine, Sprig v3.3.0 and
yaml.v3, matching function-go-templating v0.9.0. Test dependencies are pinned in
`test/support/oidc-template/go.mod` and `go.sum`; Go 1.23+ is required.

Provider field references:

- [provider-http v1.0.14 Request CRD](https://github.com/crossplane-contrib/provider-http/blob/v1.0.14/package/crds/http.crossplane.io_requests.yaml)
- [provider-aws-s3 v2.6.2 Object schema](https://marketplace.upbound.io/providers/upbound/provider-aws-s3/v2.6.2/resources/s3.aws.upbound.io/Object/v1beta1)
- [provider-aws-s3 v2.6.2 BucketVersioning schema](https://marketplace.upbound.io/providers/upbound/provider-aws-s3/v2.6.2/resources/s3.aws.upbound.io/BucketVersioning/v1beta1): versioning configuration is required only for Create/Update policies, so Observe-only may omit it.
- [Terraform BucketVersioning read and status handling](https://github.com/hashicorp/terraform-provider-aws/blob/v5.97.0/internal/service/s3/bucket_versioning.go): successful empty status is Disabled; it is not a missing resource. Read calls GetBucketVersioning; mutation paths call PutBucketVersioning.
- [BucketVersioning import identity](https://github.com/hashicorp/terraform-provider-aws/blob/v5.97.0/website/docs/r/s3_bucket_versioning.html.markdown#import)
- [function-go-templating v0.9.0 function map](https://github.com/crossplane-contrib/function-go-templating/blob/v0.9.0/function_maps.go)
