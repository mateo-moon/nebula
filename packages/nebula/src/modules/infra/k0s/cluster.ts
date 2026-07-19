import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { ClusterV1Beta2, MachineDeploymentV1Beta1 } from "#imports/cluster.x-k8s.io";
import { K0sControlPlaneV1Beta2 } from "#imports/controlplane.cluster.x-k8s.io";
import { K0sWorkerConfigTemplateV1Beta2 } from "#imports/bootstrap.cluster.x-k8s.io";

/**
 * A CAPI contract reference to a provider-specific infrastructure resource
 * (`AWSMachineTemplate`, `GCPMachineTemplate`, …) that a K0sControlPlane's
 * `machineTemplate.infrastructureRef` or a MachineDeployment's
 * `infrastructureRef` points at.
 */
export interface CapiInfraRef {
  apiVersion: string;
  kind: string;
  name: string;
}

/** A Kubernetes node taint (key[=value]:Effect). */
export interface NodeTaint {
  key: string;
  value?: string;
  /** e.g. "NoSchedule", "NoExecute", "PreferNoSchedule". */
  effect: string;
}

/**
 * A worker pool. Provider-agnostic except for `machine` — the infrastructure
 * machine spec (`M`) the provider understands (e.g. AWS instanceType/ami/spot).
 */
export interface K0sWorkerPool<M> {
  /** Number of worker nodes (static — no autoscaler). Default 2. */
  replicas?: number;
  /** Node labels, applied via the native `k0s worker --labels` flag. */
  nodeLabels?: Record<string, string>;
  /** Node taints, applied via the native `k0s worker --taints` flag. */
  taints?: NodeTaint[];
  /** Extra raw `k0s worker` args (appended after --labels/--taints). */
  k0sArgs?: string[];
  /** Extra cloud-init preStartCommands appended to the defaults. */
  extraPreStartCommands?: string[];
  /** CAPI failureDomain (e.g. an AZ name) to pin the pool's Machines to. */
  failureDomain?: string;
  /** Provider-specific machine spec (instanceType/ami/… for AWS). */
  machine: M;
}

/** Control-plane configuration for a standalone (in-cluster) k0s control plane. */
export interface K0sControlPlaneOptions<M> {
  /** Number of control-plane nodes (default 3 for HA). */
  replicas?: number;
  /**
   * Run workloads on the control-plane nodes (k0s combined controller+worker,
   * `--enable-worker --no-taints`). Default true — a small management cluster's
   * CP nodes also host the platform. Set false for a dedicated control plane.
   */
  enableWorker?: boolean;
  /** Extra k0s controller args. */
  extraArgs?: string[];
  /** Extra cloud-init preStartCommands appended to the defaults. */
  extraPreStartCommands?: string[];
  /** Provider-specific machine spec for the control-plane nodes. */
  machine: M;
}

/**
 * Context the base construct hands a provider so it can emit the infra Cluster
 * CR (`AWSCluster`/`GCPCluster`). Cluster-level infra config (region, VPC,
 * subnets, LB scheme, …) lives on the provider itself, constructed by the caller.
 */
export interface EmitInfraClusterCtx {
  clusterName: string;
  namespace: string;
  /** CNI selected in the k0s ClusterConfig, so cloud providers can open its node-to-node transport. */
  networkProvider: "kuberouter" | "calico" | "custom";
  /** Bundled Calico transport settings (only meaningful for networkProvider="calico"). */
  calico: { wireguard?: boolean; mode?: "vxlan" | "ipip" | "bird"; mtu?: number };
}

/**
 * Context for emitting one infra machine template (control-plane or a worker
 * pool). The provider owns immutable-template naming (it hashes `machine` so any
 * spec change rotates the template) and returns the ref to wire into CAPI.
 */
export interface EmitMachineTemplateCtx<M> {
  /** Base name (the provider appends its own spec hash for rotation). */
  baseName: string;
  namespace: string;
  role: "control-plane" | "worker";
  machine: M;
}

/**
 * Infrastructure provider adapter for {@link K0sCluster}. Implementations
 * (`AwsK0sProvider`, a future `GcpK0sProvider`) emit the cloud-specific CRs and
 * report the CAPI refs the provider-agnostic base wires into the Cluster,
 * K0sControlPlane, and MachineDeployments. `M` is the provider's machine spec.
 */
export interface K0sInfraProvider<M> {
  /** apiGroup for the CAPI `Cluster.spec.infrastructureRef`. */
  readonly infraClusterApiGroup: string;
  /** kind for the CAPI `Cluster.spec.infrastructureRef` (e.g. "AWSCluster"). */
  readonly infraClusterKind: string;
  /** Emit the infra cluster CR, named `clusterName`, into `scope`. */
  emitInfraCluster(scope: Construct, ctx: EmitInfraClusterCtx): void;
  /** Emit an infra machine template and return its CAPI ref. */
  emitMachineTemplate(
    scope: Construct,
    id: string,
    ctx: EmitMachineTemplateCtx<M>,
  ): CapiInfraRef;
}

export interface K0sClusterConfig<M> {
  /** Cluster name (also the CAPI Cluster / infra-cluster name). */
  name: string;
  /** Namespace for the CAPI objects (default "default"). */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); the k0s variant is derived from it. */
  k8sVersion?: string;
  /** Pod CIDR (default "10.244.0.0/16"). */
  podCidr?: string;
  /** Service CIDR (default "10.96.0.0/12"). */
  serviceCidr?: string;
  /**
   * CNI for the embedded k0s ClusterConfig. Default "kuberouter" (k0s built-in).
   * "custom" makes k0s install NO CNI so a CNI is deployed separately (e.g. the
   * `Calico` module). Immutable at cluster creation.
   */
  networkProvider?: "kuberouter" | "calico" | "custom";
  /** k0s-bundled Calico settings (only meaningful when networkProvider="calico"). */
  calico?: { wireguard?: boolean; mode?: "vxlan" | "ipip" | "bird"; mtu?: number };
  /**
   * Configure the kube-apiserver as an OIDC issuer for IRSA/WebIdentity.
   * `issuerUrl` is the public HTTPS base URL hosting the discovery + JWKS.
   */
  oidcIssuer?: { issuerUrl: string };
  /** Control-plane configuration. */
  controlPlane: K0sControlPlaneOptions<M>;
  /** Worker pools keyed by pool name (each a MachineDeployment). */
  workerPools?: Record<string, K0sWorkerPool<M>>;
  /** Infrastructure provider adapter (AWS now; GCP/others later). */
  provider: K0sInfraProvider<M>;
}

/**
 * Default cloud-init preStartCommands (storage deps for Piraeus/LINSTOR),
 * shared by the control-plane and every worker pool.
 */
export const DEFAULT_PRESTART_COMMANDS: readonly string[] = [
  "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=8192",
  "apt-get update -qq && apt-get install -y -qq linux-headers-$(uname -r) lvm2 thin-provisioning-tools open-iscsi cryptsetup",
  "systemctl enable --now iscsid || true",
];

/** Render `k0s worker` --labels/--taints args from a pool's labels/taints. */
function renderK0sWorkerArgs<M>(pool: K0sWorkerPool<M>): string[] {
  const args: string[] = [];
  if (pool.nodeLabels && Object.keys(pool.nodeLabels).length > 0) {
    args.push(
      `--labels=${Object.entries(pool.nodeLabels)
        .map(([k, v]) => `${k}=${v}`)
        .join(",")}`,
    );
  }
  if (pool.taints?.length) {
    args.push(
      `--taints=${pool.taints
        .map(
          (t) => `${t.key}${t.value !== undefined ? `=${t.value}` : ""}:${t.effect}`,
        )
        .join(",")}`,
    );
  }
  args.push(...(pool.k0sArgs ?? []));
  return args;
}

/**
 * K0sCluster — a self-managed, HA k0s cluster via Cluster API with a
 * **standalone** control plane (etcd + k0s controllers on the cluster's own
 * nodes). Provider-agnostic: the CAPI `Cluster`, `K0sControlPlane`,
 * `K0sWorkerConfigTemplate`s, and `MachineDeployment`s are emitted here; the
 * cloud-specific infra CRs (`AWSCluster`/`AWSMachineTemplate`, …) come from a
 * pluggable {@link K0sInfraProvider} passed as `config.provider`.
 *
 * Because the control plane runs IN the cluster's own VPC/network, the API load
 * balancer is owned by the infra provider (CAPA for AWS) — there is no hosted
 * control plane and no cross-VPC control-plane reachability to arrange.
 */
export class K0sCluster<M> extends BaseConstruct<K0sClusterConfig<M>> {
  constructor(scope: Construct, id: string, config: K0sClusterConfig<M>) {
    super(scope, id, config);

    const name = this.config.name;
    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    const k0sVersion = `${k8sVersion}+k0s.0`;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const networkProvider = this.config.networkProvider ?? "kuberouter";
    const calico = this.config.calico ?? {};
    const cp = this.config.controlPlane;
    const provider = this.config.provider;

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;

    // 1. CAPI Cluster — infra ref supplied by the provider; control plane is
    //    always a K0sControlPlane. CAPI v1beta2 refs carry `apiGroup` (the CRD
    //    contract resolves the version), not a versioned `apiVersion`.
    new ClusterV1Beta2(this, "cluster", {
      metadata: { name: clusterName, namespace },
      spec: {
        clusterNetwork: {
          pods: { cidrBlocks: [podCidr] },
          services: { cidrBlocks: [serviceCidr] },
        },
        controlPlaneRef: {
          apiGroup: "controlplane.cluster.x-k8s.io",
          kind: "K0sControlPlane",
          name: controlPlaneName,
        },
        infrastructureRef: {
          apiGroup: provider.infraClusterApiGroup,
          kind: provider.infraClusterKind,
          name: clusterName,
        },
      },
    });

    // 2. Infra cluster CR (AWSCluster/…) — CAPA owns the VPC/subnets/SGs and the
    //    control-plane load balancer.
    provider.emitInfraCluster(this, {
      clusterName,
      namespace,
      networkProvider,
      calico,
    });

    // 3. Control-plane infra machine template (hash-named by the provider).
    const cpRef = provider.emitMachineTemplate(this, "control-plane-template", {
      baseName: `${name}-control-plane`,
      namespace,
      role: "control-plane",
      machine: cp.machine,
    });

    // 4. K0sControlPlane — standalone HA control plane on the infra nodes.
    const enableWorker = cp.enableWorker !== false;
    const args = [
      ...(enableWorker ? ["--enable-worker", "--no-taints"] : []),
      ...(cp.extraArgs ?? []),
    ];
    new K0sControlPlaneV1Beta2(this, "control-plane", {
      metadata: { name: controlPlaneName, namespace },
      spec: {
        replicas: cp.replicas ?? 3,
        version: k0sVersion,
        k0SConfigSpec: {
          ...(args.length ? { args } : {}),
          k0S: {
            apiVersion: "k0s.k0sproject.io/v1beta1",
            kind: "ClusterConfig",
            spec: {
              network: {
                provider: networkProvider,
                ...(networkProvider === "calico"
                  ? {
                      calico: {
                        mode: calico.mode ?? "vxlan",
                        wireguard: calico.wireguard ?? false,
                        ...(calico.mtu ? { mtu: calico.mtu } : {}),
                      },
                    }
                  : {}),
                podCIDR: podCidr,
                serviceCIDR: serviceCidr,
              },
              ...(this.config.oidcIssuer
                ? {
                    api: {
                      extraArgs: {
                        "service-account-issuer": this.config.oidcIssuer.issuerUrl,
                        "service-account-jwks-uri": `${this.config.oidcIssuer.issuerUrl}/keys.json`,
                      },
                    },
                  }
                : {}),
            },
          },
          preK0SCommands: [
            ...DEFAULT_PRESTART_COMMANDS,
            ...(cp.extraPreStartCommands ?? []),
          ],
        },
        machineTemplate: {
          infrastructureRef: {
            apiVersion: cpRef.apiVersion,
            kind: cpRef.kind,
            name: cpRef.name,
          },
        },
      },
    });

    // 5. Worker pools — per pool: infra machine template (provider) +
    //    K0sWorkerConfigTemplate (cloud-init + native --labels/--taints) +
    //    MachineDeployment (static replicas, no autoscaler).
    for (const [poolName, pool] of Object.entries(this.config.workerPools ?? {})) {
      const infraRef = provider.emitMachineTemplate(
        this,
        `worker-template-${poolName}`,
        {
          baseName: `${name}-${poolName}`,
          namespace,
          role: "worker",
          machine: pool.machine,
        },
      );

      const workerConfigName = `${name}-${poolName}-config`;
      const wargs = renderK0sWorkerArgs(pool);
      new K0sWorkerConfigTemplateV1Beta2(this, `worker-config-${poolName}`, {
        metadata: { name: workerConfigName, namespace },
        spec: {
          template: {
            spec: {
              version: k0sVersion,
              ...(wargs.length ? { args: wargs } : {}),
              preK0SCommands: [
                ...DEFAULT_PRESTART_COMMANDS,
                ...(pool.extraPreStartCommands ?? []),
              ],
            },
          },
        },
      });

      new MachineDeploymentV1Beta1(this, `worker-md-${poolName}`, {
        metadata: { name: `${name}-${poolName}`, namespace },
        spec: {
          clusterName,
          replicas: pool.replicas ?? 2,
          selector: {
            matchLabels: { "cluster.x-k8s.io/cluster-name": clusterName },
          },
          template: {
            spec: {
              clusterName,
              version: k8sVersion,
              ...(pool.failureDomain ? { failureDomain: pool.failureDomain } : {}),
              bootstrap: {
                configRef: {
                  apiVersion: "bootstrap.cluster.x-k8s.io/v1beta2",
                  kind: "K0sWorkerConfigTemplate",
                  name: workerConfigName,
                },
              },
              infrastructureRef: {
                apiVersion: infraRef.apiVersion,
                kind: infraRef.kind,
                name: infraRef.name,
              },
            },
          },
        },
      });
    }
  }
}
