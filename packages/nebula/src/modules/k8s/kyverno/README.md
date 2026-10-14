# Kyverno

`Kyverno` installs the pinned upstream Helm chart **3.9.1** (Kyverno **v1.19.1**).
Policies belong to the deployment repository and use native Kyverno manifests.
Add policies whenever needed without changing Nebula or adding policy-specific
options to the installation module.

```typescript
import { Kyverno } from "nebula-cdk8s";
import { requirePodTeamLabel, defaultPodLabels } from "./policies";

const kyverno = new Kyverno(chart, "policy-engine", {
  policies: [requirePodTeamLabel],
});
kyverno.addPolicy("default-pod-labels", defaultPodLabels);
```

Both `policies` and `addPolicy(id, manifest)` accept `KyvernoPolicyConfig`:

```typescript
{
  apiVersion: "kyverno.io/v1",
  kind: "ClusterPolicy",
  metadata: { name: "require-team" },
  spec: {
    validationFailureAction: "Enforce",
    rules: [{
      name: "require-team",
      match: { any: [{ resources: { kinds: ["Pod"] } }] },
      validate: {
        message: "Pods must declare a team label",
        pattern: { metadata: { labels: { team: "?*" } } },
      },
    }],
  },
}
```

The module passes through `apiVersion`, `kind`, metadata and the complete spec.
There is no kind allowlist or mandatory `spec.rules`: cluster and namespaced
policies, CEL policies, cleanup policies and exceptions use the same API. The
installed Kyverno version must support each supplied CRD and spec. Nebula does
not infer policy scope, rewrite rules or enable a service based on a policy.
Set `metadata.namespace` explicitly for namespaced resources.

## Load policies from files or declare them independently

Keep policies in TypeScript modules, import JSON, or load standard multi-document
YAML with cdk8s. Compose them before `app.synth()`:

```typescript
import { Yaml, type Chart } from "cdk8s";
import { KyvernoPolicy, type KyvernoPolicyConfig } from "nebula-cdk8s";

Yaml.load("policies/security.yaml").forEach((manifest, index) => {
  kyverno.addPolicy(`security-${index}`, manifest as KyvernoPolicyConfig);
});

// A separate policy application can use an existing Kyverno installation.
new KyvernoPolicy(policyChart, "team-policy", {
  apiVersion: "kyverno.io/v1",
  kind: "Policy",
  metadata: { name: "team-policy", namespace: "example-team" },
  spec: teamPolicySpec,
});
```

`addPolicy()` returns the created `KyvernoPolicy` resource. `kyverno.policies`
includes both constructor-supplied and subsequently added resources. This API
composes manifests; GitOps applies additions and updates after synthesis.

## Installation and permissions

| Option | Default / purpose |
| --- | --- |
| `namespace` | `kyverno`; created in Argo CD wave `-1`. |
| `releaseName` | `kyverno`; upstream naming conventions apply. |
| `version` | Exact chart version `3.9.1`; configurable for qualified upgrades. |
| `repository` | `https://kyverno.github.io/kyverno/`. |
| `policies` | Empty; any native policy manifests. |
| `controllerExtraRules` | Empty; native RBAC rule arrays keyed by `admission`, `background`, `cleanup`, or `reports`. |
| `values` | Upstream Helm values, deep-merged last using `deepmerge-ts` array semantics. |

Controller permissions are independent of policy content. Supply only the
permissions your policies need, including context reads, generation targets or
cleanup targets. For example:

```typescript
new Kyverno(chart, "policy-engine", {
  controllerExtraRules: {
    background: [{
      apiGroups: [""],
      resources: ["configmaps"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
    }],
    admission: [{ apiGroups: [""], resources: ["configmaps"], verbs: ["get"] }],
  },
});
```

Rules reach the selected controller's chart-managed aggregated ClusterRole and
ServiceAccount binding. The upstream background controller's broad generation
writes are replaced by explicit rules; its standard discovery/read and internal
permissions remain. Native Helm RBAC overrides remain available through `values`.
Rules alone do not enable an optional controller.

Admission and background controllers default to one replica each, with upstream
resource requests/limits and security settings. Reporting flags, reports-server,
cleanup-controller, Grafana and automatic Kubernetes ValidatingAdmissionPolicy
generation are disabled by default. Enable the needed controllers/features via
`values` for policies that require them, such as cleanup policies. Qualify native
specs against the pinned Kyverno schema/engine. No policies are enabled implicitly.

CRDs, including the separately configured API dependency, retain Helm `keep` and
Argo CD `Prune=false,Delete=false` annotations. Policy resources default to Argo
wave `1`, overridable through their annotations; controller resources use wave
`0`. Separate applications must wait for Kyverno's CRDs, controllers and
aggregated RBAC to be ready before syncing policies. Waves across applications
do not establish readiness.

## Examples

[kyverno.ts](../../../../example/kyverno.ts) composes three ordinary policies from
[kyverno-policies.ts](../../../../example/kyverno-policies.ts): pod-label validation,
label mutation, and namespace access generation. These are deployment examples;
none is embedded in the module API. Render them without deploying:

```sh
cd packages/nebula
pnpm exec cdk8s synth --app 'tsx example/kyverno.ts'
```

The namespace example selects `example.com/namespace-class=workload`, generates a
new developer RoleBinding, backfills existing matches with `generateExisting`,
and reconciles the grant with `synchronize`. Classification is in `match`, so
removing/changing that label removes the generated grant. The example preserves
grants if the policy is removed (`orphanDownstreamOnPolicyDelete: true`). This
retention choice belongs to that example; the generic module imposes no policy
lifecycle defaults. Revocation requires the policy/controller to remain active.

Its caller-supplied RBAC allows RoleBinding lifecycle verbs and `bind` on only the
named `edit` ClusterRole. Explicit `bind` satisfies Kubernetes escalation checks
without giving the controller all of `edit`'s workload permissions. Protect
policy and classification-label editing; controller credentials operate across
namespaces. See [Kubernetes binding restrictions](https://kubernetes.io/docs/reference/access-authn-authz/rbac/#restrictions-on-role-binding-creation-or-update)
and [Kyverno generation behavior](https://kyverno.io/docs/policy-types/cluster-policy/generate/).

Use a new binding name and check for existing targets before enabling generation:
Kyverno can reconcile an existing object with the same name. Keep existing/manual
grants and their retention settings under their existing owner. Changing a
RoleBinding's immutable `roleRef` needs an explicit migration. Access from other
bindings remains additive. Qualify backfill, repair, reclassification revocation,
policy-removal retention and preservation of unrelated bindings in a disposable
cluster before production adoption.

The module is opt-in and is not added to deployment presets. It requests no cloud
resources, load balancers or autoscaling. Pods still consume cluster capacity;
obtain an approved estimate/budget before deployment or increasing capacity.

## Validation

`test/kyverno.test.ts` checks native kind/spec/metadata passthrough, namespaced
policies, future schema passthrough, TypeScript/YAML additions after construction,
standalone policies, generic controller RBAC and installation overrides. CI also
runs checksum-verified real chart rendering and Kyverno engine evaluation:

```sh
KYVERNO_CHART_ARCHIVE=/path/to/kyverno-3.9.1.tgz \
KYVERNO_CLI=/path/to/kyverno \
pnpm exec tsx --test test/kyverno.test.ts
```

These tests do not deploy to a cluster or exercise asynchronous deletion,
webhook readiness or Kubernetes RBAC enforcement.
