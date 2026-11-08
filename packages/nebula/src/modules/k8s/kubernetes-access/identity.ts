import { isIP } from "node:net";
import { type OidcIssuer, validateOidcIssuer, oidcTokenLifetimeSeconds } from "../../../utils/oidc";
import { KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS, KubernetesWorkloadIdentity, kubernetesAccessAudience } from "./workload-identity";
export type { OidcIssuer } from "../../../utils/oidc";
export const KUBERNETES_OIDC_WORKFORCE_GROUP = "oidc:employees";
export interface KubernetesOidcProviderLoginOptions {
  grantType?: "auto" | "authcode" | "device-code";
  /** Additional scopes beyond the plugin's openid scope. */
  extraScopes?: readonly string[];
  /** Provider-specific hints; required identity claims are enforced separately. */
  authRequestExtraParams?: Readonly<Record<string, string>>;
  /** Client app credential required by the token endpoint; read locally in memory. */
  clientAuthentication?: "none" | "client-secret";
}
export interface KubernetesOidcLoginOptions {
  /** Absolute plugin path, or kubectl/nebula-oidc-login according to client authentication. */
  command?: string;
  grantType?: KubernetesOidcProviderLoginOptions["grantType"];
  tokenCacheStorage?: "keyring" | "disk" | "none";
  tokenCacheDirectory?: string;
  /** A trusted headless host can use an SSH-forwarded loopback callback. */
  skipOpenBrowser?: boolean;
  redirectUrl?: string;
  listenAddress?: string;
  /** Protected local JSON input; its contents never enter this kubeconfig. */
  clientCredentialFile?: string;
}
export interface KubernetesOidcIdentityConfig {
  cluster: string;
  hostname: string;
  workforce: OidcIssuer & {
    emailDomain: string;
    /** Exact signed claims, for example a managed domain and authorized party. */
    requiredClaims?: Readonly<Record<string, string>>;
    login?: KubernetesOidcProviderLoginOptions;
  };
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
      validateOidcIssuer(issuer); oidcTokenLifetimeSeconds(issuer, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS);
    }
    if (!/^[a-z0-9][a-z0-9.-]+$/.test(c.workforce.emailDomain)) throw new Error("An exact workforce email domain is required");
    for (const [claim, value] of Object.entries(c.workforce.requiredClaims ?? {})) {
      if (!claim || /[\s*\u0000-\u001f\u007f]/.test(claim) || typeof value !== "string" || !value)
        throw new Error("Required workforce claims need an exact claim name and a non-empty string value");
    }
    const login = c.workforce.login;
    if (login?.clientAuthentication && !["none", "client-secret"].includes(login.clientAuthentication))
      throw new Error("Unsupported OIDC client authentication mode");
    for (const scope of login?.extraScopes ?? []) {
      if (!scope || /[\s,\u0000-\u001f\u007f]/.test(scope)) throw new Error("OIDC extra scopes must be individual non-empty scopes");
    }
    const reservedParams = new Set(["client_id", "client_secret", "response_type", "redirect_uri", "scope", "state", "nonce", "code_challenge", "code_challenge_method", "request", "request_uri"]);
    for (const [key, value] of Object.entries(login?.authRequestExtraParams ?? {})) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || reservedParams.has(key) || !value || /[,"\r\n]/.test(value))
        throw new Error("OIDC extra auth parameters must not override protocol security or contain CSV delimiters");
    }
    if (c.workload) {
      if (c.workload.audience !== kubernetesAccessAudience(c.cluster)) throw new Error("Workload OIDC audiences must be specific to the target cluster");
      if (oidcTokenLifetimeSeconds(c.workload, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS) !== KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS)
        throw new Error("Workload OIDC tokens must retain the 600-second lifetime");
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
    const lifetime = (i: OidcIssuer) => ({
      expression: `claims.exp - claims.iat <= ${oidcTokenLifetimeSeconds(i, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS)} && claims.exp > claims.iat`,
      message: `Tokens must have a lifetime of at most ${oidcTokenLifetimeSeconds(i, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS)} seconds`
    });
    return {
      apiVersion: "apiserver.config.k8s.io/v1", kind: "AuthenticationConfiguration",
      // k0s sets --anonymous-auth=false itself. Keep that configuration outside
      // this file: specifying both would prevent kube-apiserver from starting.
      jwt: [
        {
          issuer: issuer(c.workforce), claimValidationRules: [lifetime(c.workforce),
            {
              expression: `claims.email_verified == true && claims.email.endsWith(${JSON.stringify(`@${c.workforce.emailDomain}`)})`,
              message: "A verified company identity is required"
            }, ...Object.entries(c.workforce.requiredClaims ?? {}).map(([claim, requiredValue]) => ({ claim, requiredValue }))],
          claimMappings: {
            username: { claim: "email", prefix: "oidc:" }, uid: { claim: "sub" },
            // Company membership is explicitly verified above; aud is never a group.
            groups: { expression: `[${JSON.stringify(KUBERNETES_OIDC_WORKFORCE_GROUP)}]` }
          },
          userValidationRules: [{ expression: "!user.username.startsWith('system:')", message: "System identities are reserved" }]
        },
        ...(c.workload ? [{
          issuer: issuer(c.workload), claimValidationRules: [lifetime(c.workload),
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
    const userName = `oidc-${c.cluster}`;
    const login = c.workforce.login;
    const grantType = options.grantType ?? login?.grantType;
    const credentialFile = login?.clientAuthentication === "client-secret" || options.clientCredentialFile !== undefined;
    if (options.redirectUrl) {
      const redirect = new URL(options.redirectUrl);
      if (redirect.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(redirect.hostname) || redirect.username || redirect.password || redirect.search || redirect.hash)
        throw new Error("OIDC desktop callbacks must use an HTTP loopback URL");
    }
    if (options.listenAddress && !/^(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/.test(options.listenAddress))
      throw new Error("OIDC desktop listeners must bind a loopback address");
    return {
      apiVersion: "v1", kind: "Config", clusters: [{ name: c.cluster, cluster: { server: `https://${c.hostname}` } }],
      users: [{
        name: userName, user: {
          exec: {
            apiVersion: "client.authentication.k8s.io/v1", command: options.command ?? (credentialFile ? "nebula-oidc-login" : "kubectl"),
            interactiveMode: "IfAvailable", provideClusterInfo: false,
            args: [...(options.command || credentialFile ? [] : ["oidc-login"]), "get-token", `--oidc-issuer-url=${c.workforce.url}`, `--oidc-client-id=${c.workforce.audience}`,
              ...(credentialFile ? [`--oidc-client-secret-file=${options.clientCredentialFile ?? `~/.config/nebula/oidc/${c.cluster}.json`}`] : []),
              ...[...new Set(login?.extraScopes ?? ["email", "offline_access"])].map(scope => `--oidc-extra-scope=${scope}`),
              ...Object.entries(login?.authRequestExtraParams ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `--oidc-auth-request-extra-params=${key}=${value}`),
              "--oidc-pkce-method=S256", `--token-cache-storage=${options.tokenCacheStorage ?? "keyring"}`,
            ...(grantType ? [`--grant-type=${grantType}`] : []),
            ...(options.tokenCacheDirectory ? [`--token-cache-dir=${options.tokenCacheDirectory}`] : []),
            ...(options.skipOpenBrowser ? ["--skip-open-browser"] : []),
            ...(options.redirectUrl ? [`--oidc-redirect-url=${options.redirectUrl}`] : []),
            ...(options.listenAddress ? [`--listen-address=${options.listenAddress}`] : [])],
          }
        }
      }],
      contexts: [{ name: c.cluster, context: { cluster: c.cluster, user: userName } }], "current-context": c.cluster
    };
  }
}
