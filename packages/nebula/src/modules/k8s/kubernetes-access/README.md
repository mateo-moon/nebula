# Kubernetes OIDC access

Reusable authentication components composed through Nebula's `BaseConstruct`,
control-plane and `HelmModule` classes. Callers supply issuer/client metadata,
identity mappings, public endpoints, TLS trust and Kubernetes RBAC.

| Component | Responsibility |
| --- | --- |
| `KubernetesOidcIdentity` | Shared API authentication policy and human/workload kubeconfigs |
| `EnvoyJwtProxy` | JWT verification, backend TLS and original bearer forwarding |
| `KubernetesOidcGateway` | Deployment, Service, Ingress and disruption budget around the proxy |
| `K0sOidcAuthentication` | Authentication files and hosted ConfigMaps for k0s |
| `KubernetesWorkloadIdentity` | Projected token volumes, paths and client configuration |
| `KubernetesWorkloadKubeconfig` | Secret containing a token-file reference |
| `ArgoCdOidcCluster` | Argo cluster registration using that projected identity |
| `ServiceAccountTokenRotation` | Scheduled TokenRequests into explicitly named Secrets |
| `ServiceAccountTokenLifetimePolicy` | Admission limit for a selected TokenRequest caller |

See [the complete composition example](../../../../example/kubernetes-oidc.ts).

## Identity policy

`KubernetesOidcIdentityConfig` contains the cluster name, public hostname and
issuer policies. Gateway infrastructure settings belong to
`KubernetesOidcGatewayConfig` separately, so native authentication and client
profiles work without a gateway deployment.

```ts
const identity = new KubernetesOidcIdentity({
  cluster: "example",
  hostname: "api.example.test",
  workforce: {
    url: "https://issuer.example.test",
    jwksUrl: "https://issuer.example.test/keys",
    audience: "example-kubectl-client",
    emailDomain: "example.test",
    groups: ["access:developers"],
  },
});
const profile = identity.userKubeconfig();
```

The default username is verified email prefixed with `oidc:`; immutable UIDs use
`sub`. `workforce.emailDomain` optionally restricts the verified email domain.
Set `workforce.username: { claim, prefix }` for another username claim.
`workforce.groups` accepts explicit fixed groups or `{ claim, prefix }`;
by default no groups are assigned. External identities cannot become Kubernetes
`system:` users or groups. RBAC grants are supplied by the caller.

`requiredClaims` binds exact signed claim values. Provider-specific login hints
belong in `login.authRequestExtraParams`, scopes in `login.extraScopes` and the
flow in `login.grantType`. This supports standards-based providers including
Google directly; provider metadata and OAuth registrations belong to the caller.
Login hints never replace signed claim validation.

Issuer `maxTokenLifetimeSeconds` defaults to 600 and supports up to 3600 seconds.
The API checks issued lifetime; the gateway also bounds remaining lifetime.
A workload issuer accepts only the configured ServiceAccount subjects and
pod-bound tokens. Its audience is explicit; token projections inherit the same
value. The default audience is `kubernetes:<cluster>`. Projected token
`expirationSeconds` is configurable from 600 to 3600 seconds, matching the
accepted workload policy.

## Module composition

`K0smotronControlPlane`, `K0smotronCluster`, `K0sCluster` and `AwsK0sCluster`
compose `K0sOidcAuthentication` through `controlPlane.authentication`. Hosted
configuration inherits the control-plane namespace; standalone configuration
uses controller bootstrap files. Kubernetes 1.34 or later is required.
`bootstrapManifests` optionally supplies caller-owned RBAC resources through the
k0s manifest applier. The authentication module owns `authentication-config` and
`anonymous-auth`; conflicting API flags fail validation. Other API arguments,
including repeated service-account issuers, pass through unchanged.

The gateway verifies backend TLS against the supplied CA and server name,
forwards the original bearer identity, and strips caller-supplied proxy and
impersonation headers. `podLabels` controls its resource selectors;
`maxStreamDurationSeconds` controls the stream limit independently of issuer
lifetimes and defaults to 600 seconds.

`ArgoCd.workloadIdentities`, `Crossplane.kubernetesProvider.workloadIdentities`
and `ClusterAutoscaler.workloadIdentity` share the same projected-token helper.
The kubelet renews token files. Argo's exec helper rereads the file every thirty
seconds and requires GNU `date` and `cat` in its image.

For applications consuming Secret data, `ServiceAccountTokenRotation` refreshes
only the specified ServiceAccount/Secret pairs. Callers provide target Secrets,
the file-based kubeconfig, CA and RBAC. Missing targets fail the Job.
`expirationSeconds` defaults to 600; the default schedule is every two minutes.
`ServiceAccountTokenLifetimePolicy.maxTokenLifetimeSeconds` applies an
independent server-side request limit to the selected requester.

Deployment repositories own endpoint exposure, network policy, resource
lifecycle and operational sequencing. Authentication configuration describes
OIDC acceptance; Kubernetes system authentication remains a control-plane concern.

## kubectl login

`userKubeconfig()` produces a cluster-specific exec profile using
`kubectl oidc-login`, S256 PKCE and OS keyring storage. Each cluster has a separate
kubeconfig user entry, preserving its issuer/client binding when profiles merge.
Options select the executable, grant type, cache, or loopback callback for
headless clients.

For providers requiring an OAuth app credential, set
`login.clientAuthentication: "client-secret"`. The profile then uses
`nebula-oidc-login` and references `~/.config/nebula/oidc/<cluster>.json`.
`userKubeconfig({ clientCredentialFile })` selects another protected file.
See [the adapter and input schema](../../../../../../tools/oidc-login/README.md).

## Verification

From `packages/nebula`:

```sh
pnpm exec tsx --test test/kubernetes-access.test.ts
RUN_KUBERNETES_OIDC_INTEGRATION=1 pnpm exec tsx --test test/kubernetes-access.integration.test.ts
pnpm exec tsc --noEmit
```

The integration test creates disposable keys, a kind cluster and an Envoy
container, then cleans them up. It verifies profile merging, identity mappings,
issuer/client/domain denials, JWT signature and lifetime checks, gateway
certificate rejection and TokenRequest admission. It uses only its own fixtures.
