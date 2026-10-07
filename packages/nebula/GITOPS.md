# GitOps composition and adoption APIs

The cdk8s package exports reusable constructs from `nebula-cdk8s`. Deployment
repositories supply their inventory, repository paths, ownership names,
provider configuration references and credential Secret references. Observed
cloud identifiers belong in retained Crossplane state rather than copied
configuration constants.

## Repository composition

`ArgoCdAppTier` can discover cluster services and workload services under the
same existing Application tier:

```typescript
new ArgoCdAppTier(chart, "dev", {
  repoUrl: "https://git.example.test/platform.git",
  targetRevision: "main",
  pathPrefix: "infra",
  discovery: {
    mode: "cluster",
    clusterName: "dev",
    dir: resolve(repositoryRoot, "infra/clusters/dev"),
    pathDir: "clusters/dev",
    serviceDirectories: [{
      dir: resolve(repositoryRoot, "infra/workloads/dev"),
      pathDir: "workloads/dev",
    }],
  },
});
```

Each direct child directory keeps the name `<clusterName>-<module>`. Duplicate
module names across roots fail before rendering; the optional CAPI cluster
Application is discovered only in the primary directory. Omitting additional
roots preserves the previous discovery behavior. This changes source paths
without moving a workload to another Application owner.

| API | Responsibility |
| --- | --- |
| `confidentialProject(scope, id, config)` | Exact repository, destination namespace and named-user Argo access; callers can declare protected project names. |
| `applyWorkloadAppPolicy(tier)` | Retains non-pruning Applications and adds cascading finalizers to explicitly pruning workload Applications. |
| `workloadWorker(...)`, `applyClusterResourcePolicy(chart, options)` | Marks explicitly workload-owned workers, orders their deletion and preserves data/shared-resource retention. Existing owner annotation keys are configurable. |
| `isMainModule(import.meta.url)` | Lets environment entry points export settings without synthesizing when another module imports them. |
| `BaremetalFleet`, `baremetalWorker` | Composes existing named remote-machine inventory, bootstrap templates and worker deployments without changing the host identity. |
| `CiliumNodeRegistration` | Native admission for exact kubelet/node inventory and host-scope IPv6 pod CIDR annotations. |

Keep meaningful deployment settings in the deployment repository. Generic
constructs do not choose an account, host, subnet, worker allocation or public
network policy for a caller.

## Observed infrastructure and reconciliation

| API | Inputs and guardrails |
| --- | --- |
| `AwsWorkerFleet` with `observedIdentity`, `AwsWorkerLaunchTemplateSetup` | Named EIP/EBS managed resources, region/AZ and bootstrap configuration; validates retained external bindings before composing a named LaunchTemplate. See the [worker adoption contract](src/modules/infra/aws/worker-launch-template.md). |
| `AwsWorkerFleetRegion.ingressRules` | Explicit IPv4, IPv6 or security-group source policies. Omission preserves existing default ingress; an empty list removes automatic ingress. |
| `AwsClusterNatIngress`, `AwsClusterNatIngressSetup` | Observes CAPA `AWSCluster.status.networkStatus.natGatewaysIPs`; requires healthy, exact cluster observations, preserves matched rule names and revokes obsolete sources only after a valid observation. See [NAT adoption and rotation](src/modules/infra/aws/cluster-nat-ingress/README.md). |
| `AwsImageRegistry`, `AwsServiceAccountRegistryIdentity` | Reusable repositories, scoped IAM/OIDC identity, credential refresh/distribution and mirroring, with explicit deployment settings. See [registry configuration](src/modules/infra/aws/image-registry/README.md). |
| `AwsKubernetesOidcPublication`, `AwsKubernetesOidcPublicationSetup` | Reads the selected kubeconfig context through provider-kubernetes, fetches JWKS with verified TLS through provider-http and reconciles retained S3 discovery/JWKS objects. Bucket versioning is preserved by default; enabling retained versions requires explicit configuration. Invalid observations preserve prior published resources. See [publication and rotation](src/modules/infra/aws/kubernetes-oidc-publication/README.md). |
| `GiteaBranchProtection` | Secret-referenced credentials and explicit policy fields; observes/creates/updates an exact repository branch rule without deleting external protection. See [repository policy reconciliation](src/modules/infra/gitea/README.md). |
| `AwsDlm` | Optional managed-resource name, role binding/description and tags let an existing backup policy retain its identities while adopting the typed API. |
| `Cilium.nodeIpv6Overrides` | Existing named CiliumNodeConfigs with exact hostname/address inventory, native deny admission and only the `ipv6-node` override key. See [Cilium prerequisites and qualification](src/modules/k8s/cilium/README.md#retained-nodes-with-an-inventory-ipv6-address). |

## Staged adoption

Separate a repository layout move from an infrastructure behavior change. First
compare complete renders using the same renderer image, chart versions, values
and capabilities. Preserve Application owners, managed-resource names and
runtime-facing identities while moving paths.

Before transferring direct resources into a composition, commit their retention
policies and resource-scoped Argo ignores for provider-owned external bindings,
install the XRD/Composition and observer permissions, and verify reconciliation.
Then follow the resource's documented ownership handoff. A composed object with
the same name is not enough evidence of adoption: verify controller ownership,
external binding, readiness and Argo tracking before allowing cleanup. Cloud
resources with critical data stay retained throughout. This is a sequence of
reviewed GitOps changes, not a manual patch procedure.

Worker bootstrap changes may create a new LaunchTemplate version. The existing
ASG identity and instance-refresh behavior must be checked separately. A layout
move must not implicitly roll instances. Likewise, enabling new Cilium config
checksums deliberately rolls agents and needs the networking checks documented
in its migration guide.

Named observation does not discover a lost external resource by tags. After
complete management-state loss, recovery requires a verified backup containing
the retained managed-resource external bindings, ownership graph and required
credentials. EBS snapshots alone are insufficient. Missing bindings fail
closed; never set `createFresh` to recover an existing disk. A tag-based importer
with exact account/region/AZ and unique-match checks is not implemented here.

Package version `1.1.0` distinguishes these additive APIs from older `1.0.0`
Git aliases during a staged upgrade. Use reviewed immutable Git pins and a
lockfile; consolidate aliases only after reviewing upstream networking/bootstrap
changes as well as the new APIs. This version change does not publish a package.

See [module validation](test/README.md) for runnable test tiers and prerequisites.
