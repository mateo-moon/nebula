import { KubeSecret } from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { isResourceName, validateOidcHttpsUrl } from "../../../utils/oidc";
import { KubernetesWorkloadIdentity, type KubernetesWorkloadIdentityConfig } from "../kubernetes-access/workload-identity";

/** The chart's default ServiceAccounts of the two Argo CD workloads that reach
 * target clusters, to list among a target cluster's trusted workload subjects. */
export const argoCdWorkloadSubjects = (namespace = "argocd") => ({
  controller: `system:serviceaccount:${namespace}:argocd-application-controller`,
  server: `system:serviceaccount:${namespace}:argocd-server`,
});

export interface ArgoCdOidcClusterConfig {
  name: string;
  namespace?: string;
  server: string;
  identity: KubernetesWorkloadIdentityConfig;
}

/** Registers a target using a projected token file; never embeds a token/key. */
export class ArgoCdOidcCluster extends BaseConstruct<ArgoCdOidcClusterConfig> {
  public readonly secret: KubeSecret;

  constructor(scope: Construct, id: string, config: ArgoCdOidcClusterConfig) {
    super(scope, id, config);
    const { name, namespace = "argocd", server, identity } = this.config;
    validateOidcHttpsUrl(server);
    if (!isResourceName(name) || !isResourceName(namespace)) throw new Error("An exact Kubernetes resource name is required");
    this.secret = new KubeSecret(this, "cluster", {
      metadata: { name, namespace, labels: { "argocd.argoproj.io/secret-type": "cluster" } },
      stringData: {
        name, server,
        config: JSON.stringify({
          tlsClientConfig: { insecure: false },
          execProviderConfig: new KubernetesWorkloadIdentity(identity).argoExecProvider,
        }),
      },
    });
  }
}
