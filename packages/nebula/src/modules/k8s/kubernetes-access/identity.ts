import { isIP } from "node:net";
import { type OidcIssuer, validateOidcHttpsUrl } from "../../../utils/oidc";
import { KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS, KubernetesWorkloadIdentity, kubernetesAccessAudience } from "./workload-identity";
export type { OidcIssuer } from "../../../utils/oidc";
export const KUBERNETES_OIDC_WORKFORCE_GROUP = "oidc:employees";
export interface KubernetesOidcLoginOptions {
  /** Absolute plugin path for a trusted server, or kubectl + oidc-login by default. */
  command?: string;
  grantType?: "auto" | "authcode" | "device-code";
  tokenCacheStorage?: "keyring" | "disk" | "none";
  tokenCacheDirectory?: string;
}
export interface KubernetesOidcIdentityConfig {
  cluster: string;
  hostname: string;
  workforce: OidcIssuer & { emailDomain: string };
  workload?: OidcIssuer & { subjects: readonly string[] };
  backend: { host: string; port: number; serverName: string; caSecret: { name: string; key: string } };
  /** Actual worker/controller source addresses, including IPv6 when used.
   * An empty list cannot activate the cutover. Never include employee/VPN ranges. */
  systemSourceCidrs: readonly string[];
  namespace: string;
  ingressClassName: string;
  clusterIssuer: string;
}

/** Shared identity policy for the API server, gateway and certificate-free clients. */
export class KubernetesOidcIdentity {
  constructor(public readonly config: KubernetesOidcIdentityConfig) { this.validate(); }
  public get workloadIdentity(): KubernetesWorkloadIdentity {
    return new KubernetesWorkloadIdentity({ cluster: this.config.cluster, audience: this.config.workload?.audience });
  }
  public workloadKubeconfig(): object { return this.workloadIdentity.kubeconfig(`https://${this.config.hostname}`); }
  public validate(requireIsolation = false): void {
    const c = this.config;
    if (!/^[a-z][a-z0-9-]*$/.test(c.cluster) || !/^[a-z0-9][a-z0-9.-]+$/.test(c.hostname))
      throw new Error("Access requires an exact cluster name and DNS hostname");
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(c.backend.host) || !/^[a-z0-9][a-z0-9.-]+$/.test(c.backend.serverName) ||
      !Number.isInteger(c.backend.port) || c.backend.port < 1 || c.backend.port > 65535)
      throw new Error("Access requires a TLS backend with an exact DNS name and port");
    for (const issuer of [c.workforce, ...(c.workload ? [c.workload] : [])]) {
      validateOidcHttpsUrl(issuer.url); validateOidcHttpsUrl(issuer.jwksUrl);
      if (issuer.audience !== kubernetesAccessAudience(c.cluster)) throw new Error("OIDC audiences must be specific to the target cluster");
    }
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(c.workforce.emailDomain)) throw new Error("An exact workforce email domain is required");
    if (c.workload) {
      if (c.workload.url === c.workforce.url) throw new Error("Workforce and workload issuers must differ");
      if (!c.workload.subjects.length || c.workload.subjects.some(s => !/^system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$/.test(s)))
        throw new Error("Workload trust requires exact ServiceAccount subjects");
    }
    if (requireIsolation && !c.systemSourceCidrs.length) throw new Error(`${c.cluster}: populate systemSourceCidrs before enabling OIDC cutover`);
    for (const cidr of c.systemSourceCidrs) {
      const [address, prefix, extra] = cidr.split("/");
      const family = isIP(address!);
      if (extra || !family || !/^\d+$/.test(prefix ?? "") || Number(prefix) < (family === 4 ? 16 : 48) || Number(prefix) > (family === 4 ? 32 : 128))
        throw new Error(`Unsafe or invalid system API source range: ${cidr}`);
    }
  }

  public authenticationConfiguration(): Record<string, unknown> {
    const c = this.config;
    const issuer = (i: OidcIssuer) => ({
      url: i.url, audiences: [i.audience], audienceMatchPolicy: "MatchAny",
      ...(i.certificateAuthority ? { certificateAuthority: i.certificateAuthority } : {})
    });
    const lifetime = {
      expression: `claims.exp - claims.iat <= ${KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS} && claims.exp > claims.iat`,
      message: "Tokens must have a lifetime of at most ten minutes"
    };
    return {
      apiVersion: "apiserver.config.k8s.io/v1", kind: "AuthenticationConfiguration",
      // k0s sets --anonymous-auth=false itself. Keep that configuration outside
      // this file: specifying both would prevent kube-apiserver from starting.
      jwt: [
        {
          issuer: issuer(c.workforce), claimValidationRules: [lifetime,
            {
              expression: `claims.email_verified == true && claims.email.endsWith(${JSON.stringify(`@${c.workforce.emailDomain}`)})`,
              message: "A verified company identity is required"
            }],
          claimMappings: {
            username: { claim: "email", prefix: "oidc:" }, uid: { claim: "sub" },
            // Company membership is explicitly verified above; aud is never a group.
            groups: { expression: `[${JSON.stringify(KUBERNETES_OIDC_WORKFORCE_GROUP)}]` }
          },
          userValidationRules: [{ expression: "!user.username.startsWith('system:')", message: "System identities are reserved" }]
        },
        ...(c.workload ? [{
          issuer: issuer(c.workload), claimValidationRules: [lifetime,
            { expression: `claims.sub in ${JSON.stringify([...c.workload.subjects])}`, message: "Workload is not allowed in this cluster" },
            { expression: `has(claims['kubernetes.io'].pod) && has(claims['kubernetes.io'].pod.uid)`, message: "A pod-bound workload token is required" }],
          claimMappings: { username: { expression: `'workload:' + claims.sub` }, uid: { claim: "sub" } },
          userValidationRules: [{ expression: "!user.username.startsWith('system:')", message: "System identities are reserved" }]
        }] : []),
      ],
    };
  }

  public userKubeconfig(options: KubernetesOidcLoginOptions = {}): object {
    const c = this.config;
    return {
      apiVersion: "v1", kind: "Config", clusters: [{ name: c.cluster, cluster: { server: `https://${c.hostname}` } }],
      users: [{
        name: "oidc", user: {
          exec: {
            apiVersion: "client.authentication.k8s.io/v1", command: options.command ?? "kubectl",
            interactiveMode: "IfAvailable", provideClusterInfo: false,
            args: [...(options.command ? [] : ["oidc-login"]), "get-token", `--oidc-issuer-url=${c.workforce.url}`, `--oidc-client-id=${c.workforce.audience}`,
              "--oidc-extra-scope=email", "--oidc-extra-scope=offline_access", "--oidc-pkce-method=S256", `--token-cache-storage=${options.tokenCacheStorage ?? "keyring"}`,
            ...(options.grantType ? [`--grant-type=${options.grantType}`] : []),
            ...(options.tokenCacheDirectory ? [`--token-cache-dir=${options.tokenCacheDirectory}`] : [])],
          }
        }
      }],
      contexts: [{ name: c.cluster, context: { cluster: c.cluster, user: "oidc" } }], "current-context": c.cluster
    };
  }
}
