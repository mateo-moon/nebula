import * as k8s from "@pulumi/kubernetes";
import type { ChartArgs } from "@pulumi/kubernetes/helm/v4";
import * as pulumi from "@pulumi/pulumi";
import * as gcp from "@pulumi/gcp";
import * as fs from "fs";
import * as path from "path";
import { execSync } from "child_process";
import { Helpers } from "../../utils/helpers";

type OptionalChartArgs = Omit<ChartArgs, "chart"> & { chart?: ChartArgs["chart"] };

export interface KarpenterConfig {
  /** Namespace where Karpenter will be installed (default: "karpenter") */
  namespace?: string;
  /** Name of the cluster as seen by Karpenter's controller (required) */
  clusterName: pulumi.Input<string>;
  /** Optional cluster API server endpoint, recommended on some providers */
  clusterEndpoint?: pulumi.Input<string>;
  /** GCP region for the provider (required if installProvider=true) */
  region?: pulumi.Input<string>;
  /** Optional extra Helm values to merge */
  values?: Record<string, unknown>;
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
  /** Install provider-specific controller for GCP (default: false) */
  installProvider?: boolean;
  /** Provider chart repo override (default: charts.karpenter.sh) */
  providerRepository?: string;
  /** Provider chart version */
  providerVersion?: string;
  /** Additional chart args for provider */
  providerArgs?: OptionalChartArgs;
  /** Helm values for provider */
  providerValues?: Record<string, unknown>;
  /** Local filesystem path to provider Helm chart directory (e.g. vendor/karpenter-provider-gcp/charts/karpenter). If set, overrides providerRepository. */
  providerChartPath?: string;
  /** Add default toleration for system taint (default: true) */
  bootstrapHardening?: boolean;
  /** Override PDB minAvailable (default: 1). Note: PDB is managed by Helm chart, this is not currently used */
  pdbMinAvailable?: number;
  /** Number of Karpenter controller replicas (default: 1) */
  replicaCount?: number;
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
    /** Provider-specific spec fields. We'll inject projectID and serviceAccount by default. */
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
  /** Disruption configuration - controls how Karpenter handles node disruption (drift, empty nodes, etc.) */
  disruption?: {
    /** Consolidate after duration (e.g., '30s', '1m') */
    consolidateAfter?: string;
    /** Consolidation policy: 'Never', 'WhenEmpty', 'WhenUnderutilized' */
    consolidationPolicy?: 'Never' | 'WhenEmpty' | 'WhenUnderutilized';
    /** Expire nodes after specified duration if empty */
    expireAfter?: string;
    /** Budgets for limiting disruption - array of budget objects */
    budgets?: Array<{
      nodes?: string;
      max?: number;
    }>;
  } | Record<string, unknown>; // Allow passing through custom disruption config
}

export class Karpenter extends pulumi.ComponentResource {
  constructor(
    name: string,
    args: KarpenterConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super("karpenter", name, args, opts);

    // Extract k8s provider from opts if provided
    const k8sProvider = opts?.providers ? (opts.providers as any)[0] : opts?.provider;
    const childOpts = { parent: this, provider: k8sProvider };
    // Charts need providers array, not provider singular
    const chartOpts = { parent: this };
    if (k8sProvider) {
      (chartOpts as any).providers = [k8sProvider];
    }

    const namespaceName = args.namespace || "karpenter";
    const serviceAccountName = args.serviceAccountName || "karpenter";

    const namespace = new k8s.core.v1.Namespace("karpenter-namespace", {
      metadata: { name: namespaceName },
    }, childOpts);

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

    // Grant default roles for Karpenter controller on GCP (aligned with provider docs)
    // Minimum + commonly required
    const baseRoles = new Set<string>([
      "roles/compute.instanceAdmin.v1",
      "roles/iam.serviceAccountUser",
      "roles/compute.networkAdmin",
      "roles/logging.logWriter",
      "roles/monitoring.metricWriter",
      "roles/serviceusage.serviceUsageConsumer",
      "roles/container.clusterAdmin", // Required for GKE node pool management
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
    const ksa = new k8s.core.v1.ServiceAccount("karpenter-ksa", {
      metadata: {
        name: serviceAccountName,
        namespace: namespaceName,
        annotations: {
          ...(args.serviceAccountAnnotations || {}),
          // WI annotation binds the KSA to the created/reused GSA
          "iam.gke.io/gcp-service-account": gsaEmailOut,
        },
      },
    }, { ...childOpts, dependsOn: [namespace] });

    // Build Helm values
    const addBootstrap = args.bootstrapHardening !== false;
    const values: Record<string, unknown> = {
      serviceAccount: {
        create: false,
        name: serviceAccountName,
        annotations: {
          ...(args.serviceAccountAnnotations || {}),
          "iam.gke.io/gcp-service-account": gsaEmailOut,
        },
      },
      // Karpenter v0/v1 chart schemas differ; set both keys conservatively.
      settings: {
        clusterName: args.clusterName,
        ...(args.clusterEndpoint ? { clusterEndpoint: args.clusterEndpoint } : {}),
      },
      // replicaCount is at the top level for Karpenter charts
      ...(args.replicaCount !== undefined ? { replicaCount: args.replicaCount } : {}),
      controller: {
        clusterName: args.clusterName,
        ...(args.clusterEndpoint ? { clusterEndpoint: args.clusterEndpoint } : {}),
        env: [
          { name: "CLUSTER_NAME", value: args.clusterName },
          ...(args.clusterEndpoint ? [{ name: "CLUSTER_ENDPOINT", value: args.clusterEndpoint }] : [])
        ],
        resources: {
          requests: {
            cpu: "500m",
            memory: "512Mi"
          },
          limits: {
            cpu: "1",
            memory: "1Gi"
          }
        }
      },
      ...(addBootstrap ? { 
        tolerations: [
          { key: "components.gke.io/gke-managed-components", operator: "Exists", effect: "NoSchedule" }
        ],
        priorityClassName: ""
      } : {}),
      ...(args.values || {}),
    };

    // Helm: core Karpenter chart
    const defaultChartArgsBase: OptionalChartArgs = {
      chart: "karpenter",
      repositoryOpts: { repo: args.repository || "https://charts.karpenter.sh" },
      ...(args.version ? { version: args.version } : {}),
      namespace: namespaceName,
    };
    const providedArgs: OptionalChartArgs | undefined = args.args;
    const finalChartArgs: ChartArgs = {
      chart: (providedArgs?.chart ?? defaultChartArgsBase.chart) as pulumi.Input<string>,
      ...defaultChartArgsBase,
      ...(providedArgs || {}),
      namespace: namespaceName,
      values,
    };
    
    // Only install the main Karpenter chart if NOT using a provider-specific controller
    // When installProvider=true, the provider chart includes everything needed
    if (args.installProvider !== true) {
      new k8s.helm.v4.Chart("karpenter", finalChartArgs, { ...chartOpts, dependsOn: [namespace, ksa, wiBinding] });
    }

    // Optional: install provider-specific controller for GCP
    let providerChart: k8s.helm.v4.Chart | undefined = undefined;
    if (args.installProvider === true) {
      if (!args.region) {
        throw new Error("installProvider=true requires 'region' to be set (GCP region where the cluster runs).");
      }
      // Resolve chart source: prefer provided local path, then OCI/repo, otherwise auto-clone the upstream repo
      let providerLocalChartPath: string | undefined = undefined;
      let providerRepoUrl: string | undefined = args.providerRepository;
      if (args.providerChartPath) {
        providerLocalChartPath = path.resolve(args.providerChartPath);
        if (!fs.existsSync(providerLocalChartPath)) {
          throw new Error(`providerChartPath not found: ${providerLocalChartPath}`);
        }
      } else if (!providerRepoUrl || providerRepoUrl.startsWith("https://github.com")) {
        // Auto-clone CloudPilot upstream repo when a valid Helm repo/OCI isn't supplied
        const gitRef = args.providerVersion || "main";
        const cacheRoot = path.join(process.cwd(), ".pulumi", "cache", "karpenter-provider-gcp", gitRef);
        const repoUrl = "https://github.com/cloudpilot-ai/karpenter-provider-gcp.git";
        const chartSubdir = path.join(cacheRoot, "charts", "karpenter");
        try {
          if (!fs.existsSync(chartSubdir)) {
            fs.mkdirSync(cacheRoot, { recursive: true });
            execSync(`git clone --depth 1 --branch ${gitRef} ${repoUrl} ${cacheRoot}`, { stdio: "ignore" });
          }
        } catch (e) {
          throw new Error(`Failed to fetch provider chart from GitHub. Ensure 'git' is installed. Original error: ${e}`);
        }
        if (!fs.existsSync(chartSubdir)) {
          throw new Error(`Cloned repo is missing chart directory at ${chartSubdir}`);
        }
        providerLocalChartPath = chartSubdir;
        providerRepoUrl = undefined; // use local path
      }
      const providerValues: Record<string, unknown> = {
        serviceAccount: {
          create: false,
          name: serviceAccountName,
          annotations: {
            ...(args.serviceAccountAnnotations || {}),
            "iam.gke.io/gcp-service-account": gsaEmailOut,
          },
        },
        controller: {
          replicaCount: args.replicaCount !== undefined ? args.replicaCount : 1,
          settings: {
            projectID: clusterProject,
            location: args.region, // Use 'location' instead of 'region' for GCP provider chart
            clusterName: args.clusterName,
            ...(args.clusterEndpoint ? { clusterEndpoint: args.clusterEndpoint } : {}),
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
          enabled: false, // Use Workload Identity instead of secret
        },
        ...(args.providerValues || {}),
      };

      const providerArgs = args.providerArgs || {};
      const chartRef: pulumi.Input<string> = (providerArgs.chart as any)
        || (providerLocalChartPath ? providerLocalChartPath : (providerRepoUrl && providerRepoUrl.startsWith("oci://") ? providerRepoUrl : "karpenter"));
      const providerChartArgs: ChartArgs = {
        chart: chartRef,
        ...(providerRepoUrl && !providerLocalChartPath && !providerRepoUrl.startsWith("oci://") ? { repositoryOpts: { repo: providerRepoUrl } } : {}),
        ...(args.providerVersion && (!providerLocalChartPath || (providerRepoUrl && providerRepoUrl.startsWith("oci://"))) ? { version: args.providerVersion } : {}),
        ...(providerLocalChartPath ? { dependencyUpdate: true } : {}),
        namespace: namespaceName,
        values: providerValues,
        ...(providerArgs || {}),
      } as ChartArgs;
      // Don't depend on coreChart when installing provider - the core chart waits for AWS which won't work on GCP
      // The provider chart should install independently so it can configure Karpenter for GCP
      providerChart = new k8s.helm.v4.Chart("karpenter-provider-gcp", providerChartArgs, { ...chartOpts, dependsOn: [namespace, ksa, wiBinding] });
    }

    // Note: PDB is created by the Helm chart by default, so we don't need to create it separately
    // If you need to customize the PDB, you can do so via Helm values

    // Optional: create NodeClass + NodePool resources based on config
    // Add default system node pool if none provided
    const effectiveNodePools = args.nodePools || {};
    if (!effectiveNodePools['system']) {
      effectiveNodePools['system'] = {
        labels: { 'node.kubernetes.io/system': '' },
        taints: [{ key: 'node.kubernetes.io/system', value: '', effect: 'NoSchedule' }],
        requirements: [
          { key: 'karpenter.sh/capacity-type', operator: 'In', values: ['on-demand'] },
          { key: 'node.kubernetes.io/instance-type', operator: 'In', values: ['e2-standard-2'] },
        ],
        // Note: disruption config handled via pass-through below
      };
    }
    
    if (Object.keys(effectiveNodePools).length > 0) {
      if (args.installProvider !== true) {
        throw new Error("nodePools are defined but installProvider is not enabled. Enable installProvider to install the GCP provider (which installs the NodeClass CRD) before creating NodePools/NodeClasses.");
      }
      // NodePools use GCP provider CRDs, so they should only depend on the provider chart, not the core chart
      const crDeps = [providerChart!] as pulumi.Resource[];
      for (const [poolName, def] of Object.entries(effectiveNodePools)) {
        const nodeClassName = def.nodeClassName || `${poolName.toLowerCase()}-class`;
        const nodeClassApi = def.nodeClass?.apiVersion || "karpenter.k8s.gcp/v1alpha1";
        const nodeClassKind = def.nodeClass?.kind || "GCENodeClass";
        // Note: projectID is configured at the controller level in the Helm chart settings, not in the NodeClass spec
        // imageSelectorTerms is required - default to Ubuntu if not specified (Ubuntu works better for confidential containers)
        // disks is required - default to a standard boot disk if not specified
        const baseSpec = def.nodeClass?.spec || {};
        // For GCP, node naming is controlled by metadata labels in GCENodeClass
        // Add project/prefix labels to help identify nodes
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

        // Note: Pulumi may attempt to create this CustomResource before the Helm chart's CRD is fully established.
        // If this fails on first deployment, wait for the Helm chart to finish installing CRDs, then run pulumi up again.
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
          ...childOpts, 
          dependsOn: crDeps,
          // Extended timeout to allow CRD establishment on first deployment
          customTimeouts: { create: "5m" },
          // Ignore metadata label changes to avoid resource recreation
          ignoreChanges: ["metadata.labels"]
        });

        const templateSpec: Record<string, unknown> = {};
        if (def.requirements && def.requirements.length > 0) {
          (templateSpec as any)["requirements"] = def.requirements;
        }
        const effectiveTaints = (def.taints && def.taints.length > 0)
          ? def.taints
          : (poolName === 'system' ? [{ key: 'node.kubernetes.io/system', value: '', effect: 'NoSchedule' as const }] : []);
        if (effectiveTaints.length > 0) {
          (templateSpec as any)["taints"] = effectiveTaints;
        }
        // Reference the created NodeClass
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

        new k8s.apiextensions.CustomResource(`${poolName}-nodepool`, {
          apiVersion: "karpenter.sh/v1",
          kind: "NodePool",
          metadata: {
            name: poolName.toLowerCase(),
          },
          spec: nodePoolSpec,
        }, { ...childOpts, dependsOn: [nodeClass, ...crDeps] });
      }
    }

    this.registerOutputs({});
  }
}


