import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import {
  K0smotronControlPlaneV1Beta2,
  K0SmotronControlPlaneV1Beta2SpecServiceType,
  K0SmotronControlPlaneV1Beta2SpecPersistence,
  K0SmotronControlPlaneV1Beta2SpecPersistencePersistentVolumeClaimSpecResourcesRequests,
  K0SmotronControlPlaneV1Beta2SpecPatches,
  K0SmotronControlPlaneV1Beta2SpecPatchesPatchType,
} from "#imports/controlplane.cluster.x-k8s.io";

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
              // CNI is installed separately (e.g. the Calico module) into the
              // workload cluster; k0s installs no CNI.
              provider: "custom",
              podCIDR: podCidr,
              serviceCIDR: serviceCidr,
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
      },
    });
  }
}
