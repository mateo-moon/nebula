import { KubeCronJob, KubeServiceAccount, Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { BaseConstruct, confinedContainer, unprivilegedPod } from "../../../core";
import { isResourceName, validateOidcAudience } from "../../../utils/oidc";
import { rbac } from "./rbac";
import {
  KubernetesWorkloadIdentity, kubernetesServiceAccountTokenLifetimeSeconds, type KubernetesWorkloadIdentityConfig,
} from "./workload-identity";

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
  /** Recipients of the issued target tokens; omit to use API-server defaults. */
  audiences?: readonly string[];
  image?: string;
}

const KUBECTL_IMAGE = "docker.io/alpine/k8s@sha256:692239d739589247c4a791205ed9619c28ae85a21286e19a6211c04a62c56668";

/** Names are checked because they are written into the refresh script. */
function refreshScript(c: ServiceAccountTokenRotationConfig): string {
  const names = [c.name, c.namespace, c.targetNamespace, ...c.targets.flatMap(t => [t.serviceAccount, t.secret])];
  if (!names.every(isResourceName)) throw new Error("Exact resource names are required for token rotation");
  if (!c.targets.length) throw new Error("At least one token rotation target is required");
  const expirationSeconds = kubernetesServiceAccountTokenLifetimeSeconds(c.expirationSeconds);
  if (c.audiences !== undefined && (!Array.isArray(c.audiences) || !c.audiences.length || new Set(c.audiences).size !== c.audiences.length))
    throw new Error("Token audiences must be a non-empty list of unique exact audiences");
  const audienceArgs = (c.audiences ?? []).map(audience => {
    validateOidcAudience(audience);
    return ` --audience='${audience.replace(/'/g, "'\\''")}'`;
  }).join("");
  const kubectl = `kubectl --cache-dir=/work/cache -n ${c.targetNamespace}`;
  return `
umask 077
for pair in ${c.targets.map(target => `${target.serviceAccount}:${target.secret}`).join(" ")}; do
  service_account="\${pair%%:*}"
  target="\${pair#*:}"
  ${kubectl} get secret "$target" -o name > /dev/null
  ${kubectl} create token "$service_account" --duration=${expirationSeconds}s${audienceArgs} > /work/token
  jq -n --rawfile token /work/token --rawfile ca /ca/ca.crt '{data:{token:($token|rtrimstr("\\n")|@base64),"ca.crt":($ca|@base64)}}' > /work/patch.json
  ${kubectl} patch secret "$target" --type=merge --patch-file=/work/patch.json > /dev/null
  rm -f /work/token /work/patch.json
done
`;
}

/** Refreshes explicitly named ServiceAccount token Secrets using OIDC. Only
 * tmpfs holds token material; no long-lived token or private key is generated. */
export class ServiceAccountTokenRotation extends BaseConstruct<ServiceAccountTokenRotationConfig> {
  /** The refresher's ServiceAccount, to list among the target cluster's trusted workload subjects. */
  public static subject({ name, namespace }: Pick<ServiceAccountTokenRotationConfig, "name" | "namespace">): string {
    return `system:serviceaccount:${namespace}:${name}`;
  }

  /** What the refresher needs in the target cluster: to mint tokens for the
   * named ServiceAccounts and to patch the named Secrets, nothing else. */
  public static targetRbac(
    config: Pick<ServiceAccountTokenRotationConfig, "name" | "namespace" | "targetNamespace" | "targets">,
  ): object[] {
    const refresher = [rbac.workload(ServiceAccountTokenRotation.subject(config))];
    return rbac.grant(config.name, refresher, [
      { apiGroups: [""], resources: ["serviceaccounts/token"], resourceNames: config.targets.map(t => t.serviceAccount), verbs: ["create"] },
      { apiGroups: [""], resources: ["secrets"], resourceNames: config.targets.map(t => t.secret), verbs: ["get", "patch"] },
    ], config.targetNamespace);
  }

  constructor(scope: Construct, id: string, config: ServiceAccountTokenRotationConfig) {
    super(scope, id, config);
    const c = this.config;
    const metadata = () => ({ name: c.name, namespace: c.namespace });
    const script = refreshScript(c);
    const token = new KubernetesWorkloadIdentity(c.identity).projection;

    new KubeServiceAccount(this, `${c.name}-sa`, { metadata: metadata(), automountServiceAccountToken: false });
    new KubeCronJob(this, c.name, {
      metadata: metadata(),
      spec: {
        schedule: c.schedule ?? "*/2 * * * *",
        concurrencyPolicy: "Forbid", startingDeadlineSeconds: 90,
        successfulJobsHistoryLimit: 1, failedJobsHistoryLimit: 1,
        jobTemplate: { spec: {
          activeDeadlineSeconds: 90, backoffLimit: 1,
          template: { spec: {
            serviceAccountName: c.name, automountServiceAccountToken: false, restartPolicy: "Never",
            securityContext: unprivilegedPod(),
            containers: [{
              name: "refresh", image: c.image ?? KUBECTL_IMAGE,
              command: ["/bin/sh", "-ec"], args: [script],
              env: [{ name: "KUBECONFIG", value: "/kubeconfig/value" }],
              resources: {
                requests: { cpu: Quantity.fromString("10m"), memory: Quantity.fromString("32Mi") },
                limits: { memory: Quantity.fromString("128Mi") },
              },
              securityContext: confinedContainer,
              volumeMounts: [
                token.mount,
                { name: "kubeconfig", mountPath: "/kubeconfig", readOnly: true },
                { name: "ca", mountPath: "/ca", readOnly: true },
                { name: "work", mountPath: "/work" },
              ],
            }],
            volumes: [
              token.volume,
              { name: "kubeconfig", secret: { secretName: c.kubeconfigSecret } },
              { name: "ca", secret: { secretName: c.caSecret.name, items: [{ key: c.caSecret.key, path: "ca.crt" }] } },
              { name: "work", emptyDir: { medium: "Memory" } },
            ],
          } },
        } },
      },
    });
  }
}
