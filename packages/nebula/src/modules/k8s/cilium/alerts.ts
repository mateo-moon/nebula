/**
 * Alert rules for a Cilium dataplane, written to be evaluated wherever the
 * agents' series end up: on the cluster itself or on a central Prometheus that
 * receives them by remote write. The cluster and node labels come from the series.
 *
 * Use as one entry of kube-prometheus-stack's additionalPrometheusRulesMap.
 */
export function ciliumAlertRules(): { groups: unknown[] } {
  return {
    groups: [
      {
        name: "cilium",
        rules: [
          {
            alert: "CiliumAgentDown",
            expr: 'kube_daemonset_status_number_unavailable{daemonset="cilium"} > 0',
            for: "10m",
            labels: { severity: "critical", component: "cni" },
            annotations: {
              summary: "cilium agent unavailable on {{ $labels.cluster }}",
              description:
                "{{ $value }} cilium agent(s) unavailable in cluster {{ $labels.cluster }} for 10 minutes. A node without an agent keeps its existing eBPF datapath but gets no policy or endpoint updates, and new pods on it will not get networking.",
            },
          },
          {
            // The Calico analogue was a missing WireGuard tunnel address.
            // Cilium has no allocation to miss, so the equivalent signal is
            // the health probe: a node that stops answering has fallen out
            // of the mesh.
            //
            // Where nodes have no private path to each other (regions joined
            // only over the mesh) the NODE half of the probe is expected to be
            // non-zero, so the alert is on health ENDPOINTS, the datapath signal.
            alert: "CiliumUnreachableHealthEndpoints",
            expr: "cilium_unreachable_health_endpoints > 0",
            for: "15m",
            labels: { severity: "warning", component: "cni" },
            annotations: {
              summary: "cilium cannot reach {{ $value }} health endpoint(s) on {{ $labels.cluster }}",
              description:
                "Agent {{ $labels.node }} in cluster {{ $labels.cluster }} has been unable to reach {{ $value }} peer health endpoint(s) for 15 minutes. Pod-to-pod traffic to those nodes is affected — check `cilium-health status` and the WireGuard peer count.",
            },
          },
          {
            alert: "CiliumEndpointsNotReady",
            expr: 'sum by (cluster, node) (cilium_endpoint_state{endpoint_state!="ready"}) > 0',
            for: "15m",
            labels: { severity: "warning", component: "cni" },
            annotations: {
              summary: "cilium endpoints not ready on {{ $labels.node }}",
              description:
                "{{ $value }} endpoint(s) on node {{ $labels.node }} ({{ $labels.cluster }}) have been out of the ready state for 15 minutes — usually a regeneration that is failing rather than slow.",
            },
          },
          {
            // Rate, not count: drops are normal (policy denies, unknown
            // destinations). A sustained step change is the signal.
            alert: "CiliumHighDropRate",
            expr: "sum by (cluster, reason) (rate(cilium_drop_count_total[5m])) > 50",
            for: "15m",
            labels: { severity: "warning", component: "cni" },
            annotations: {
              summary: "cilium dropping {{ $value | humanize }} pkt/s ({{ $labels.reason }}) on {{ $labels.cluster }}",
              description:
                "Sustained packet drops in cluster {{ $labels.cluster }} with reason {{ $labels.reason }}. Check whether it correlates with a node roll or a policy change.",
            },
          },
          {
            // The eBPF maps are fixed-size. Past ~90% full, inserts start
            // failing and the failure surfaces as unexplained connectivity
            // loss rather than as an error.
            alert: "CiliumBpfMapPressure",
            expr: "cilium_bpf_map_pressure > 0.9",
            for: "10m",
            labels: { severity: "warning", component: "cni" },
            annotations: {
              summary: "cilium BPF map {{ $labels.map_name }} at {{ $value | humanizePercentage }} on {{ $labels.node }}",
              description:
                "BPF map {{ $labels.map_name }} on node {{ $labels.node }} ({{ $labels.cluster }}) is nearly full. Inserts fail silently once it is, which presents as connectivity loss with no error.",
            },
          },
          {
            alert: "CiliumPolicyImportErrors",
            expr: "rate(cilium_policy_import_errors_total[10m]) > 0",
            for: "10m",
            labels: { severity: "warning", component: "cni" },
            annotations: {
              summary: "cilium failing to import policy on {{ $labels.cluster }}",
              description:
                "Agent on {{ $labels.node }} ({{ $labels.cluster }}) is rejecting policy updates, so the enforced policy has drifted from what is declared.",
            },
          },
        ],
      },
    ],
  };
}
