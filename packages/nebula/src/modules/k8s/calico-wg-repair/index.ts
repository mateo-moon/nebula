/**
 * INTERIM repair + visibility for Calico's missing WireGuard tunnel address.
 *
 * Calico's WireGuard needs an IPAM-allocated tunnel address per node PER
 * FAMILY (`projectcalico.org/IPv4WireguardInterfaceAddr` and its IPv6 twin)
 * before that node can carry mesh traffic. The allocator (`allocateip`) is
 * edge-triggered off a cache of the node's public keys and has NO periodic
 * resync — verified absent in both `release-v3.31` and `master`. A missed
 * allocation is therefore PERMANENT until calico-node restarts, and every pod
 * on that node is unreachable over the mesh in the affected family: scrapes
 * fail, cross-region pod traffic blackholes, TargetDown by the fistful.
 *
 * This bounces calico-node on an affected node, which is the known workaround
 * and is entirely mechanical.
 *
 * WHY BOTH FAMILIES. This started as a v6-only repair on the assumption that
 * calico#10883 (in v3.31.0) had closed the class. It did not — it only widened
 * the allocator's cache from the v4 key to both keys, which fixes the trigger
 * MISS in a v6-only deployment while leaving the no-resync design untouched.
 * Measured on v3.31.4-2: 3 of 9 stage nodes and 1 of 4 cicd nodes were sitting
 * without their **v4** address, entirely invisible to a v6-only check.
 *
 * REMOVE THIS when `allocateip` grows a periodic resync upstream — not on
 * version math. That mistake has already been made once here.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

/** WireGuard address family, as Calico names its per-family annotation. */
export type CalicoWgFamily = "v4" | "v6";

export interface CalicoWgRepairConfig {
  /** Namespace for the CronJob + ServiceAccount (default "kube-system"). */
  namespace?: string;
  /** How often to look (default every 5 minutes). */
  schedule?: string;
  /**
   * Which families the mesh actually runs. Default BOTH — but see the
   * runtime guard below: a family no node has an address for is skipped
   * regardless, so getting this wrong cannot turn the job into a fleet-wide
   * calico-node restarter.
   */
  families?: CalicoWgFamily[];
  /**
   * kubectl image used by the job. Must carry a POSIX shell; the script uses
   * nothing else (no python, no jq) so any kubectl image will do.
   */
  image?: string;
}

const ANNOTATION: Record<CalicoWgFamily, string> = {
  v4: "IPv4WireguardInterfaceAddr",
  v6: "IPv6WireguardInterfaceAddr",
};

// Every call is bounded. activeDeadlineSeconds is a WALL-CLOCK limit that no
// podFailurePolicy can exempt, so one hung API call fails the whole Job with
// DeadlineExceeded — and because failedJobsHistoryLimit retains the object,
// kube_job_failed stays > 0 and KubeJobFailed never clears on its own.
// Observed live 2026-08-04: two DeadlineExceeded failures on a job whose real
// work takes three seconds, while stage's apiserver was returning 504s on
// leases and node patches. A request timeout turns that into a fast, retried
// failure instead of a 5-minute stall.
const KUBECTL = "kubectl --request-timeout=30s";

function script(families: CalicoWgFamily[]): string {
  return `set -eu
for FAM in ${families.join(" ")}; do
  case "$FAM" in
    v4) ANN=${ANNOTATION.v4} ;;
    v6) ANN=${ANNOTATION.v6} ;;
    *) echo "unknown family $FAM"; exit 1 ;;
  esac
  READY=$(${KUBECTL} get nodes --no-headers -o \\
    "custom-columns=N:.metadata.name,W:.metadata.annotations.projectcalico\\.org/$ANN,R:.status.conditions[?(@.type=='Ready')].status" \\
    | awk '$3 == "True" { print $1, $2 }')
  [ -z "$READY" ] && { echo "$FAM: no Ready nodes"; continue; }

  # THE FLEET-WIDE-BOUNCE GUARD. If not one Ready node holds an address for
  # this family, the family is not enabled on this cluster (or something
  # systemic is wrong) — and in either case restarting every calico-node in
  # the fleet every five minutes, forever, is the wrong response.
  HAVE=$(echo "$READY" | awk '$2 != "<none>"' | wc -l | tr -d ' ')
  [ "$HAVE" = "0" ] && { echo "$FAM: no node has an address — family not in use, skipping"; continue; }

  BAD=$(echo "$READY" | awk '$2 == "<none>" { print $1 }')
  [ -z "$BAD" ] && { echo "$FAM: all Ready nodes have an address"; continue; }
  for NODE in $BAD; do
    POD=$(${KUBECTL} get pods -n kube-system -l k8s-app=calico-node \\
      --field-selector "spec.nodeName=$NODE" -o name)
    [ -z "$POD" ] && { echo "$FAM: no calico-node pod on $NODE yet"; continue; }
    echo "$FAM address missing on $NODE — restarting $POD (calico allocateip has no resync)"
    ${KUBECTL} delete "$POD" -n kube-system --wait=false
  done
done
`;
}

/**
 * kube-prometheus-stack values fragment publishing each node's Calico
 * WireGuard addresses as label values, so the CONDITION is visible rather
 * than only its repair.
 *
 * Deep-merge under the chart's `values` (the `"kube-state-metrics"` top-level
 * key is included). No extra RBAC: ksm's default ClusterRole already lists and
 * watches nodes.
 *
 * MERGE WITH CARE alongside {@link kubeStateMetricsValues}: both write
 * `customResourceState.config.spec.resources`, so the combining merge must
 * CONCATENATE arrays (deepmerge-ts does; a shallow spread does not, and the
 * loser's metrics vanish silently).
 *
 * Yields `kube_customresource_calico_wireguard_addr{node,v4,v6}`, with the
 * label EMPTY for a family whose annotation is absent — which is what
 * {@link CalicoWgRepairAlerts} keys on.
 */
export function calicoWireguardKsmValues(): object {
  return {
    "kube-state-metrics": {
      customResourceState: {
        enabled: true,
        config: {
          spec: {
            resources: [
              {
                groupVersionKind: { group: "", version: "v1", kind: "Node" },
                labelsFromPath: { node: ["metadata", "name"] },
                metrics: [
                  {
                    name: "calico_wireguard_addr",
                    help: "Calico WireGuard tunnel address per family (label empty when the annotation is absent — that node carries no mesh traffic in that family)",
                    each: {
                      type: "Info",
                      info: {
                        path: ["metadata", "annotations"],
                        labelsFromPath: {
                          v4: [`projectcalico.org/${ANNOTATION.v4}`],
                          v6: [`projectcalico.org/${ANNOTATION.v6}`],
                        },
                      },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

export interface CalicoWgRepairAlertsOptions {
  /** Namespace the PrometheusRule lands in (the monitoring namespace). */
  namespace: string;
  /** Families to alert on (default both). */
  families?: CalicoWgFamily[];
  /**
   * Grace period before paging (default "15m"). Must outlast a node
   * replacement: a freshly-joined node legitimately has no address for the
   * seconds before Felix allocates one, and the repair job itself runs every
   * five minutes.
   */
  missingFor?: string;
}

/**
 * Alert on the condition, not on its repair.
 *
 * The repair job fixes nodes silently, so a cluster can sit in a permanent
 * bounce-repair-bounce loop — or, worse, hit a case the job cannot fix — with
 * nothing to show for it. This fires on the underlying state, so a node that
 * keeps losing its address is visible as such.
 *
 * Requires {@link calicoWireguardKsmValues} on the ksm that feeds this
 * Prometheus.
 */
export class CalicoWgRepairAlerts extends Construct {
  constructor(scope: Construct, id: string, options: CalicoWgRepairAlertsOptions) {
    super(scope, id);
    const families = options.families ?? ["v4", "v6"];
    const forDuration = options.missingFor ?? "15m";

    new ApiObject(this, "rule", {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PrometheusRule",
      metadata: { name: "calico-wireguard", namespace: options.namespace },
      spec: {
        groups: [
          {
            name: "calico-wireguard",
            rules: families.map((fam) => ({
              alert: `CalicoWireguardAddrMissing${fam.toUpperCase()}`,
              // The second half is the same fleet-wide sanity check the repair
              // job makes: with the family disabled every node reports an
              // empty label, and alerting on that would page forever.
              //
              // `by (cluster)` is NOT cosmetic. These series reach the hub by
              // remote write from every spoke, so an unaggregated count mixes
              // clusters — and the guard would then be satisfied by a DIFFERENT
              // cluster having addresses, hiding a whole cluster with none.
              expr:
                `count by (cluster) (kube_customresource_calico_wireguard_addr{${fam}=""}) > 0` +
                ` and count by (cluster) (kube_customresource_calico_wireguard_addr{${fam}!=""}) > 0`,
              for: forDuration,
              labels: { severity: "warning" },
              annotations: {
                summary: `Calico has no ${fam} WireGuard address on {{ $value }} node(s) in {{ $labels.cluster }}`,
                description:
                  `Those nodes carry no mesh traffic over ${fam}: pod-to-pod blackholes and scrapes fail. ` +
                  "Calico's allocateip is edge-triggered with no resync, so this does not self-heal — " +
                  "calico-wg-repair should be bouncing calico-node there; if this alert persists, it is not working.",
              },
            })),
          },
        ],
      },
    });
  }
}

export class CalicoWgRepair extends Construct {
  constructor(scope: Construct, id: string, config: CalicoWgRepairConfig = {}) {
    super(scope, id);
    const ns = config.namespace ?? "kube-system";
    const name = "calico-wg-repair";
    const families = config.families ?? ["v4", "v6"];

    if (families.length === 0) {
      throw new Error("CalicoWgRepair: `families` must not be empty");
    }

    new ApiObject(this, "sa", {
      apiVersion: "v1",
      kind: "ServiceAccount",
      metadata: { name, namespace: ns },
    });
    new ApiObject(this, "role", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: { name },
      rules: [
        { apiGroups: [""], resources: ["nodes"], verbs: ["get", "list"] },
        { apiGroups: [""], resources: ["pods"], verbs: ["get", "list"] },
        // delete is scoped to pods; the script only ever targets calico-node.
        { apiGroups: [""], resources: ["pods"], verbs: ["delete"] },
      ],
    });
    new ApiObject(this, "binding", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRoleBinding",
      metadata: { name },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name },
      subjects: [{ kind: "ServiceAccount", name, namespace: ns }],
    });
    new ApiObject(this, "cronjob", {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name, namespace: ns },
      spec: {
        schedule: config.schedule ?? "*/5 * * * *",
        concurrencyPolicy: "Forbid",
        successfulJobsHistoryLimit: 1,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            backoffLimit: 3,
            activeDeadlineSeconds: 300,
            // A pod evicted because its NODE went away is not a failed run.
            // This job exists to react to node replacement, so it is running
            // precisely when nodes are being drained — and with backoffLimit 1
            // a single eviction burned the only retry and the deadline
            // finished it off. The result was a KubeJobFailed for a job whose
            // actual work takes three seconds, and because the failed Job is
            // RETAINED by failedJobsHistoryLimit, kube_job_failed stays > 0 and
            // the alert never clears on its own. Observed live 2026-08-04: two
            // spot reclaims produced three permanent alerts.
            podFailurePolicy: {
              rules: [
                {
                  action: "Ignore",
                  onPodConditions: [{ type: "DisruptionTarget" }],
                },
              ],
            },
            template: {
              spec: {
                serviceAccountName: name,
                restartPolicy: "Never",
                // Must run where the mesh is already healthy, and must
                // tolerate the workload taints to be schedulable at all.
                tolerations: [{ operator: "Exists" }],
                containers: [
                  {
                    name: "repair",
                    image: config.image ?? "alpine/kubectl:1.34.2",
                    command: ["sh", "-c", script(families)],
                    resources: {
                      requests: { cpu: "10m", memory: "32Mi" },
                      limits: { memory: "128Mi" },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });
  }
}
