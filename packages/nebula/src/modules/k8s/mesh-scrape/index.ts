/**
 * Scrape host-network targets over the WireGuard mesh instead of the public
 * internet.
 *
 * Calico gives each node a `wireguard.cali` / `wg-v6.cali` address from the
 * pod CIDR and publishes it on the Node object. An exporter bound to 0.0.0.0
 * in the host netns answers on it, and pod -> that address is tunnelled. So
 * retargeting the scrape there moves it onto the mesh — without moving the
 * exporter itself off the host network, which node_exporter does not support
 * (/proc/net is netns-scoped, so a pod-network exporter reports its own veth;
 * upstream closed this won't-fix and documents host network as the supported
 * configuration).
 *
 * Requires `attachMetadata: { node: true }` on the monitor so node
 * annotations are available as relabel sources (Prometheus >= 2.37).
 *
 * Fail-visible by construction: a node whose WireGuard never came up has no
 * annotation, the regex does not match, `__address__` stays the discovered
 * address, and the scrape fails -> TargetDown. "WireGuard is broken on node
 * X" becomes an alert rather than a silent fallback to cleartext.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

export type MeshFamily = "IPv6" | "IPv4";

const WG_ADDR_LABEL: Record<MeshFamily, string> = {
  IPv6: "__meta_kubernetes_node_annotation_projectcalico_org_IPv6WireguardInterfaceAddr",
  IPv4: "__meta_kubernetes_node_annotation_projectcalico_org_IPv4WireguardInterfaceAddr",
};

/** Relabeling that retargets `__address__` onto the node's WireGuard mesh
 *  address (default the v6 tunnel; v6 literals are bracketed). */
export const meshAddress = (port: number, family: MeshFamily = "IPv6") => [
  {
    action: "replace",
    sourceLabels: [WG_ADDR_LABEL[family]],
    regex: "(.+)",
    replacement: family === "IPv6" ? `[$1]:${port}` : `$1:${port}`,
    targetLabel: "__address__",
  },
];

/** kube-prometheus-stack's kubelet ServiceMonitor relabels the metrics path
 *  onto a label; preserve that when overriding the endpoint's relabelings. */
export const KEEP_METRICS_PATH = {
  action: "replace",
  sourceLabels: ["__metrics_path__"],
  targetLabel: "metrics_path",
};

/**
 * kube-prometheus-stack values fragment putting the chart-owned host-network
 * monitors (node-exporter, kubelet) on the mesh, and disabling the chart's
 * kube-proxy monitor — its template has no attachMetadata support, so the CR
 * is owned by {@link MeshKubeProxyServiceMonitor} instead.
 */
export function meshMonitorValues(
  family: MeshFamily = "IPv6",
): Record<string, unknown> {
  return {
    "prometheus-node-exporter": {
      prometheus: {
        monitor: {
          attachMetadata: { node: true },
          relabelings: meshAddress(9100, family),
        },
      },
    },
    kubelet: {
      serviceMonitor: {
        attachMetadata: { node: true },
        relabelings: [KEEP_METRICS_PATH, ...meshAddress(10250, family)],
        cAdvisorRelabelings: [KEEP_METRICS_PATH, ...meshAddress(10250, family)],
        probesRelabelings: [KEEP_METRICS_PATH, ...meshAddress(10250, family)],
      },
    },
    kubeProxy: { serviceMonitor: { enabled: false } },
  };
}

export interface MeshKubeProxyServiceMonitorOptions {
  /** monitoring namespace the CR lands in. */
  namespace: string;
  /** metadata.name of the ServiceMonitor. */
  name: string;
  /** kube-prometheus-stack release name (the chart's Service carries it in
   *  its labels; default "prometheus"). */
  releaseName?: string;
  family?: MeshFamily;
}

/**
 * kube-proxy ServiceMonitor, replacing the chart's. Identical to what the
 * chart renders (same selector, namespaceSelector, port and bearer token)
 * plus the attachMetadata + mesh relabeling the template does not support —
 * this is what takes the last plaintext exporter off the public path.
 */
export class MeshKubeProxyServiceMonitor extends Construct {
  constructor(
    scope: Construct,
    id: string,
    options: MeshKubeProxyServiceMonitorOptions,
  ) {
    super(scope, id);
    new ApiObject(this, "servicemonitor", {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: { name: options.name, namespace: options.namespace },
      spec: {
        jobLabel: "jobLabel",
        namespaceSelector: { matchNames: ["kube-system"] },
        selector: {
          matchLabels: {
            app: "kube-prometheus-stack-kube-proxy",
            release: options.releaseName ?? "prometheus",
          },
        },
        attachMetadata: { node: true },
        endpoints: [
          {
            port: "http-metrics",
            bearerTokenFile:
              "/var/run/secrets/kubernetes.io/serviceaccount/token",
            relabelings: meshAddress(10249, options.family ?? "IPv6"),
          },
        ],
      },
    });
  }
}
