import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import {
  K0sCalicoConfig,
  resolveK0sCalico,
  renderK0sCalicoSpec,
} from "./calico";
import {
  K0smotronControlPlaneV1Beta2,
  K0SmotronControlPlaneV1Beta2SpecServiceType,
  K0SmotronControlPlaneV1Beta2SpecPersistence,
  K0SmotronControlPlaneV1Beta2SpecPersistencePersistentVolumeClaimSpecResourcesRequests,
  K0SmotronControlPlaneV1Beta2SpecPatches,
  K0SmotronControlPlaneV1Beta2SpecPatchesPatchType,
  K0SmotronControlPlaneV1Beta2SpecResources,
  K0SmotronControlPlaneV1Beta2SpecResourcesLimits,
  K0SmotronControlPlaneV1Beta2SpecResourcesRequests,
  type K0SmotronControlPlaneV1Beta2SpecTopologySpreadConstraints,
} from "#imports/controlplane.cluster.x-k8s.io";

/** The generated Quantity wrappers serialize via `.value` — bare strings render null. */
function toQuantities(resources: {
  requests?: Record<string, string>;
  limits?: Record<string, string>;
}): K0SmotronControlPlaneV1Beta2SpecResources {
  return {
    ...(resources.requests
      ? {
          requests: Object.fromEntries(
            Object.entries(resources.requests).map(([k, v]) => [
              k,
              K0SmotronControlPlaneV1Beta2SpecResourcesRequests.fromString(v),
            ]),
          ),
        }
      : {}),
    ...(resources.limits
      ? {
          limits: Object.fromEntries(
            Object.entries(resources.limits).map(([k, v]) => [
              k,
              K0SmotronControlPlaneV1Beta2SpecResourcesLimits.fromString(v),
            ]),
          ),
        }
      : {}),
  };
}

/** Hosted-etcd persistence for the k0smotron control plane. */
export type K0smotronControlPlanePersistence =
  | { type: "emptyDir" }
  | {
      type: "pvc";
      /** StorageClass on the HOSTING (management) cluster (e.g. "standard-rwo"). */
      storageClass?: string;
      /** PVC size (default "5Gi"). */
      size?: string;
      /** Access modes (default ["ReadWriteOnce"]). */
      accessModes?: string[];
    };

export interface K0smotronControlPlaneConfig {
  /** CR name (the CAPI `Cluster.spec.controlPlaneRef.name`). */
  name: string;
  /** Namespace on the hosting cluster (default "default"). */
  namespace?: string;
  /** Kubernetes version (e.g. "v1.31.8"); the k0s variant is `${k8sVersion}+k0s.0`. */
  k8sVersion?: string;
  /** Pod CIDR (default "10.244.0.0/16"). */
  podCidr?: string;
  /** Service CIDR (default "10.96.0.0/12"). */
  serviceCidr?: string;
  /**
   * CNI the hosted control plane installs into the WORKLOAD cluster. Default
   * "calico" (k0s's bundled Calico): the CP's manifest applier writes it to the
   * child API, so workers go Ready without waiting on a separate CNI deploy.
   * "custom" installs NO CNI — workers stay NotReady until one is deployed into
   * the workload cluster (e.g. the `Calico` module).
   * **Immutable at cluster creation** — k0s only supports changing the CNI
   * provider through a full cluster redeployment.
   */
  networkProvider?: "kuberouter" | "calico" | "custom";
  /**
   * k0s-bundled Calico settings (only emitted when networkProvider="calico").
   * Defaults: `mode: "vxlan"`, `wireguard: true`.
   */
  calico?: K0sCalicoConfig;
  /**
   * Dual-stack: adds an IPv6 pod/service CIDR pair to the k0s network config.
   * With an on-link IPv6 GUA on the nodes (AwsK0sProviderConfig.ipv6), the
   * cluster's node identity can be a real public address with no NAT emulation.
   * Per k0s docs, bundled Calico dual-stack requires mode "bird".
   */
  dualStack?: { ipv6PodCidr: string; ipv6ServiceCidr: string };
  /** Hosted-etcd persistence (default emptyDir). */
  persistence?: K0smotronControlPlanePersistence;
  /**
   * Service type for the hosted API endpoint — this Service runs in the HOSTING
   * cluster, so it uses that cluster's LB (not the workers' infra provider).
   * Default "LoadBalancer".
   */
  serviceType?: K0SmotronControlPlaneV1Beta2SpecServiceType;
  /**
   * Annotations for the API Service — hosting-cluster LB specifics, e.g. an AWS
   * NLB scheme. k0smotron v2's v1beta2 `spec.service` cannot carry annotations,
   * so they are injected via `spec.patches` (a MERGE patch on the generated
   * `Service`, matched by Kind + `app.kubernetes.io/component: control-plane`).
   * Without an explicit internet-facing scheme the AWS LB Controller defaults the
   * NLB to "internal" and workers in another VPC cannot reach the CP.
   */
  serviceAnnotations?: Record<string, string>;
  /**
   * Requests/limits for the CP (kmc-*) pods. Without requests the scheduler
   * bin-packs multiple hosted CPs onto one hosting node and saturates it.
   */
  resources?: {
    requests?: Record<string, string>;
    limits?: Record<string, string>;
  };
  /**
   * topologySpreadConstraints for the CP pods — e.g. spread all
   * `app.kubernetes.io/component: control-plane` pods across hostnames so two
   * workload clusters' CPs never share a hosting node.
   */
  topologySpreadConstraints?: K0SmotronControlPlaneV1Beta2SpecTopologySpreadConstraints[];
}

/**
 * K0smotronControlPlane — a HOSTED k0s control plane: etcd + k0s controllers run
 * as pods in the HOSTING (management) cluster, and k0smotron exposes the API via
 * a Service on that cluster. Provider-INDEPENDENT by design (no worker-machine
 * type parameter): the hosting substrate is decoupled from where the workers run,
 * so one management cluster can host the control plane of a workload cluster whose
 * workers live on any infra provider (AWS/GCP/bare-metal).
 *
 * Pair with a worker fleet + infra `Cluster`/`AWSCluster(DISABLED LB)` — see
 * {@link K0smotronCluster}, which composes this CP with worker pools over a
 * {@link K0sInfraProvider}.
 */
export class K0smotronControlPlane extends BaseConstruct<K0smotronControlPlaneConfig> {
  constructor(scope: Construct, id: string, config: K0smotronControlPlaneConfig) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? "default";
    const k8sVersion = this.config.k8sVersion ?? "v1.31.8";
    // k0smotron expects a SemVer; the canonical k0s suffix is "+k0s.0" (build
    // metadata), NOT "-k0s.0" (a pre-release, k0smotron issue #1027).
    const version = `${k8sVersion}+k0s.0`;
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const serviceCidr = this.config.serviceCidr ?? "10.96.0.0/12";
    const networkProvider = this.config.networkProvider ?? "calico";
    const calico = renderK0sCalicoSpec(resolveK0sCalico(this.config.calico));

    const cpPersistence = this.config.persistence;
    const persistence: K0SmotronControlPlaneV1Beta2SpecPersistence =
      cpPersistence?.type === "pvc"
        ? {
            type: "pvc",
            persistentVolumeClaim: {
              spec: {
                accessModes: cpPersistence.accessModes ?? ["ReadWriteOnce"],
                ...(cpPersistence.storageClass
                  ? { storageClassName: cpPersistence.storageClass }
                  : {}),
                resources: {
                  // The generated `requests` values are a Quantity wrapper whose
                  // serializer reads `.value`; a bare string renders `storage:
                  // null`, so wrap the size with the Quantity type.
                  requests: {
                    storage:
                      K0SmotronControlPlaneV1Beta2SpecPersistencePersistentVolumeClaimSpecResourcesRequests.fromString(
                        cpPersistence.size ?? "5Gi",
                      ),
                  },
                },
              },
            },
          }
        : { type: "emptyDir" };

    const servicePatches: K0SmotronControlPlaneV1Beta2SpecPatches[] = this.config
      .serviceAnnotations
      ? [
          {
            target: { kind: "Service", component: "control-plane" },
            patch: {
              type: K0SmotronControlPlaneV1Beta2SpecPatchesPatchType.MERGE,
              content: JSON.stringify({
                metadata: { annotations: this.config.serviceAnnotations },
              }),
            },
          },
        ]
      : [];

    new K0smotronControlPlaneV1Beta2(this, "control-plane", {
      metadata: { name: this.config.name, namespace },
      spec: {
        version,
        k0SConfig: {
          apiVersion: "k0s.k0sproject.io/v1beta1",
          kind: "ClusterConfig",
          spec: {
            network: {
              // k0smotron merges this config untouched, and the CP pod runs a
              // full k0s controller — so a bundled CNI ("calico"/"kuberouter")
              // is applied to the child API by the CP's manifest applier.
              // "custom" installs none, leaving the CNI to a separate deploy.
              provider: networkProvider,
              ...(networkProvider === "calico" ? { calico } : {}),
              podCIDR: podCidr,
              serviceCIDR: serviceCidr,
              ...(this.config.dualStack
                ? {
                    dualStack: {
                      enabled: true,
                      IPv6podCIDR: this.config.dualStack.ipv6PodCidr,
                      IPv6serviceCIDR: this.config.dualStack.ipv6ServiceCidr,
                    },
                  }
                : {}),
            },
          },
        },
        persistence,
        service: {
          type:
            this.config.serviceType ??
            K0SmotronControlPlaneV1Beta2SpecServiceType.LOAD_BALANCER,
        },
        ...(servicePatches.length ? { patches: servicePatches } : {}),
        ...(this.config.resources ? { resources: toQuantities(this.config.resources) } : {}),
        ...(this.config.topologySpreadConstraints
          ? { topologySpreadConstraints: this.config.topologySpreadConstraints }
          : {}),
      },
    });
  }
}
