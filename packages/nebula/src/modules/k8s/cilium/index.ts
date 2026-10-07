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
 *   // Dual-stack pods, IPv6 underlay and MTU 1400 are enforced by default.
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import { deepmerge } from "deepmerge-ts";
import { HelmModule } from "../../../core";
import { validateCiliumNetwork } from "./network";
import { CiliumNodeIpv6Overrides, type CiliumNodeIpv6OverridesConfig } from "./node-ipv6-overrides";
export type { CiliumNodeIpv6Override, CiliumNodeIpv6OverridesConfig } from "./node-ipv6-overrides";

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
  /**
   * Enable-only compatibility spelling for dual-stack pods. For a retained
   * private IPv4 cluster, use podAddressFamilies: "ipv4" instead.
   */
  ipv6?: true;
  /** Pod address families, default "dual-stack". The explicit "ipv4" profile
   * requires private node connectivity and IPv4 transport. It preserves an
   * existing IPv4 cluster without attempting a control-plane family migration. */
  podAddressFamilies?: "dual-stack" | "ipv4";
  /**
   * Node-to-node reachability, default "public" (internet / cross-VPC).
   * Public meshes require on-link IPv6 node addresses, an IPv6 underlay and
   * MTU <= 1400. AWS EIPs are NAT entrances, not on-link node identities.
   * Use "private" only when EVERY node can route directly to every other
   * node's private address. Pods default to dual-stack in either mode.
   */
  nodeConnectivity?: "public" | "private";
  /** Retained node IPv6 identities, applied through selector-scoped native
   * CiliumNodeConfigs. Installs exact-inventory validating admission and permits
   * only ipv6-node overrides. Requires CiliumNodeConfig CRDs already installed;
   * first-install clusters should publish both NIC addresses through kubelet. */
  nodeIpv6Overrides?: CiliumNodeIpv6OverridesConfig;
  /**
   * Tunnel MTU, applied to every interface Cilium owns.
   *
   * Defaults to 1400 for public meshes, NIC discovery for private meshes.
   * Cilium derives
   * the WireGuard MTU from the local NIC exactly as Calico does — on a 9001
   * jumbo host `cilium_wg0` lands at 8906, sized for a path that does not
   * exist between regions. Public meshes reject MTUs above 1400; all explicit
   * MTUs must be integers >= 1280.
   */
  mtu?: number;
  /**
   * Which family carries the tunnel between nodes.
   *
   * Defaults to "ipv6" for public meshes, "ipv4" for private meshes.
   * "ipv6" is mandatory on a public fleet: private v4 has no inter-region
   * path and the AWS IPv6 GUA is on-link, making it the only mutually
   * reachable node identity. The chart's "auto" picks v4 and the mesh then
   * never forms — silently, since each node believes its own config.
   */
  underlayProtocol?: "ipv4" | "ipv6";
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
   *  Empty disables the metrics server while leaving the observer on.
   *  `port-distribution` is deliberately NOT in the default: it labels by
   *  port, so any node talking to the internet (P2P, crawlers) mints a series
   *  per peer port and grows without bound. */
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
   * annotation is written at agent bootstrap. This module enables the chart's
   * config checksum so changes roll the agents and backfill annotations.
   */
  annotateK8sNode?: boolean;
  /**
   * Additional Helm values, deep-merged before network validation. Disabling
   * either family, replacing Kubernetes IPAM/CNI or bypassing the network
   * contract through extraConfig/extraArgs/extraEnv is rejected.
   */
  values?: Record<string, unknown>;
}

export class Cilium extends HelmModule<CiliumConfig> {
  public readonly helm: Helm;

  constructor(scope: Construct, id: string, config: CiliumConfig = {}) {
    super(scope, id, config);

    const namespace = this.config.namespace ?? "kube-system";
    if (this.config.ipv6 !== undefined && this.config.ipv6 !== true) {
      throw new Error('Cilium: ipv6 cannot be disabled through the legacy flag; use podAddressFamilies "ipv4" with explicit private node connectivity for a retained IPv4 cluster.');
    }
    const nodeConnectivity = this.config.nodeConnectivity ?? "public";
    if (nodeConnectivity !== "public" && nodeConnectivity !== "private") {
      throw new Error('Cilium: nodeConnectivity must be "public" or "private".');
    }
    const podAddressFamilies = this.config.podAddressFamilies ?? "dual-stack";
    if (podAddressFamilies !== "dual-stack" && podAddressFamilies !== "ipv4") {
      throw new Error('Cilium: podAddressFamilies must be "dual-stack" or "ipv4".');
    }
    const enableIpv6 = podAddressFamilies === "dual-stack";
    if (!enableIpv6) {
      if (nodeConnectivity !== "private") {
        throw new Error('Cilium: podAddressFamilies "ipv4" requires explicit nodeConnectivity "private".');
      }
      if (this.config.ipv6 !== undefined || this.config.nodeIpv6Overrides !== undefined) {
        throw new Error('Cilium: podAddressFamilies "ipv4" cannot enable ipv6 or nodeIpv6Overrides.');
      }
    }
    const underlayProtocol = this.config.underlayProtocol ??
      (nodeConnectivity === "public" ? "ipv6" : "ipv4");
    const nodeOverrides = this.config.nodeIpv6Overrides
      ? new CiliumNodeIpv6Overrides(this, "node-ipv6", this.config.nodeIpv6Overrides, namespace, nodeConnectivity)
      : undefined;
    const mtu = this.config.mtu ?? (nodeConnectivity === "public" ? 1400 : undefined);
    const hubble = this.config.hubble ?? false;
    const envoy = this.config.envoy ?? false;
    const metrics = this.config.metrics ?? true;
    const agentServiceMonitor =
      metrics && (this.config.agentServiceMonitor ?? true);
    const operatorServiceMonitor =
      metrics && (this.config.operatorServiceMonitor ?? true);
    const hubbleMetrics =
      this.config.hubbleMetrics ?? (hubble ? ["dns", "drop", "tcp", "flow", "icmp"] : []);

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

    const values: Record<string, unknown> = deepmerge(
      {
        // Consume the podCIDRs k0s already allocates per node rather than
        // letting Cilium carve an independent pool the cluster disagrees with.
        ipam: { mode: "kubernetes" },
        ipv4: { enabled: true },
        ipv6: { enabled: enableIpv6 },
        // Wait for every enabled family. Enabling IPv6 cannot itself convert
        // the control plane or existing pod sandboxes to dual-stack.
        k8s: { requireIPv4PodCIDR: true, requireIPv6PodCIDR: enableIpv6 },
        cni: { install: true, exclusive: true, customConf: false, chainingMode: "none" },
        // Otherwise a CiliumNodeConfig can silently undo the cluster contract.
        daemon: nodeOverrides
          ? { configSources: nodeOverrides.configSources, allowedConfigOverrides: "ipv6-node" }
          : { configSources: "config-map:cilium-config" },
        agent: true,
        sleepAfterInit: false,
        // ConfigMap edits alone do not restart agents. Reconcile the running
        // agent configuration whenever the rendered network settings change.
        rollOutCiliumPods: true,

        // Pod CIDRs are not natively routable between regions, so encapsulate.
        routingMode: "tunnel",
        tunnelProtocol: this.config.tunnelProtocol ?? "vxlan",
        underlayProtocol,
        preferIpv6: underlayProtocol === "ipv6",

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

        ...(mtu !== undefined ? { MTU: mtu } : {}),

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
      this.config.values ?? {},
    );
    if (nodeOverrides) {
      if (values.podAnnotations !== undefined && (values.podAnnotations === null ||
          typeof values.podAnnotations !== "object" || Array.isArray(values.podAnnotations))) {
        throw new Error("Cilium: values.podAnnotations must be an object.");
      }
      values.podAnnotations = {
        ...((values.podAnnotations ?? {}) as Record<string, string>),
        "nebula.sh/cilium-node-ipv6-checksum": nodeOverrides.checksum,
      };
    }
    validateCiliumNetwork(values, nodeConnectivity, nodeOverrides?.configSources, podAddressFamilies);
    this.helm = this.createHelmRelease({
      namespace,
      chart: "cilium",
      releaseName: "cilium",
      repo: this.config.repository ?? "https://helm.cilium.io",
      version: this.config.version ?? "1.20.0",
      defaultValues: values,
    });
  }
}
