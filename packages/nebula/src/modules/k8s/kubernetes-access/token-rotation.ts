import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { KubernetesWorkloadIdentity, kubernetesServiceAccountTokenLifetimeSeconds, type KubernetesWorkloadIdentityConfig } from "./workload-identity";
export interface ServiceAccountTokenRotationConfig {
  name: string;
  namespace: string;
  targetNamespace: string;
  targets: readonly { serviceAccount: string; secret: string }[];
  identity: KubernetesWorkloadIdentityConfig;
  kubeconfigSecret: string;
  caSecret: { name: string; key: string };
  /** Defaults to two minutes. Keep the interval below expirationSeconds. */
  schedule?: string;
  /** Requested token lifetime; defaults to 600 seconds. */
  expirationSeconds?: number;
  image?: string;
}
/** Refreshes explicitly named ServiceAccount token Secrets using OIDC. Only
 * tmpfs holds token material; no long-lived token or private key is generated. */
export class ServiceAccountTokenRotation extends BaseConstruct<ServiceAccountTokenRotationConfig> {
  constructor(scope: Construct, id: string, config: ServiceAccountTokenRotationConfig) {
    super(scope, id, config);
    const c = this.config;
    const name = c.name;
    for (const value of [name, c.namespace, c.targetNamespace, ...c.targets.flatMap(t => [t.serviceAccount, t.secret])])
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(value)) throw new Error("Exact resource names are required for token rotation");
    if (!c.targets.length) throw new Error("At least one token rotation target is required");
    const expirationSeconds = kubernetesServiceAccountTokenLifetimeSeconds(c.expirationSeconds);
    const token = new KubernetesWorkloadIdentity(c.identity).projection;
    new ApiObject(this, `${name}-sa`, { apiVersion: "v1", kind: "ServiceAccount", metadata: { name, namespace: c.namespace }, automountServiceAccountToken: false });
    new ApiObject(this, name, {
      apiVersion: "batch/v1", kind: "CronJob", metadata: { name, namespace: c.namespace }, spec: {
        schedule: c.schedule ?? "*/2 * * * *", concurrencyPolicy: "Forbid", startingDeadlineSeconds: 90, successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 1,
        jobTemplate: {
          spec: {
            activeDeadlineSeconds: 90, backoffLimit: 1, template: {
              spec: {
                serviceAccountName: name, automountServiceAccountToken: false, restartPolicy: "Never",
                securityContext: { runAsNonRoot: true, runAsUser: 65532, runAsGroup: 65532, fsGroup: 65532, seccompProfile: { type: "RuntimeDefault" } },
                containers: [{
                  name: "refresh", image: c.image ?? "docker.io/alpine/k8s@sha256:692239d739589247c4a791205ed9619c28ae85a21286e19a6211c04a62c56668",
                  command: ["/bin/sh", "-ec"], args: [`
umask 077
for pair in ${c.targets.map(target => `${target.serviceAccount}:${target.secret}`).join(" ")}; do
  service_account="\${pair%%:*}"
  target="\${pair#*:}"
  kubectl --cache-dir=/work/cache -n ${c.targetNamespace} get secret "$target" -o name > /dev/null
  kubectl --cache-dir=/work/cache -n ${c.targetNamespace} create token "$service_account" --duration=${expirationSeconds}s > /work/token
  jq -n --rawfile token /work/token --rawfile ca /ca/ca.crt '{data:{token:($token|rtrimstr("\\n")|@base64),"ca.crt":($ca|@base64)}}' > /work/patch.json
  kubectl --cache-dir=/work/cache -n ${c.targetNamespace} patch secret "$target" --type=merge --patch-file=/work/patch.json > /dev/null
  rm -f /work/token /work/patch.json
done
`], env: [{ name: "KUBECONFIG", value: "/kubeconfig/value" }],
                  resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
                  securityContext: { readOnlyRootFilesystem: true, allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
                  volumeMounts: [token.mount, { name: "kubeconfig", mountPath: "/kubeconfig", readOnly: true }, { name: "ca", mountPath: "/ca", readOnly: true }, { name: "work", mountPath: "/work" }],
                }], volumes: [token.volume, { name: "kubeconfig", secret: { secretName: c.kubeconfigSecret } },
                { name: "ca", secret: { secretName: c.caSecret.name, items: [{ key: c.caSecret.key, path: "ca.crt" }] } }, { name: "work", emptyDir: { medium: "Memory" } }],
              }
            }
          }
        },
      }
    });
  }
}
