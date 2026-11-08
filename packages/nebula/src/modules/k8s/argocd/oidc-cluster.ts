import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { validateOidcHttpsUrl } from "../../../utils/oidc";
import { KubernetesWorkloadIdentity, type KubernetesWorkloadIdentityConfig } from "../kubernetes-access/workload-identity";
export interface ArgoCdOidcClusterConfig {
  name: string;
  namespace?: string;
  server: string;
  identity: KubernetesWorkloadIdentityConfig;
}
/** Registers a target using a projected token file; never embeds a token/key. */
export class ArgoCdOidcCluster extends BaseConstruct<ArgoCdOidcClusterConfig> {
  public readonly secret: ApiObject;
  constructor(scope: Construct, id: string, config: ArgoCdOidcClusterConfig) {
    super(scope, id, config);
    const c = this.config;
    validateOidcHttpsUrl(c.server);
    for (const name of [c.name, c.namespace ?? "argocd"])
      if (!/^[a-z0-9][a-z0-9.-]*$/.test(name)) throw new Error("An exact Kubernetes resource name is required");
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
}
