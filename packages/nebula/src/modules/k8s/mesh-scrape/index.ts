/**
 * Scrape host-network targets over the encrypted CNI mesh instead of the
 * public internet.
 *
 * Both supported CNIs give each node a host-netns address out of the pod CIDR.
 * An exporter bound to 0.0.0.0 in the host netns answers on it, and pod -> that
 * address is encapsulated and encrypted, so retargeting the scrape there moves
 * it onto the mesh — without moving the exporter itself off the host network,
 * which node_exporter does not support (/proc/net is netns-scoped, so a
 * pod-network exporter reports its own veth; upstream closed this won't-fix and
 * documents host network as the supported configuration).
 *
 * - Calico: the `wireguard.cali` / `wg-v6.cali` tunnel address, IPAM-allocated
 *   per node per family.
 * - Cilium: the `cilium_host` router address. NOT a tunnel address — it is
 *   created by the agent at start rather than allocated, so the missing-address
 *   failure class Calico has (edge-triggered allocator, no resync) is absent.
 *   Reaching it needs no security-group rule the mesh does not already have:
 *   the wire packet is the WireGuard UDP the peers already exchange.
 *
 * Cilium only publishes the address on the k8s Node when the agent is run with
 * `annotateK8sNode: true` — nebula's Cilium module defaults it on for exactly
 * this reason. The annotation is written at agent bootstrap, so enabling it
 * does not backfill onto running agents.
 *
 * Requires `attachMetadata: { node: true }` on the monitor so node
 * annotations are available as relabel sources (Prometheus >= 2.37).
 *
 * Fail-visible by construction: a node with no annotation does not match the
 * regex, `__address__` stays the discovered address, and the scrape fails ->
 * TargetDown. "the mesh is broken on node X" becomes an alert rather than a
 * silent fallback to cleartext.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

export type MeshFamily = "IPv6" | "IPv4";
export type MeshCni = "calico" | "cilium";

/** Which node annotation carries the mesh address. */
export interface MeshTarget {
  /** Address family (defaults to IPv6). */
  family?: MeshFamily;
  /** CNI publishing the address (defaults to calico). */
  cni?: MeshCni;
}

const MESH_ADDR_LABEL: Record<MeshCni, Record<MeshFamily, string>> = {
  calico: {
    IPv6: "__meta_kubernetes_node_annotation_projectcalico_org_IPv6WireguardInterfaceAddr",
    IPv4: "__meta_kubernetes_node_annotation_projectcalico_org_IPv4WireguardInterfaceAddr",
  },
  cilium: {
    IPv6: "__meta_kubernetes_node_annotation_network_cilium_io_ipv6_cilium_host",
    IPv4: "__meta_kubernetes_node_annotation_network_cilium_io_ipv4_cilium_host",
  },
};

/** Relabeling that retargets `__address__` onto the node's mesh address
 *  (default the Calico v6 tunnel; v6 literals are bracketed). */
export const meshAddress = (port: number, target: MeshTarget = {}) => {
  const family = target.family ?? "IPv6";
  return [
    {
      action: "replace",
      sourceLabels: [MESH_ADDR_LABEL[target.cni ?? "calico"][family]],
      regex: "(.+)",
      replacement: family === "IPv6" ? `[$1]:${port}` : `$1:${port}`,
      targetLabel: "__address__",
    },
  ];
};

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
  target: MeshTarget = {},
): Record<string, unknown> {
  return {
    "prometheus-node-exporter": {
      prometheus: {
        monitor: {
          attachMetadata: { node: true },
          relabelings: meshAddress(9100, target),
        },
      },
    },
    kubelet: {
      serviceMonitor: {
        attachMetadata: { node: true },
        relabelings: [KEEP_METRICS_PATH, ...meshAddress(10250, target)],
        cAdvisorRelabelings: [KEEP_METRICS_PATH, ...meshAddress(10250, target)],
        probesRelabelings: [KEEP_METRICS_PATH, ...meshAddress(10250, target)],
      },
    },
    kubeProxy: { serviceMonitor: { enabled: false } },
  };
}

export interface MeshServiceMonitorOptions extends MeshTarget {
  /** Namespace the CR lands in. */
  namespace: string;
  /** metadata.name of the ServiceMonitor. */
  name: string;
  /** Labels selecting the Service whose endpoints are the host-network pods. */
  selector: Record<string, string>;
  /** Namespaces to search for that Service (default: the CR's own). */
  serviceNamespaces?: string[];
  /** Endpoint port NAME on the Service. */
  port: string;
  /** Port the exporter listens on in the host netns — what the mesh address is
   *  rewritten to. Usually the Service's targetPort, not its port. */
  targetPort: number;
  path?: string;
  scheme?: string;
  interval?: string;
  honorLabels?: boolean;
  bearerTokenFile?: string;
  jobLabel?: string;
  targetLabels?: string[];
  /** Relabelings applied BEFORE the address rewrite. */
  relabelings?: unknown[];
}

/**
 * A ServiceMonitor for a host-network exporter, scraped at the node's mesh
 * address.
 *
 * Exists because `attachMetadata` is what makes node annotations available as
 * relabel sources, and almost no upstream chart exposes it — kube-prometheus-
 * stack's kube-proxy template and Cilium's own agent/Hubble templates all offer
 * `relabelings` but not `attachMetadata`, which makes their monitors unusable
 * here. Disable the chart's monitor and own the CR with this instead.
 */
export class MeshServiceMonitor extends Construct {
  constructor(
    scope: Construct,
    id: string,
    options: MeshServiceMonitorOptions,
  ) {
    super(scope, id);
    new ApiObject(this, "servicemonitor", {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: { name: options.name, namespace: options.namespace },
      spec: {
        ...(options.jobLabel ? { jobLabel: options.jobLabel } : {}),
        ...(options.targetLabels ? { targetLabels: options.targetLabels } : {}),
        namespaceSelector: {
          matchNames: options.serviceNamespaces ?? [options.namespace],
        },
        selector: { matchLabels: options.selector },
        attachMetadata: { node: true },
        endpoints: [
          {
            port: options.port,
            ...(options.path ? { path: options.path } : {}),
            ...(options.scheme ? { scheme: options.scheme } : {}),
            ...(options.interval ? { interval: options.interval } : {}),
            ...(options.honorLabels ? { honorLabels: true } : {}),
            ...(options.bearerTokenFile
              ? { bearerTokenFile: options.bearerTokenFile }
              : {}),
            relabelings: [
              ...(options.relabelings ?? []),
              ...meshAddress(options.targetPort, options),
            ],
          },
        ],
      },
    });
  }
}

/** Copy the pod's node name onto a `node` label — what Cilium's own chart
 *  monitors do, and what its dashboards select on. */
export const NODE_FROM_POD = {
  action: "replace",
  replacement: "${1}",
  sourceLabels: ["__meta_kubernetes_pod_node_name"],
  targetLabel: "node",
};

export interface MeshKubeProxyServiceMonitorOptions extends MeshTarget {
  /** monitoring namespace the CR lands in. */
  namespace: string;
  /** metadata.name of the ServiceMonitor. */
  name: string;
  /** kube-prometheus-stack release name (the chart's Service carries it in
   *  its labels; default "prometheus"). */
  releaseName?: string;
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
            relabelings: meshAddress(10249, options),
          },
        ],
      },
    });
  }
}
