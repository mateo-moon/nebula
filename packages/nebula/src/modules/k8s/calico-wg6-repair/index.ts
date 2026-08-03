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
  /** kubectl image used by the job. */
  image?: string;
}

const SCRIPT = `set -eu
BAD=$(kubectl get nodes -o json | python3 -c '
import json,sys
for n in json.load(sys.stdin)["items"]:
    ready = any(c["type"]=="Ready" and c["status"]=="True" for c in n["status"].get("conditions",[]))
    if ready and not n["metadata"].get("annotations",{}).get("projectcalico.org/IPv6WireguardInterfaceAddr"):
        print(n["metadata"]["name"])
' 2>/dev/null || true)
[ -z "$BAD" ] && { echo "all Ready nodes have a wg6 address"; exit 0; }
for NODE in $BAD; do
  POD=$(kubectl get pods -n kube-system -l k8s-app=calico-node -o json \\
    | python3 -c "
import json,sys
for p in json.load(sys.stdin)['items']:
    if p['spec'].get('nodeName')=='$NODE': print(p['metadata']['name'])
")
  [ -z "$POD" ] && { echo "no calico-node pod on $NODE yet"; continue; }
  echo "wg6 missing on $NODE — restarting $POD (calico#10599 workaround)"
  kubectl delete pod "$POD" -n kube-system --wait=false
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
            backoffLimit: 1,
            activeDeadlineSeconds: 300,
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
                    image: config.image ?? "bitnami/kubectl:1.33",
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
