/**
 * Cilium — CNI with WireGuard encryption, for clusters whose k0s installs no
 * CNI itself (`networkProvider: "custom"`).
 *
 * WHY THIS EXISTS ALONGSIDE THE BUNDLED CALICO. Calico's WireGuard needs an
 * IPAM-allocated tunnel address per node PER FAMILY before that node can join
 * the mesh, and reconciles it with an edge-triggered loop that has no periodic
 * resync (absent in release-v3.31 and master alike). A missed allocation is
 * permanent until calico-node restarts, which is the entire reason the
 * `calico-wg-repair` janitor exists. Cilium has no equivalent concept: the
 * node IP is the endpoint, the pod CIDRs are the AllowedIPs, and CiliumNode
 * carries a public KEY rather than an allocation — verified on a real
 * cross-region cluster, including through an unattended spot reclaim.
 *
 * The CNI is immutable after cluster creation, so adopting this is a cluster
 * REBUILD, never an in-place conversion.
 *
 * The agent is hostNetwork, so it bootstraps onto NotReady nodes with no CNI
 * present — no chicken-and-egg to sequence around.
 *
 * @example
 * ```typescript
 * new Cilium(chart, "cilium", {
 *   ipv6: true,
 *   underlayProtocol: "ipv6", // mandatory cross-region
 *   mtu: 1400,                // the internet path, not the local NIC
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import { HelmModule } from "../../../core";

/**
 * Cilium's WireGuard UDP port — NOT Calico's 51820. A security group that
 * opens the Calico port instead fails silently: the interface comes up, peers
 * are configured, and every handshake is dropped with nothing in the logs.
 */
export const CILIUM_WIREGUARD_PORT = 51871;

/**
 * IPv6's minimum link MTU (RFC 8200). Linux strips IPv6 from any interface
 * below it — see the fail-closed check in the constructor for why that is a
 * one-way door here rather than a warning.
 */
export const IPV6_MIN_MTU = 1280;

export interface CiliumConfig {
  /** Namespace (defaults to kube-system, which is never created here). */
  namespace?: string;
  /** Helm chart version (defaults to 1.20.0 — the version validated live). */
  version?: string;
  /** Helm repository URL. */
  repository?: string;
  /** Dual-stack. Requires the cluster's k0s config to allocate v6 podCIDRs. */
  ipv6?: boolean;
  /**
   * Tunnel MTU, applied to every interface Cilium owns.
   *
   * LEAVING THIS UNSET IS WRONG ON ANY INTERNET-CROSSING MESH. Cilium derives
   * the WireGuard MTU from the local NIC exactly as Calico does — on a 9001
   * jumbo host `cilium_wg0` lands at 8906, sized for a path that does not
   * exist between regions. Set it from the worst path (1400 for a ~1500
   * internet hop), not from what `ip link` reports.
   */
  mtu?: number;
  /**
   * Which family carries the tunnel between nodes.
   *
   * "ipv6" is MANDATORY on a cross-region fleet: private v4 has no inter-region
   * path and the AWS IPv6 GUA is on-link, making it the only mutually
   * reachable node identity. The chart's "auto" picks v4 and the mesh then
   * never forms — silently, since each node believes its own config.
   */
  underlayProtocol?: "auto" | "ipv4" | "ipv6";
  /** Encapsulation (defaults to vxlan). */
  tunnelProtocol?: "vxlan" | "geneve";
  /** WireGuard pod-to-pod encryption (defaults to true). */
  encryption?: boolean;
  /**
   * Also encrypt host-network traffic (defaults to false). Still beta
   * upstream; pod-to-pod is the GA path.
   */
  nodeEncryption?: boolean;
  /**
   * Replace kube-proxy (defaults to false — keep k0s's). Enabling it needs
   * k0s told to skip kube-proxy, which is a separate cluster-spec change.
   */
  kubeProxyReplacement?: boolean;
  /** Operator replicas (defaults to 2; use 1 on a one- or two-node cluster,
   *  where the default sits Pending under its own anti-affinity whenever a
   *  node is being replaced). */
  operatorReplicas?: number;
  /** Additional Helm values, deep-merged over the defaults above. */
  values?: Record<string, unknown>;
}

export class Cilium extends HelmModule<CiliumConfig> {
  public readonly helm: Helm;

  constructor(scope: Construct, id: string, config: CiliumConfig = {}) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? "kube-system";
    const ipv6 = this.config.ipv6 ?? false;
    const mtu = this.config.mtu;

    // Fail closed on a sub-1280 MTU. This is not a preference: Linux removes
    // IPv6 from any interface below the v6 minimum, so the kernel strips it
    // from `cilium_host` and the agent then dies on the missing
    // /proc/sys/net/ipv6/conf/cilium_host/forwarding BEFORE reaching the code
    // that would resize the device. `cilium_host` outlives the pod, so
    // correcting this value does NOT recover the node — the device has to be
    // deleted or the host rebooted. Observed on every agent at mtu 1200.
    if (mtu !== undefined && mtu < IPV6_MIN_MTU) {
      throw new Error(
        `Cilium: mtu ${mtu} is below the IPv6 minimum of ${IPV6_MIN_MTU}. ` +
          "Linux would strip IPv6 from cilium_host and crash-loop every " +
          "agent, and the host device outlives the pod so reverting this " +
          "value does not recover the node.",
      );
    }

    this.helm = this.createHelmRelease({
      namespace,
      chart: "cilium",
      releaseName: "cilium",
      repo: this.config.repository ?? "https://helm.cilium.io",
      version: this.config.version ?? "1.20.0",
      defaultValues: {
        // Consume the podCIDRs k0s already allocates per node rather than
        // letting Cilium carve an independent pool the cluster disagrees with.
        ipam: { mode: "kubernetes" },
        ipv4: { enabled: true },
        ipv6: { enabled: ipv6 },

        // Pod CIDRs are not natively routable between regions, so encapsulate.
        routingMode: "tunnel",
        tunnelProtocol: this.config.tunnelProtocol ?? "vxlan",
        ...(this.config.underlayProtocol
          ? { underlayProtocol: this.config.underlayProtocol }
          : {}),

        encryption: {
          enabled: this.config.encryption ?? true,
          type: "wireguard",
          nodeEncryption: this.config.nodeEncryption ?? false,
        },

        // Helm wants the string, not the boolean.
        kubeProxyReplacement: this.config.kubeProxyReplacement
          ? "true"
          : "false",

        ...(mtu ? { MTU: mtu } : {}),
        ...(this.config.operatorReplicas
          ? { operator: { replicas: this.config.operatorReplicas } }
          : {}),
      },
      values: this.config.values,
    });
  }
}
