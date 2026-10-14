# Kyverno

`Kyverno` renders the upstream Helm chart **3.9.1**, running Kyverno **v1.19.1**.
It follows Nebula's `HelmModule` conventions: a namespace, a pinned chart, and
deep-merged caller values. Import from `nebula-cdk8s`.

```typescript
import { Kyverno, namespaceRoleBindingPolicy } from "nebula-cdk8s";

new Kyverno(chart, "policy-engine", {
  namespace: "policy-system",
  roleBindingClusterRoles: ["edit"],
  policies: [namespaceRoleBindingPolicy({
    name: "developer-workload-access",
    matchLabels: { "example.com/namespace-class": "workload" },
    bindingName: "kyverno-workload-developers",
    clusterRoleName: "edit",
    subjects: [{ kind: "Group", name: "example-developers" }],
  })],
});
```

The labels, identities, role and binding name above are illustrative. The caller
owns them. The role must already exist. Use a dedicated ClusterRole when the
built-in `edit` role is broader than the intended developer access.

## Installation and configuration

| Option | Default / purpose |
| --- | --- |
| `namespace` | `kyverno`; created by the construct. |
| `releaseName` | `kyverno`; upstream chart naming conventions apply. |
| `version` | Exact chart version `3.9.1`; override for a qualified upgrade. |
| `repository` | `https://kyverno.github.io/kyverno/`. |
| `roleBindingClusterRoles` | Empty; explicitly authorize RoleBinding generation for named ClusterRoles. |
| `backgroundControllerExtraRules` | Empty; additional Kubernetes RBAC rules for other generation targets. |
| `policies` | Empty; native ClusterPolicy configurations. |
| `values` | Extra upstream Helm values, deep-merged last. Arrays follow `deepmerge-ts` semantics. |

Admission and background controllers run with one replica each. Upstream chart
resource requests/limits and security settings apply. Use `values` to qualify
placement, resources and high availability for the target cluster. Reporting,
reports-server, cleanup-controller, Grafana, and automatic Kubernetes
ValidatingAdmissionPolicy generation are disabled by default. The background
controller handles synchronization and grant removal without cleanup-controller.
Enable reporting flags together with the reporting controller, or cleanup
services, explicitly if other policies need them.

The module replaces the upstream background controller's default generation
write permissions with explicit opt-ins. Its standard discovery/read and
controller-internal permissions remain. For example, a ConfigMap generation
policy can request its lifecycle verbs via `backgroundControllerExtraRules`.
Context API calls or custom admission policies may also need additional admission
controller RBAC via `values.admissionController.rbac.clusterRole.extraResources`.
Advanced Helm overrides can change these defaults and require their own review.

CRDs carry Helm `keep` and Argo CD `Prune=false,Delete=false` annotations. No
existing application retention settings, namespace labels, role definitions or
bindings are modified by this module. It is not added to `Platform` or any
deployment preset. Synthesizing the example creates files only:

```sh
cd packages/nebula
pnpm exec cdk8s synth --app 'tsx example/kyverno.ts'
```

No cloud resources, load balancers, autoscaling or paid services are requested.
Controller pods still consume cluster capacity. Before adopting or increasing
replicas, obtain an approved resource/cost estimate and budget in the deployment
repository; do not enable extra capacity automatically.

## Namespace access lifecycle

`namespaceRoleBindingPolicy` returns a normal `KyvernoClusterPolicyConfig`:

* A new Namespace with **all** classification labels receives the named
  RoleBinding in that Namespace, granting only the configured subjects the
  configured ClusterRole's namespaced permissions.
* `generateExisting: true` backfills matching Namespaces when the policy is
  created or updated. This is generation for existing triggers, not a periodic
  scan of every resource by the reporting controller.
* `synchronize: true` reconciles edits/deletion of generated grants and removes
  a generated grant after its Namespace's classification labels stop matching.
  Classification is deliberately in `match.resources.selector`, not in
  preconditions, and the match does not restrict admission operations to CREATE.
* `orphanDownstreamOnPolicyDelete: true` preserves generated grants if the policy
  or rule is removed. Revocation on namespace reclassification requires the
  policy and Kyverno to remain installed. Plan explicit access retirement before
  uninstalling them. Namespace deletion naturally removes its bindings.

Only grant-management resources owned by this policy participate in that
lifecycle. Choose a **new binding name** and verify there are no existing
bindings with that name in matching Namespaces before enabling the policy.
Kyverno can reconcile an existing resource at its target name; this helper does
not implement adoption or collision detection. Keep existing/manual grants and
their retention settings under their existing owner, and migrate them separately.
Overlapping policies must use distinct binding names. Kubernetes `roleRef` is
immutable: changing `clusterRoleName` on an existing binding requires an explicit
replacement/migration plan. Orphaned grants also need explicit ownership planning
before reintroducing the same policy or binding names.

Kubernetes RBAC grants add together: deleting a generated binding does not revoke
access supplied by some other binding. Protect classification-label writes and
policy writes from the developers whose access they govern. A selector is a
policy boundary, not an RBAC limitation on the controller's credentials.

### Required controller permissions

For `roleBindingClusterRoles: ["edit"]`, the module adds background-controller
permissions to get/list/watch/create/update/patch/delete RoleBindings and to
**bind only the named `edit` ClusterRole** (`resourceNames: ["edit"]`). The chart
aggregates these rules and binds its background ServiceAccount, including under
a custom release/namespace. There is no `cluster-admin` grant, wildcard `bind`,
`escalate`, or ClusterRoleBinding creation permission added by this option.
Kubernetes permits binding a role when the caller has the explicit `bind` verb;
granting the controller all of that role's workload permissions is unnecessary.
See [Kubernetes RBAC binding restrictions](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#restrictions-on-role-binding-creation-or-update).

These controller credentials operate across namespaces. Constrain policy and
classification editing accordingly. The identity applying the installation must
itself be permitted to grant these RBAC permissions.

## Other declarative policies and GitOps ordering

Pass any native `kyverno.io/v1` ClusterPolicy spec through `policies`, or use
`new KyvernoClusterPolicy(chart, id, { name, spec, labels, annotations })` in a
separate policy application. Generate, validate, mutate, exclusions, context and
other upstream fields pass through without a Nebula-specific DSL. No policy is
enabled implicitly. Native spec typing is intentionally open; qualify specs
against the pinned Kyverno schema/engine.

Policies default to Argo CD sync wave `1` and allow annotation overrides. Install
the namespace, CRDs, controller RBAC and controllers before policies. In one Argo
application the namespace is in wave `-1` and controller deployments/CRDs are in
wave `0`. For separate applications,
wait for Kyverno's CRDs and admission/background deployments to be ready before
syncing policies; waves in different applications do not establish readiness.
Backfill also requires aggregated RBAC to have converged. Review Kyverno
UpdateRequests/controller logs when a generated grant fails.

Upstream details: [generate synchronization, backfill and binding permissions](https://kyverno.io/docs/policy-types/cluster-policy/generate/)
and [chart configuration](https://github.com/kyverno/kyverno/tree/v1.19.1/charts/kyverno).

## Validation

`pnpm test` covers installation arguments and merging, exports, raw policy
preservation, opt-in RBAC, subjects, classification matching fields, existing
namespace generation and retention settings. CI also downloads checksum-verified
chart/CLI fixtures and runs the real Helm renderer and Kyverno v1.19.1 engine.
Run those tiers locally with:

```sh
KYVERNO_CHART_ARCHIVE=/path/to/kyverno-3.9.1.tgz \
KYVERNO_CLI=/path/to/kyverno \
pnpm exec tsx --test test/kyverno.test.ts
```

The chart test checks CRD retention, controller selection, aggregated RBAC and
ServiceAccount wiring. The CLI evaluates matching new/existing and nonmatching
Namespaces and asserts the generated grants. These are offline tests; they do
not exercise asynchronous controller deletion, webhook readiness or Kubernetes
RBAC enforcement on a running cluster. Before production adoption, qualify in a
disposable cluster: create an unrelated retained binding and a matching existing
Namespace; install Kyverno and the policy; confirm backfill; create another
matching Namespace; confirm generation; edit/delete its generated binding and
confirm repair; remove/change its classification and confirm only the generated
binding disappears; delete the policy and confirm remaining grants are retained.
