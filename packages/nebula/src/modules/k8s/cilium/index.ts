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
  /**
   * Connectivity health checking (defaults to true, as the chart does).
   *
   * Set FALSE where the probe cannot be made to work. cilium-health checks
   * each peer with unauthenticated HTTP on 4240 plus ICMP, which on a fleet
   * whose peers reach each other ACROSS THE PUBLIC INTERNET would mean opening
   * both to 0.0.0.0/0 — and the node security-group posture there is that
   * cryptographically authenticated protocols are open and unauthenticated
   * ones are not exposed at all. Leaving the probe closed but enabled is the
   * worst option: cluster health reads 1/N forever, and a permanently-yellow
   * number is one nobody reads when it finally turns red.
   */
  healthChecking?: boolean;
  /**
   * Prometheus metrics: agent on 9962, operator on 9963 (defaults to TRUE —
   * the chart defaults the agent's endpoint off, which leaves the dataplane
   * with no telemetry at all).
   */
  metrics?: boolean;
  /**
   * Chart-owned ServiceMonitor for the AGENT and for Hubble (defaults to true).
   *
   * Both are served by the hostNetwork agent, so where the node's ports are not
   * reachable from the scraper the address has to be rewritten onto the mesh —
   * and the chart's templates expose `relabelings` but not `attachMetadata`,
   * without which the node annotation carrying that address is not a relabel
   * source. Set false there and own the CRs with mesh-scrape's
   * `MeshServiceMonitor`.
   */
  agentServiceMonitor?: boolean;
  /**
   * Chart-owned ServiceMonitor for the OPERATOR (defaults to true).
   *
   * The operator is hostNetwork too (`operator.hostNetwork` is a chart default,
   * so it can reach the API server before the CNI is up), which means its 9963
   * is behind the same closed node port as the agent's 9962 and it needs the
   * same treatment. Measured, not assumed: with the chart's monitor only the
   * replica sharing a node with Prometheus came up.
   */
  operatorServiceMonitor?: boolean;
  /**
   * Hubble observability (defaults to FALSE — the chart defaults it on).
   *
   * The chart's `helm` TLS method generates `cilium-ca` and
   * `hubble-server-certs` with FRESH random material on every render: under
   * GitOps that is a diff on every sync, permanently OutOfSync, and each sync
   * rotates the CA out from under the running agents. {@link hubbleTlsMethod}
   * therefore defaults to `cronJob` and does not offer `helm` at all.
   */
  hubble?: boolean;
  /** Hubble metrics to export on 9965 (defaults to a flow/drop/dns/tcp set).
   *  Empty disables the metrics server while leaving the observer on. */
  hubbleMetrics?: string[];
  /** hubble-relay, the cluster-wide flow aggregation API (defaults to false —
   *  it is what `hubble observe` and the UI talk to, and neither is deployed
   *  here; the metrics path does not need it). */
  hubbleRelay?: boolean;
  /** How Hubble's server certificates are produced (defaults to `cronJob`).
   *  `helm` is not offered — see {@link hubble}. `certmanager` additionally
   *  requires {@link hubbleTlsIssuerRef}; the chart fails the render without
   *  it. */
  hubbleTlsMethod?: "cronJob" | "certmanager";
  /** Issuer for `hubbleTlsMethod: "certmanager"`, e.g.
   *  `{ name: "cilium-ca", kind: "Issuer", group: "cert-manager.io" }`. */
  hubbleTlsIssuerRef?: Record<string, unknown>;
  /**
   * Run Envoy as its own DaemonSet (defaults to FALSE — the chart defaults it
   * on). It exists for L7 policy, ingress and TLS interception, all of which
   * need their own opt-in; without them it is a per-node pod doing nothing.
   */
  envoy?: boolean;
  /**
   * Publish Cilium's node metadata as k8s Node annotations (defaults to TRUE;
   * the chart defaults it off).
   *
   * `network.cilium.io/ipv{4,6}-cilium-host` is the only place a Prometheus
   * scrape can learn the node's cilium_host address — the address lives on the
   * CiliumNode CR, which service discovery cannot read. That address is what
   * makes host-network exporters reachable at all where the node security group
   * does not open their ports: it sits in the pod CIDR, so pod -> it is
   * encapsulated and encrypted like any pod traffic. See the mesh-scrape
   * module.
   *
   * The chart grants the matching `nodes/status: patch` RBAC itself. The
   * annotation is written at agent bootstrap and the chart puts no config
   * checksum on the DaemonSet, so flipping this does not backfill onto running
   * agents — they have to be restarted.
   */
  annotateK8sNode?: boolean;
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
    const hubble = this.config.hubble ?? false;
    const envoy = this.config.envoy ?? false;
    const metrics = this.config.metrics ?? true;
    const agentServiceMonitor =
      metrics && (this.config.agentServiceMonitor ?? true);
    const operatorServiceMonitor =
      metrics && (this.config.operatorServiceMonitor ?? true);
    const hubbleMetrics =
      this.config.hubbleMetrics ??
      (hubble ? ["dns", "drop", "tcp", "flow", "port-distribution", "icmp"] : []);

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

        annotateK8sNode: this.config.annotateK8sNode ?? true,

        ...(mtu ? { MTU: mtu } : {}),

        ...(this.config.healthChecking === false
          ? { healthChecking: false }
          : {}),

        // `trustCRDsExist` is not optimism — the chart's validate.yaml does an
        // API lookup for the ServiceMonitor CRD and hard-fails the render when
        // it cannot reach a cluster, which is every GitOps render. It reads the
        // AGENT's copy of the flag no matter which monitor tripped the check,
        // so it is set unconditionally: gating it on the agent monitor breaks
        // exactly the config that turns the agent monitor off and keeps the
        // operator's.
        //
        // `metricsService` is what renders the Service that carries the
        // `metrics` port. The chart gates that Service on
        // `serviceMonitor.enabled OR metricsService`, so turning the chart's
        // monitor off to own it elsewhere also removes the port the owned
        // monitor selects — the agent Service survives with only
        // `envoy-metrics` on it and the replacement monitor matches nothing.
        prometheus: {
          enabled: metrics,
          metricsService: metrics,
          serviceMonitor: { enabled: agentServiceMonitor, trustCRDsExist: true },
        },
        operator: {
          ...(this.config.operatorReplicas
            ? { replicas: this.config.operatorReplicas }
            : {}),
          prometheus: {
            enabled: metrics,
            metricsService: metrics,
            serviceMonitor: { enabled: operatorServiceMonitor },
          },
        },

        hubble: {
          enabled: hubble,
          relay: { enabled: this.config.hubbleRelay ?? false },
          ...(hubble
            ? {
                tls: {
                  auto: {
                    method: this.config.hubbleTlsMethod ?? "cronJob",
                    ...(this.config.hubbleTlsIssuerRef
                      ? { certManagerIssuerRef: this.config.hubbleTlsIssuerRef }
                      : {}),
                  },
                },
                metrics: {
                  enabled: hubbleMetrics,
                  serviceMonitor: {
                    enabled: agentServiceMonitor && hubbleMetrics.length > 0,
                    trustCRDsExist: true,
                  },
                },
              }
            : {}),
        },
        envoy: { enabled: envoy },

        // With Envoy off there is no TLS interception, so the chart's dedicated
        // `cilium-secrets` namespace has nothing to hold — point the RBAC at
        // kube-system and stop creating it.
        //
        // This is not only tidiness. ArgoCD v3.3.0 PANICS mid-sync on an
        // application that introduces a namespace which does not exist yet
        // ("Recovered from panic: runtime error: invalid memory address or nil
        // pointer dereference" in the resources filter), leaving the app stuck
        // at OperationState Error with nothing applied. Observed installing
        // this chart on a live cluster.
        ...(envoy
          ? {}
          : { tls: { secretsNamespace: { create: false, name: namespace } } }),
      },
      values: this.config.values,
    });
  }
}
