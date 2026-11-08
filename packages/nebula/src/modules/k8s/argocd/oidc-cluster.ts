import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { validateOidcHttpsUrl } from "../../../utils/oidc";
import { KubernetesWorkloadIdentity, type KubernetesWorkloadIdentityConfig } from "../kubernetes-access/workload-identity";
export interface ArgoCdLegacyClusterRetirement {
  syncName: string;
  secretName: string;
  namespace?: string;
}
export interface ArgoCdOidcClusterConfig {
  name: string;
  namespace?: string;
  server: string;
  identity: KubernetesWorkloadIdentityConfig;
  /** Explicit opt-in: a narrow PreSync hook retires the old certificate sync. */
  retireLegacyCertificateSync?: ArgoCdLegacyClusterRetirement;
}
/** Registers a target using a projected token file; never embeds a token/key. */
export class ArgoCdOidcCluster extends BaseConstruct<ArgoCdOidcClusterConfig> {
  public readonly secret: ApiObject;
  constructor(scope: Construct, id: string, config: ArgoCdOidcClusterConfig) {
    super(scope, id, config);
    const c = this.config;
    validateOidcHttpsUrl(c.server);
    for (const name of [c.name, c.namespace ?? "argocd", ...(c.retireLegacyCertificateSync ? [c.retireLegacyCertificateSync.syncName, c.retireLegacyCertificateSync.secretName, c.retireLegacyCertificateSync.namespace ?? "default"] : [])])
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error("An exact Kubernetes resource name is required");
    if (c.retireLegacyCertificateSync) this.retireCertificateSync(c.name, c.retireLegacyCertificateSync);
    this.secret = new ApiObject(this, "cluster", {
      apiVersion: "v1", kind: "Secret", metadata: {
        name: c.name, namespace: c.namespace ?? "argocd",
        labels: { "argocd.argoproj.io/secret-type": "cluster" }
      }, stringData: {
        name: c.name, server: c.server,
        config: JSON.stringify({ tlsClientConfig: { insecure: false }, execProviderConfig: new KubernetesWorkloadIdentity(c.identity).argoExecProvider }),
      }
    });
  }
  private retireCertificateSync(cluster: string, legacy: ArgoCdLegacyClusterRetirement): void {
    const namespace = legacy.namespace ?? "default";
    const argoNamespace = this.config.namespace ?? "argocd";
    const name = `retire-${cluster}-certificate-sync`;
    const annotations = {
      "argocd.argoproj.io/hook": "PreSync", "argocd.argoproj.io/sync-wave": "-10",
      "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation"
    };
    const meta = (namespace?: string) => ({ name, ...(namespace ? { namespace } : {}), annotations });
    const rules = [{ apiGroups: ["nebula.io"], resources: ["xargocdclustersyncs"], resourceNames: [legacy.syncName], verbs: ["delete", "get"] }];
    new ApiObject(this, `${name}-sa`, { apiVersion: "v1", kind: "ServiceAccount", metadata: meta(namespace) });
    new ApiObject(this, `${name}-role`, { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: meta(), rules });
    new ApiObject(this, `${name}-binding`, {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRoleBinding", metadata: meta(),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name }, subjects: [{ kind: "ServiceAccount", name, namespace }]
    });
    new ApiObject(this, `${name}-secret-role`, {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: meta(argoNamespace),
      rules: [{ apiGroups: [""], resources: ["secrets"], resourceNames: [legacy.secretName], verbs: ["delete"] }]
    });
    new ApiObject(this, `${name}-secret-binding`, {
      apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: meta(argoNamespace),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name }, subjects: [{ kind: "ServiceAccount", name, namespace }]
    });
    new ApiObject(this, `${name}-job`, {
      apiVersion: "batch/v1", kind: "Job", metadata: { ...meta(namespace), annotations: { ...annotations, "argocd.argoproj.io/sync-wave": "-9", "argocd.argoproj.io/hook-delete-policy": "BeforeHookCreation,HookSucceeded" } }, spec: {
        activeDeadlineSeconds: 180, backoffLimit: 0, template: {
          spec: {
            serviceAccountName: name, restartPolicy: "Never",
            containers: [{
              name: "retire", image: "docker.io/alpine/k8s@sha256:692239d739589247c4a791205ed9619c28ae85a21286e19a6211c04a62c56668",
              command: ["/bin/sh", "-ec"], args: [
                `legacy=$(kubectl get xargocdclustersyncs.nebula.io ${legacy.syncName} --ignore-not-found -o name)\nif [ -n "$legacy" ]; then\n  kubectl delete xargocdclustersyncs.nebula.io ${legacy.syncName} --wait=true --timeout=120s\n  kubectl -n ${argoNamespace} delete secret ${legacy.secretName} --ignore-not-found --wait=true --timeout=30s\nfi`,
              ], resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } },
            }],
          }
        },
      }
    });
  }

}
