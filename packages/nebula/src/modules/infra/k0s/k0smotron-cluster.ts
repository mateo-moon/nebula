import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { ClusterV1Beta2, MachineDeploymentV1Beta1 } from "#imports/cluster.x-k8s.io";
import { K0sWorkerConfigTemplateV1Beta2 } from "#imports/bootstrap.cluster.x-k8s.io";
import { K0SmotronControlPlaneV1Beta2SpecServiceType } from "#imports/controlplane.cluster.x-k8s.io";
import {
  DEFAULT_PRESTART_COMMANDS,
  renderK0sWorkerArgs,
  type K0sInfraProvider,
  type K0sWorkerPool,
} from "./cluster";
import {
  K0smotronControlPlane,
  type K0smotronControlPlanePersistence,
} from "./k0smotron-control-plane";

/** Hosted control-plane options (provider-independent — see {@link K0smotronControlPlane}). */
export interface K0smotronClusterControlPlane {
  /** Hosted-etcd persistence (default emptyDir; prefer PVC on a persistent mgmt cluster). */
  persistence?: K0smotronControlPlanePersistence;
  /** API Service type on the hosting cluster (default LoadBalancer). */
  serviceType?: K0SmotronControlPlaneV1Beta2SpecServiceType;
  /** API Service annotations (hosting-cluster LB specifics, e.g. AWS NLB scheme). */
  serviceAnnotations?: Record<string, string>;
}

export interface K0smotronClusterConfig<M> {
  /** Cluster name (also the CAPI Cluster / infra-cluster name). */
  name: string;
  /** Namespace for the CAPI objects on the hosting cluster (default "default"). */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); the k0s variant is derived from it. */
  k8sVersion?: string;
  /** Pod CIDR (default "10.244.0.0/16"). */
  podCidr?: string;
  /** Service CIDR (default "10.96.0.0/12"). */
  serviceCidr?: string;
  /** Hosted control plane (K0smotronControlPlane pods on the hosting cluster). */
  controlPlane?: K0smotronClusterControlPlane;
  /** Worker pools keyed by pool name (each a MachineDeployment). */
  workerPools?: Record<string, K0sWorkerPool<M>>;
  /** Infrastructure provider adapter for the WORKERS (AWS now; GCP/others later). */
  provider: K0sInfraProvider<M>;
}

/**
 * K0smotronCluster — a self-managed k0s cluster with a HOSTED control plane: the
 * CP runs as k0smotron pods in the hosting (management) cluster, while the workers
 * are provider-managed machines. Sibling to the standalone-CP {@link K0sCluster};
 * the two mirror the k0smotron package's two control-plane kinds
 * (`K0smotronControlPlane` vs `K0sControlPlane`).
 *
 * The control plane ({@link K0smotronControlPlane}) is provider-INDEPENDENT; only
 * the workers carry a {@link K0sInfraProvider} `M`. The provider is told the CP is
 * hosted (`hostedControlPlane: true`) so it emits its infra cluster with the API
 * load balancer DISABLED — k0smotron exposes the API via a Service on the hosting
 * cluster, not via the workers' infra provider. CNI is "custom" (installed
 * separately into the workload cluster, e.g. the `Calico` module).
 */
export class K0smotronCluster<M> extends BaseConstruct<K0smotronClusterConfig<M>> {
  constructor(scope: Construct, id: string, config: K0smotronClusterConfig<M>) {
    super(scope, id, config);

    const name = this.config.name;
    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    const k0sVersion = `${k8sVersion}+k0s.0`;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const provider = this.config.provider;

    const clusterName = name;
    const controlPlaneName = `${name}-control-plane`;

    // 1. CAPI Cluster — control plane is a hosted K0smotronControlPlane; infra ref
    //    supplied by the provider (workers' AWSCluster/…).
    new ClusterV1Beta2(this, "cluster", {
      metadata: { name: clusterName, namespace },
      spec: {
        clusterNetwork: {
          pods: { cidrBlocks: [podCidr] },
          services: { cidrBlocks: [serviceCidr] },
        },
        controlPlaneRef: {
          apiGroup: "controlplane.cluster.x-k8s.io",
          kind: "K0smotronControlPlane",
          name: controlPlaneName,
        },
        infrastructureRef: {
          apiGroup: provider.infraClusterApiGroup,
          kind: provider.infraClusterKind,
          name: clusterName,
        },
      },
    });

    // 2. Infra cluster CR (AWSCluster/…) — CAPA owns the VPC/subnets/SGs; the API
    //    load balancer is DISABLED (k0smotron exposes the API). networkProvider is
    //    "custom" (a CNI is installed separately into the workload cluster).
    provider.emitInfraCluster(this, {
      clusterName,
      namespace,
      networkProvider: "custom",
      calico: {},
      hostedControlPlane: true,
    });

    // 3. Hosted control plane — pods on the hosting cluster (provider-independent).
    new K0smotronControlPlane(this, "control-plane", {
      name: controlPlaneName,
      namespace,
      k8sVersion,
      podCidr,
      serviceCidr,
      persistence: this.config.controlPlane?.persistence,
      serviceType: this.config.controlPlane?.serviceType,
      serviceAnnotations: this.config.controlPlane?.serviceAnnotations,
    });

    // 4. Worker pools — per pool: infra machine template (provider) +
    //    K0sWorkerConfigTemplate (cloud-init + native --labels/--taints) +
    //    MachineDeployment (static replicas, no autoscaler). Identical to the
    //    standalone K0sCluster's worker emission.
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
