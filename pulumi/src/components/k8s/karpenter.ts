import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import { Helpers } from "../../utils/helpers";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface KarpenterConfig {
  /** Namespace where Karpenter will be installed (default: "karpenter") */
  namespace?: string;
  /** Name of the cluster as seen by Karpenter's controller (required) */
  clusterName: pulumi.Input<string>;
  /** GCP region for the provider (required) */
  region: pulumi.Input<string>;
  /** GKE cluster endpoint URL (required) */
  clusterEndpoint: pulumi.Input<string>;
  /** Helm chart version and repo overrides */
  version?: string;
  repository?: string;
  /** Additional chart args (timeouts, transformations, etc.) */
  args?: OptionalChartArgs;
  /** KSA name for controller (default: "karpenter") */
  serviceAccountName?: string;
  /** Extra annotations for the KSA */
  serviceAccountAnnotations?: Record<string, string>;
  /** If provided, reuse this GSA email for WI instead of creating one */
  gsaEmail?: string;
  /** Extra roles for the controller GSA (in addition to sensible defaults) */
  gsaRoles?: string[];
  /** Project to grant roles in (default: current gcp project) */
  gsaRolesProjectId?: string;
  /** Add default toleration for system taint (default: true) */
  bootstrapHardening?: boolean;
  /** Declarative nodePools: key is the NodePool name, value defines pool + NodeClass */
  nodePools?: Record<string, KarpenterNodePoolDefinition>;
}

export type KarpenterRequirementOperator = 'In' | 'NotIn' | 'Exists' | 'DoesNotExist' | 'Gt' | 'Lt';

export interface KarpenterRequirement {
  key: string;
  operator: KarpenterRequirementOperator;
  values?: string[];
}

export interface KarpenterNodePoolDefinition {
  /** Optional override for the NodeClass name (defaults to `${poolName}-class`) */
  nodeClassName?: string;
  /** Provider-specific NodeClass definition; defaults to GCP GCENodeClass */
  nodeClass?: {
    /** apiVersion for NodeClass, default: karpenter.k8s.gcp/v1beta1 */
    apiVersion?: string;
    /** kind for NodeClass, default: GCENodeClass */
    kind?: string;
    metadata?: {
      annotations?: Record<string, string>;
      labels?: Record<string, string>;
    };
    /** Provider-specific spec fields */
    spec?: Record<string, unknown>;
  };
  /** Scheduling requirements for the pool */
  requirements?: KarpenterRequirement[];
  /** Labels applied to nodes via template metadata */
  labels?: Record<string, string>;
  /** Annotations applied to nodes via template metadata */
  annotations?: Record<string, string>;
  /** Node taints (Kubernetes semantics) */
  taints?: { key: string; value?: string; effect: 'NoSchedule' | 'PreferNoSchedule' | 'NoExecute' }[];
  /** Aggregate resource limits across provisioned capacity */
  limits?: { cpu?: string; memory?: string };
  /** Scheduling weight */
  weight?: number;
  /** How long to keep an empty node before termination */
  ttlSecondsAfterEmpty?: number;
  /** Disruption configuration */
  disruption?: {
    /** Consolidate after duration (e.g., '30s', '1m') */
    consolidateAfter?: string;
    /** Consolidation policy: 'Never', 'WhenEmpty', 'WhenUnderutilized' */
    consolidationPolicy?: 'Never' | 'WhenEmpty' | 'WhenUnderutilized';
    /** Expire nodes after specified duration if empty */
    expireAfter?: string;
    /** Budgets for limiting disruption */
    budgets?: Array<{
      nodes?: string;
      max?: number;
    }>;
  } | Record<string, unknown>;
}

export class Karpenter extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: KarpenterConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("karpenter", name, args, opts);

    const namespaceName = args.namespace || "karpenter";
    const serviceAccountName = args.serviceAccountName || "karpenter";

        // Create namespace - test if it can inherit provider from parent
        const namespace = new k8s.core.v1.Namespace(
          `${name}-namespace`,
          { metadata: { name: namespaceName } },
          { parent: this } // Only parent, no explicit provider - test inheritance
        );

    // DEBUG: Comment out GCP resources to test if they interfere with provider propagation
    // Resolve project for Workload Identity bindings and IAM role grants
    const gcpCfg = new pulumi.Config("gcp");
    const clusterProject = gcpCfg.require("project");

    const normalizeAccountId = (raw: string): string => {
      let s = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-");
      if (!/^[a-z]/.test(s)) s = `a-${s}`;
      if (s.length < 6) s = (s + "-aaaaaa").slice(0, 6);
      if (s.length > 30) s = `${s.slice(0, 25)}-${s.slice(-4)}`;
      return s;
    };

    // Controller GSA: create if not provided
    let gsaEmailOut: pulumi.Output<string>;
    let gsaResourceIdOut: pulumi.Output<string>;
    if (args.gsaEmail) {
      gsaEmailOut = pulumi.output(args.gsaEmail);
      gsaResourceIdOut = pulumi.interpolate`projects/${clusterProject}/serviceAccounts/${args.gsaEmail}`;
    } else {
      const accountId = normalizeAccountId(`${name}-karpenter`);
      const gsa = new gcp.serviceaccount.Account(`${name}-karpenter-gsa`, {
        accountId,
        displayName: `${name} karpenter controller`,
      }, { parent: this });
      gsaEmailOut = gsa.email;
      gsaResourceIdOut = gsa.name;
    }

    // Bind Workload Identity: allow KSA to impersonate GSA
    const wiBinding = new gcp.serviceaccount.IAMMember(`${name}-karpenter-wi`, {
      serviceAccountId: gsaResourceIdOut,
      role: "roles/iam.workloadIdentityUser",
      member: pulumi.interpolate`serviceAccount:${clusterProject}.svc.id.goog[${namespaceName}/${serviceAccountName}]`,
    }, { parent: this });

    // Grant default roles for Karpenter controller on GCP
    const baseRoles = new Set<string>([
      "roles/compute.instanceAdmin.v1",
      "roles/iam.serviceAccountUser",
      "roles/compute.networkAdmin",
      "roles/logging.logWriter",
      "roles/monitoring.metricWriter",
      "roles/serviceusage.serviceUsageConsumer",
      "roles/container.clusterAdmin",
    ]);
    (args.gsaRoles || []).forEach(r => { if (r) baseRoles.add(r); });
    const rolesProject = args.gsaRolesProjectId || clusterProject;
    Array.from(baseRoles).forEach((role, idx) => {
      new gcp.projects.IAMMember(`${name}-karpenter-gsa-role-${idx}`, {
        project: rolesProject,
        role,
        member: gsaEmailOut.apply(email => `serviceAccount:${email}`),
      }, { parent: this });
    });

    // Create the Kubernetes ServiceAccount with WI annotation
    // Test if it can inherit provider from parent
    const ksa = new k8s.core.v1.ServiceAccount("karpenter-ksa", {
      metadata: {
        name: serviceAccountName,
        namespace: namespaceName,
        annotations: {
          ...(args.serviceAccountAnnotations || {}),
          "iam.gke.io/gcp-service-account": gsaEmailOut,
        },
      },
    }, { parent: this, dependsOn: [namespace] }); // Remove explicit provider, test inheritance

    // Install provider-specific controller for GCP
    // NOTE: This requires the helm-git plugin to be installed:
    //   helm plugin install https://github.com/aslafy-z/helm-git --version 1.4.1 --verify=false
    // The chart is fetched directly from GitHub using helm-git protocol.
    // Chart path format: git+https://github.com/user/repo@path/to/chart?ref=branch
    // This chart includes GKE NodeClass CRD and the correct controller image for GCP/GKE.
    const addBootstrap = args.bootstrapHardening !== false;
    let providerChart = new k8s.helm.v4.Chart(
      "karpenter-provider-gcp",
      {
        chart: "git+https://github.com/cloudpilot-ai/karpenter-provider-gcp@charts?ref=main",
        name: "karpenter",
        namespace: namespace.metadata.name,
        values: {
          serviceAccount: {
            create: false,
            name: serviceAccountName,
            annotations: {
              "iam.gke.io/gcp-service-account": gsaEmailOut,
            },
          },
          controller: {
            replicaCount: 1,
            settings: {
              projectID: clusterProject,
              location: args.region,
              clusterName: args.clusterName,
              clusterEndpoint: args.clusterEndpoint,
            },
            ...(addBootstrap ? { 
              tolerations: [
                { key: "components.gke.io/gke-managed-components", operator: "Exists", effect: "NoSchedule" },
                { key: "node.kubernetes.io/not-ready", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 },
                { key: "node.kubernetes.io/unreachable", operator: "Exists", effect: "NoExecute", tolerationSeconds: 300 }
              ],
              priorityClassName: ""
            } : {}),
          },
          credentials: {
            enabled: false,
          },
        },
      },
      {
        parent: this,
        dependsOn: [namespace, ksa, wiBinding],
      }
    );

    // Optional: create NodeClass + NodePool resources based on config
    const effectiveNodePools = args.nodePools || {};
    if (Object.keys(effectiveNodePools).length > 0) {
      const crDeps = [providerChart!] as pulumi.Resource[];
      for (const [poolName, def] of Object.entries(effectiveNodePools)) {
        const nodeClassName = def.nodeClassName || `${poolName.toLowerCase()}-class`;
        const nodeClassApi = def.nodeClass?.apiVersion || "karpenter.k8s.gcp/v1alpha1";
        const nodeClassKind = def.nodeClass?.kind || "GCENodeClass";
        const baseSpec = def.nodeClass?.spec || {};
        const nodeClassLabels = {
          ...(def.nodeClass?.metadata?.labels || {}),
          'karpenter.sh/project': clusterProject,
          'karpenter.sh/pool': poolName.toLowerCase(),
        };
        const nodeClassSpec: Record<string, unknown> = Helpers.resolveStackRefsDeep({
          ...baseSpec,
          imageSelectorTerms: baseSpec['imageSelectorTerms'] || [{ alias: "Ubuntu@latest" }],
          disks: baseSpec['disks'] || [{ boot: true, category: "pd-balanced", sizeGiB: 60 }],
        });

        // Test if CustomResource can inherit provider from parent
        const nodeClass = new k8s.apiextensions.CustomResource(`${poolName}-nodeclass`, {
          apiVersion: nodeClassApi,
          kind: nodeClassKind,
          metadata: {
            name: nodeClassName,
            annotations: def.nodeClass?.metadata?.annotations || {},
            labels: nodeClassLabels,
          },
          spec: nodeClassSpec,
        }, { 
          parent: this, // Remove explicit provider, test inheritance
          dependsOn: crDeps,
          customTimeouts: { create: "5m" },
          ignoreChanges: ["metadata.labels"],
        });

        const templateSpec: Record<string, unknown> = {};
        if (def.requirements && def.requirements.length > 0) {
          (templateSpec as any)["requirements"] = def.requirements;
        }
        const effectiveTaints = (def.taints && def.taints.length > 0)
          ? def.taints
          : [];
        if (effectiveTaints.length > 0) {
          (templateSpec as any)["taints"] = effectiveTaints;
        }
        (templateSpec as any).nodeClassRef = { 
          name: nodeClassName,
          group: "karpenter.k8s.gcp",
          kind: "GCENodeClass"
        };

        const nodePoolSpec: Record<string, unknown> = {
          template: {
            metadata: {
              labels: def.labels || {},
              annotations: def.annotations || {},
            },
            spec: templateSpec,
          },
          ...(def.limits ? { limits: def.limits } : {}),
          ...(def.weight !== undefined ? { weight: def.weight } : {}),
          ...(def.ttlSecondsAfterEmpty !== undefined ? { ttlSecondsAfterEmpty: def.ttlSecondsAfterEmpty } : {}),
          ...(def.disruption ? { disruption: def.disruption } : {}),
        };

        // Test if CustomResource can inherit provider from parent
        new k8s.apiextensions.CustomResource(`${poolName}-nodepool`, {
          apiVersion: "karpenter.sh/v1",
          kind: "NodePool",
          metadata: {
            name: poolName.toLowerCase(),
          },
          spec: nodePoolSpec,
        }, { parent: this, dependsOn: [nodeClass, ...crDeps] }); // Remove explicit provider, test inheritance
      }
    }

    this.registerOutputs({});
  }
}
