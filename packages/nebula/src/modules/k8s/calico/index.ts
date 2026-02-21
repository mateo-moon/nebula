/**
 * Calico - CNI with WireGuard encryption for cross-node pod networking.
 *
 * Deploys the tigera-operator Helm chart which manages Calico components.
 * Optionally enables WireGuard encryption for pod-to-pod traffic, replacing
 * the need for manual WireGuard mesh tunnels in hybrid clusters.
 *
 * @example
 * ```typescript
 * import { Calico } from 'nebula/modules/k8s/calico';
 *
 * new Calico(chart, 'calico', {
 *   podCidr: '10.244.0.0/16',
 *   encapsulation: 'VXLANCrossSubnet',
 *   wireguard: true,
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject, Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "../../../core";

export interface CalicoConfig {
  /** Namespace for tigera-operator (defaults to tigera-operator) */
  namespace?: string;
  /** Helm chart version (defaults to v3.29.3) */
  version?: string;
  /** Helm repository URL */
  repository?: string;
  /** Pod CIDR — must match the cluster's pod network (defaults to 10.244.0.0/16) */
  podCidr?: string;
  /** Block size for per-node IP allocations (defaults to 24) */
  blockSize?: number;
  /** Encapsulation mode (defaults to VXLAN — best for hybrid/multi-site clusters) */
  encapsulation?:
    | "VXLAN"
    | "VXLANCrossSubnet"
    | "IPIP"
    | "IPIPCrossSubnet"
    | "None";
  /** Enable WireGuard encryption for pod-to-pod traffic (defaults to true) */
  wireguard?: boolean;
  /** WireGuard interface MTU (defaults to 1420) */
  wireguardMTU?: number;
  /** Enable BGP for route distribution (defaults to false — VXLAN overlay doesn't need BGP) */
  bgp?: boolean;
  /** Kubelet root path (defaults to /var/lib/kubelet; k0s uses /var/lib/k0s/kubelet) */
  kubeletPath?: string;
  /** Additional Helm values for tigera-operator */
  values?: Record<string, unknown>;
}

export class Calico extends BaseConstruct<CalicoConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;

  constructor(scope: Construct, id: string, config: CalicoConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "tigera-operator";
    const podCidr = this.config.podCidr ?? "10.244.0.0/16";
    const blockSize = this.config.blockSize ?? 24;
    const encapsulation = this.config.encapsulation ?? "VXLAN";
    const wireguard = this.config.wireguard ?? true;
    const wireguardMTU = this.config.wireguardMTU ?? 1420;
    const bgp = this.config.bgp ?? false;
    const kubeletPath = this.config.kubeletPath;

    // --- Namespace ---

    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // --- Helm (tigera-operator) ---

    const installation: Record<string, unknown> = {
      cni: { type: "Calico" },
      calicoNetwork: {
        bgp: bgp ? "Enabled" : "Disabled",
        ipPools: [
          {
            cidr: podCidr,
            blockSize,
            encapsulation,
            natOutgoing: "Enabled",
          },
        ],
      },
    };
    if (kubeletPath) {
      installation.kubeletVolumePluginPath = kubeletPath;
    }
    const defaultValues: Record<string, unknown> = { installation };

    const chartValues = deepmerge(defaultValues, this.config.values ?? {});

    this.helm = new Helm(this, "helm", {
      chart: "tigera-operator",
      releaseName: "calico",
      repo:
        this.config.repository ?? "https://docs.tigera.io/calico/charts",
      version: this.config.version ?? "v3.29.3",
      helmFlags: ["--include-crds"],
      namespace: namespaceName,
      values: chartValues,
    });

    // --- FelixConfiguration for WireGuard ---

    if (wireguard) {
      new ApiObject(this, "felix-config", {
        apiVersion: "crd.projectcalico.org/v1",
        kind: "FelixConfiguration",
        metadata: {
          name: "default",
          annotations: {
            "argocd.argoproj.io/sync-wave": "5",
          },
        },
        spec: {
          wireguardEnabled: true,
          wireguardEnabledV6: false,
          wireguardMTU,
        },
      });
    }
  }
}
