# Portable Kubernetes OIDC access

These components compose Nebula's existing `BaseConstruct`, control-plane and
`HelmModule` classes. Deployment repositories supply issuer metadata, hostnames,
public CA Secret references, exact workload subjects, RBAC manifests, selectors,
and rollout decisions. There are no cloud IAM authenticators or deployment gates
inside the modules.

- `KubernetesOidcIdentity` builds the shared Kubernetes authentication policy and
  certificate-free human/workload kubeconfigs. Humans use verified email,
  immutable subject UIDs and PKCE. Every cluster has a distinct audience.
- `EnvoyJwtProxy` builds the HTTPS/JWT forwarding configuration.
  `KubernetesOidcGateway` composes it into a two-replica gateway, ClusterIP Service,
  Ingress and disruption budget using the existing ingress and TLS issuer.
- `K0sOidcAuthentication` is composed by `K0smotronControlPlane`,
  `K0smotronCluster`, `K0sCluster` and `AwsK0sCluster` through
  `controlPlane.authentication`. It creates hosted ConfigMaps or standalone
  bootstrap files and removes conflicting legacy OIDC flags. Service-account
  issuer flags remain separate and retain their existing values.
- `KubernetesWorkloadIdentity` owns projected volumes, token paths and client
  configuration. `ArgoCd.workloadIdentities`,
  `Crossplane.kubernetesProvider.workloadIdentities` and
  `ClusterAutoscaler.workloadIdentity` reuse this implementation.
- `ArgoCdOidcCluster` registers a target using its rotating token file.
  `KubernetesWorkloadKubeconfig` creates a Secret containing a file reference,
  never a copied bearer token or client private key.
- `ServiceAccountTokenRotation` obtains ten-minute tokens for explicitly named
  reader Secrets. `ServiceAccountTokenLifetimePolicy` bounds the requester's
  TokenRequests, including requests made outside the rotation job.

See [the composition example](../../../../example/kubernetes-oidc.ts).

## Preparation and isolation

Omitting the new options preserves existing module behavior. Adding authentication
alone mounts the structured authentication policy and applies the caller's RBAC;
it does not isolate the raw API, replace Argo registrations or publish client
configuration. Kubernetes 1.34 or later is required; the integration test uses
1.35. The API server repeats JWT verification after the gateway. k0s owns
`--anonymous-auth=false`; the authentication file must not also set `anonymous`.

Set `authentication.isolation` only after reviewing actual IPv4/IPv6 system
source ranges, exact gateway/control-plane selectors and trusted platform
namespaces. Hosted control planes then restrict the raw LoadBalancer and pod
API paths. Standalone controllers install a persistent nftables policy. Other
additive NetworkPolicies, ingress bypasses, host firewalls and infrastructure
routes still require independent checks.

Standalone authentication modifies controller bootstrap. On an existing cluster
that can replace controllers and requires a separate maintenance plan. Hosted
`controlPlane.storage` accepts explicit datastore settings so an authentication
rollout can retain the installed datastore image and PVC retention. These
settings are deployment bindings; the OIDC module chooses no database version.

Set `gateway.podLabels` to the existing labels when migrating an installed gateway
so its immutable selectors remain identical. The gateway mounts only the public
CA key selected by `backend.caSecret.key` and verifies an exact backend DNS SAN.
It forwards the bearer token and strips impersonation/proxy identity headers.
Every route requires JWT authentication, and streams are limited to ten minutes.

Token lifetimes default to 600 seconds. A workforce issuer can explicitly set
`maxTokenLifetimeSeconds` up to 3600; the API limits issued lifetime and the
gateway limits remaining lifetime for that issuer. Workload tokens always retain
the 600-second limit, and streams retain the ten-minute limit. Argo's exec helper rereads its
projected token every thirty seconds and requires GNU `date` and `cat` in the
selected image. Human kubeconfigs default to `kubectl oidc-login` with keyring
storage. Each cluster has its own kubeconfig user name so merged profiles retain
the correct login audience. `userKubeconfig({ command, grantType: "device-code", tokenCacheStorage,
tokenCacheDirectory })` supports trusted server clients too. Provider session
limits, MFA and public client/redirect configuration belong to the identity
provider's deployment.

## Direct Google workforce login

Google can authenticate humans directly while Kubernetes continues to issue
rotating workload tokens. No Google Cloud IAM authenticator or in-cluster
workforce issuer is needed. Supply a different Google OAuth **Desktop** client
ID for each cluster through the deployment binding:

```ts
const clientId = "example-desktop-client-id";
const emailDomain = "example.test";
const workforce: KubernetesOidcIdentityConfig["workforce"] = {
  url: "https://accounts.google.com",
  jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
  audience: clientId,
  emailDomain,
  maxTokenLifetimeSeconds: 3600,
  requiredClaims: { hd: emailDomain, azp: clientId },
  login: {
    grantType: "authcode",
    clientAuthentication: "client-secret",
    extraScopes: ["email"],
    authRequestExtraParams: { access_type: "offline", prompt: "consent", hd: emailDomain },
  },
};
```

Kubernetes validates `hd` and `azp` as exact signed claims as well as the issuer,
audience, lifetime and verified email. The `hd` request parameter is only a login
hint. The claim is required to establish managed Workspace membership. Binding
`azp` to the same client also excludes other clients in the same Google project.
The exec plugin always uses S256 PKCE and defaults to OS keyring storage.
The observed Google Desktop token endpoint requires the registered app credential,
despite optional wording in the provider guide. `clientAuthentication` selects
the shared `nebula-oidc-login` adapter, which reads a protected per-client JSON
file into memory and calls pinned int128/kubelogin in process. The kubeconfig
contains only its file reference; neither OS argv nor environment carries the
credential. The default path is `~/.config/nebula/oidc/<cluster>.json` and
`userKubeconfig({ clientCredentialFile })` can select a trusted-host path.
Missing or invalid input fails before browser consent. See the
[client tooling and file schema](../../../../../../tools/oidc-login/README.md).
Google uses `access_type=offline` rather than an
`offline_access` scope. Its user ID tokens last one hour and cannot be revoked
individually; enforce MFA and session policy in Google and remove Kubernetes
permissions when immediate authorization withdrawal is needed.

Use a browser on the trusted client for the loopback authorization-code flow.
For a trusted headless host, forward a local loopback port over SSH and generate
its profile with `userKubeconfig({ command: "/usr/local/bin/nebula-oidc-login",
skipOpenBrowser: true, redirectUrl: "http://127.0.0.1:8000/",
listenAddress: "127.0.0.1:8000" })`. Open its printed Google URL on the device
holding the matching forwarded port. A phone browser alone does not deliver a
loopback callback to the host. Select private cache storage appropriate to that
host; keep refresh tokens on the trusted client. Qualify initial login, cached
use and forced refresh against the actual Desktop registration before removing
the previous issuer. Provider-side app-credential input must also be accepted
before activation. Desktop device-code
support and deprecated out-of-band
redirects must not be assumed.

Provider references: [Google Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app),
[Google user ID tokens](https://docs.cloud.google.com/docs/authentication/token-types#user-id-tokens),
and [kubelogin authorization-code options](https://github.com/int128/kubelogin/blob/master/docs/usage.md#authorization-code-flow).

Legacy Argo certificate sync retirement requires an explicit
`retireLegacyCertificateSync` option. Its PreSync hook can delete only the named
sync object and cluster Secret. Do not enable it before the new workload access
has been independently verified. Treat retirement as a one-shot source transition:
remove the option after success and explicitly delete/verify absence of the named
hook ServiceAccount and RBAC resources with an already accepted operator identity.
Their `BeforeHookCreation` policy intentionally preserves prerequisites until the
Job runs; removing source alone does not prove that Argo pruned hook resources.
Kubernetes internal client certificates and
bootstrap identities remain necessary behind the restricted system API. Deleting
kubeconfigs or blocking a public route does not revoke stolen certificates;
client-CA trust retirement is a separate operation.

## Verification

From `packages/nebula`:

```sh
pnpm exec tsx --test test/kubernetes-access.test.ts
RUN_KUBERNETES_OIDC_INTEGRATION=1 pnpm exec tsx --test test/kubernetes-access.integration.test.ts
pnpm exec tsc --noEmit
```

The integration test needs Docker, kind and OpenSSL. It generates disposable test
keys, creates its own cluster and Envoy container, and cleans them up. It never
reads a user's kubeconfig or contacts a deployed cluster. It verifies identity
mapping, negative JWT cases, certificate rejection at the gateway, TokenRequest
lifetime admission and raw API isolation. It does not establish certificate
revocation on production endpoints.
