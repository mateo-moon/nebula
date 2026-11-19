import { K0sOidcAuthentication, type K0sApiOptions } from "./oidc-authentication";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { ClusterV1Beta2 } from "#imports/cluster.x-k8s.io";
import { K0sControlPlaneV1Beta2 } from "#imports/controlplane.cluster.x-k8s.io";
import {
  K0sCalicoConfig,
  ResolvedK0sCalico,
  resolveK0sCalico,
  renderK0sCalicoSpec,
  renderK0sCalicoImages,
} from "./calico";

import { DEFAULT_PRESTART_COMMANDS, emitWorkerPools, type K0sWorkerPool } from "./worker-pools";

export {
  autoscalerAnnotations,
  DEFAULT_PRESTART_COMMANDS,
  hostBootstrapTemplateName,
  NODE_IP_DISCOVERY_COMMANDS,
  renderK0sWorkerArgs,
  RETAINED_NIC_NODE_IP_DISCOVERY_COMMANDS,
  withNodeIpArgs,
  type K0sWorkerPool,
  type K0sWorkerPoolAutoscaling,
  type NodeTaint,
} from "./worker-pools";

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

/** Control-plane configuration for a standalone (in-cluster) k0s control plane. */
export interface K0sControlPlaneOptions<M> extends K0sApiOptions {
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
  calico: ResolvedK0sCalico;
  /**
   * Whether the control plane is HOSTED (k0smotron pods on a management cluster)
   * rather than standalone (on this cluster's own machines). When true the
   * provider must NOT front the API with its own load balancer — k0smotron
   * exposes it — e.g. `AwsK0sProvider` emits its `AWSCluster` with
   * `loadBalancerType: DISABLED`. Standalone {@link K0sCluster} passes false.
   */
  hostedControlPlane: boolean;
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
  /** Optional, read-only host enrollment checks for a selected machine image. */
  hostPreK0sCommands?(machine: M, role?: "control-plane" | "worker"): readonly string[];
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
   * CNI for the embedded k0s ClusterConfig. Default "calico" (k0s's bundled
   * Calico), so the cluster self-bootstraps with a CNI up before any pod
   * schedules — no separate CNI deploy to sequence. "custom" makes k0s install
   * NO CNI so a CNI is deployed separately (e.g. the `Calico` module).
   * Immutable at cluster creation.
   */
  networkProvider?: "kuberouter" | "calico" | "custom";
  /**
   * k0s-bundled Calico settings (only meaningful when networkProvider="calico").
   * Defaults: `mode: "vxlan"`, `wireguard: true` (encrypted node-to-node pod
   * traffic).
   */
  calico?: K0sCalicoConfig;
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
    const networkProvider = this.config.networkProvider ?? "calico";
    // Resolve the Calico defaults ONCE: the same values feed the k0s
    // ClusterConfig below AND the provider's node-to-node SG rules, which would
    // otherwise miss WireGuard's UDP 51820 whenever the caller relies on the
    // default (silently dropping all cross-node pod traffic).
    const calico = resolveK0sCalico(this.config.calico);
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
      hostedControlPlane: false,
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
    K0sOidcAuthentication.validateControlPlane(cp.authentication, { namespace, k8sVersion });
    const authentication = cp.authentication ? new K0sOidcAuthentication(this, "oidc", { ...cp.authentication, namespace }) : undefined;
    const bootstrap = authentication?.standalone();
    const apiArgs = {
      ...(this.config.oidcIssuer ? {
        "service-account-issuer": this.config.oidcIssuer.issuerUrl,
        "service-account-jwks-uri": `${this.config.oidcIssuer.issuerUrl}/keys.json`,
      } : {}), ...cp.apiExtraArgs,
    };
    const api = authentication?.api(apiArgs, cp.apiRawArgs) ?? {
      ...(Object.keys(apiArgs).length ? { extraArgs: apiArgs } : {}),
      ...(cp.apiRawArgs?.length ? { rawArgs: cp.apiRawArgs } : {}),
    };
    new K0sControlPlaneV1Beta2(this, "control-plane", {
      metadata: { name: controlPlaneName, namespace },
      spec: {
        replicas: cp.replicas ?? 3,
        version: k0sVersion,
        k0SConfigSpec: {
          ...(args.length ? { args } : {}),
          ...(bootstrap ? { files: bootstrap.files } : {}),
          k0S: {
            apiVersion: "k0s.k0sproject.io/v1beta1",
            kind: "ClusterConfig",
            spec: {
              network: {
                provider: networkProvider,
                ...(networkProvider === "calico"
                  ? { calico: renderK0sCalicoSpec(calico) }
                  : {}),
                podCIDR: podCidr,
                serviceCIDR: serviceCidr,
              },
              ...(networkProvider === "calico"
                ? renderK0sCalicoImages(calico)
                : {}),
              ...(Object.keys(api).length ? { api } : {}),
            },
          },
          preK0SCommands: [
            ...(provider.hostPreK0sCommands?.(cp.machine, "control-plane") ?? []),
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

    emitWorkerPools(this, {
      clusterName,
      namespace,
      k8sVersion,
      provider,
      pools: this.config.workerPools,
    });
  }
}
