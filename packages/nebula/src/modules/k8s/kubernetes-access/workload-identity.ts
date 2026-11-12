import { KubeSecret } from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { stringify } from "yaml";
import { BaseConstruct } from "../../../core";
import { isClusterName, validateOidcAudience, validateOidcHttpsUrl, oidcTokenLifetimeSeconds } from "../../../utils/oidc";

export const KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS = 600;
export const kubernetesAccessAudience = (cluster: string) => `kubernetes:${cluster}`;
const tokenDirectory = (cluster: string) => `/var/run/kubernetes-oidc/${cluster}`;
export const kubernetesAccessTokenPath = (cluster: string) => `${tokenDirectory(cluster)}/token`;
export const kubernetesWorkloadUsername = (subject: string) => `workload:${subject}`;

/** Kubernetes TokenRequest projections require at least 600 seconds. */
export function kubernetesServiceAccountTokenLifetimeSeconds(seconds = KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS): number {
  const lifetime = oidcTokenLifetimeSeconds({ maxTokenLifetimeSeconds: seconds }, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS);
  if (lifetime < 600) throw new Error("Kubernetes ServiceAccount token lifetime must be at least 600 seconds");
  return lifetime;
}

export interface KubernetesWorkloadIdentityConfig {
  cluster: string;
  /** Defaults to the target cluster's separate Kubernetes audience. */
  audience?: string;
  /** Projected TokenRequest lifetime, between 600 and 3600 seconds; defaults to 600. */
  expirationSeconds?: number;
}

/** Projected identity used by client-go, Argo CD and provider runtimes. The
 * kubelet owns token renewal; consumers only receive a reference to its file. */
export class KubernetesWorkloadIdentity {
  public readonly cluster: string;
  public readonly audience: string;
  public readonly tokenPath: string;
  public readonly expirationSeconds: number;

  constructor(config: KubernetesWorkloadIdentityConfig) {
    if (!isClusterName(config.cluster)) throw new Error("A DNS-label cluster name is required");
    this.cluster = config.cluster;
    this.audience = config.audience ?? kubernetesAccessAudience(config.cluster);
    validateOidcAudience(this.audience);
    this.tokenPath = kubernetesAccessTokenPath(config.cluster);
    this.expirationSeconds = kubernetesServiceAccountTokenLifetimeSeconds(config.expirationSeconds);
  }

  public get projection() {
    const name = `oidc-${this.cluster}`;
    const token = { audience: this.audience, expirationSeconds: this.expirationSeconds, path: "token" };
    return {
      volume: { name, projected: { defaultMode: 0o440, sources: [{ serviceAccountToken: token }] } },
      mount: { name, mountPath: tokenDirectory(this.cluster), readOnly: true },
    };
  }

  public kubeconfig(server: string) {
    validateOidcHttpsUrl(server);
    return {
      apiVersion: "v1", kind: "Config",
      clusters: [{ name: this.cluster, cluster: { server } }],
      users: [{ name: "workload", user: { tokenFile: this.tokenPath } }],
      contexts: [{ name: this.cluster, context: { cluster: this.cluster, user: "workload" } }],
      "current-context": this.cluster,
    };
  }

  public get argoExecProvider() {
    return {
      apiVersion: "client.authentication.k8s.io/v1beta1", command: "/bin/sh",
      args: ["-ec", PROJECTED_TOKEN_EXEC_CREDENTIAL_COMMAND, "projected-oidc", this.tokenPath],
    };
  }

  public static podSpec(identities: readonly KubernetesWorkloadIdentityConfig[]) {
    const clusters = new Set<string>();
    const projections = identities.map(config => {
      const identity = new KubernetesWorkloadIdentity(config);
      if (clusters.has(identity.cluster)) throw new Error(`Duplicate projected identity: ${identity.cluster}`);
      clusters.add(identity.cluster);
      return identity.projection;
    });
    if (!projections.length) return {};
    return { volumes: projections.map(p => p.volume), volumeMounts: projections.map(p => p.mount) };
  }
}

/** Argo's client-go cache expires after thirty seconds and reads the rotated
 * file again. GNU date/cat must be present in the selected Argo CD image. */
export const PROJECTED_TOKEN_EXEC_CREDENTIAL_COMMAND = `token=$(cat "$1")
case "$token" in ''|*[!a-zA-Z0-9_.-]*) exit 1;; esac
expiry=$(date -u -d '+30 seconds' '+%Y-%m-%dT%H:%M:%SZ')
printf '{"apiVersion":"client.authentication.k8s.io/v1beta1","kind":"ExecCredential","status":{"expirationTimestamp":"%s","token":"%s"}}' "$expiry" "$token"`;

export interface KubernetesWorkloadKubeconfigConfig {
  name: string;
  namespace: string;
  server: string;
  identity: KubernetesWorkloadIdentityConfig;
}

/** A Secret holding a certificate-free kubeconfig, never a copied token. */
export class KubernetesWorkloadKubeconfig extends BaseConstruct<KubernetesWorkloadKubeconfigConfig> {
  public readonly secret: KubeSecret;
  public readonly secretName: string;

  constructor(scope: Construct, id: string, config: KubernetesWorkloadKubeconfigConfig) {
    super(scope, id, config);
    const { name, namespace, server, identity } = this.config;
    this.secretName = name;
    this.secret = new KubeSecret(this, "secret", {
      metadata: { name, namespace },
      stringData: { value: stringify(new KubernetesWorkloadIdentity(identity).kubeconfig(server)) },
    });
  }
}
