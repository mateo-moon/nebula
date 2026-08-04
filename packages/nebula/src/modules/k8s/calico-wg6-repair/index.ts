/**
 * INTERIM repair for calico#10599: a node that joins after a replacement can
 * come up without its `projectcalico.org/IPv6WireguardInterfaceAddr`. Felix
 * never allocates one on its own, so every pod on that node is unreachable
 * over the WG-v6 mesh — scrapes fail, cross-region pod traffic blackholes,
 * and the operator sees a fistful of TargetDown alerts (observed on six
 * separate node replacements: five during a fleet conversion, then once per
 * spot reclaim). Restarting calico-node on the affected node is the known
 * workaround, and it is entirely mechanical — which is what this automates.
 *
 * REMOVE THIS when the cluster's k0s bundles calico >= 3.31.0 (the release
 * carrying the fix, calico#10883). Pinning newer calico IMAGES does not
 * work: k0s applies calico's CRDs and RBAC from its own bundled version, so
 * a newer felix resyncs against CRDs that were never created and never
 * becomes ready. The real fix is a k0s upgrade.
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

export interface CalicoWg6RepairConfig {
  /** Namespace for the CronJob + ServiceAccount (default "kube-system"). */
  namespace?: string;
  /** How often to look (default every 5 minutes). */
  schedule?: string;
  /**
   * kubectl image used by the job. Must carry a POSIX shell; the script uses
   * nothing else (no python, no jq) so any kubectl image will do.
   */
  image?: string;
}

// Every call is bounded. activeDeadlineSeconds is a WALL-CLOCK limit that no
// podFailurePolicy can exempt, so one hung API call fails the whole Job with
// DeadlineExceeded — and because failedJobsHistoryLimit retains the object,
// kube_job_failed stays > 0 and KubeJobFailed never clears on its own.
// Observed live 2026-08-04: two DeadlineExceeded failures on a job whose real
// work takes three seconds, while stage's apiserver was returning 504s on
// leases and node patches. A request timeout turns that into a fast, retried
// failure instead of a 5-minute stall.
const KUBECTL = "kubectl --request-timeout=30s";

const SCRIPT = `set -eu
BAD=$(${KUBECTL} get nodes --no-headers -o \\
  'custom-columns=N:.metadata.name,W:.metadata.annotations.projectcalico\\.org/IPv6WireguardInterfaceAddr,R:.status.conditions[?(@.type=="Ready")].status' \\
  | awk '$2 == "<none>" && $3 == "True" { print $1 }')
[ -z "$BAD" ] && { echo "all Ready nodes have a wg6 address"; exit 0; }
for NODE in $BAD; do
  POD=$(${KUBECTL} get pods -n kube-system -l k8s-app=calico-node \\
    --field-selector "spec.nodeName=$NODE" -o name)
  [ -z "$POD" ] && { echo "no calico-node pod on $NODE yet"; continue; }
  echo "wg6 missing on $NODE — restarting $POD (calico#10599 workaround)"
  ${KUBECTL} delete "$POD" -n kube-system --wait=false
done
`;

export class CalicoWg6Repair extends Construct {
  constructor(scope: Construct, id: string, config: CalicoWg6RepairConfig = {}) {
    super(scope, id);
    const ns = config.namespace ?? "kube-system";
    const name = "calico-wg6-repair";

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
                    command: ["sh", "-c", SCRIPT],
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
