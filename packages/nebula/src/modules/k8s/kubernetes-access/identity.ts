import { type OidcIssuer, validateOidcIssuer, oidcTokenLifetimeSeconds } from "../../../utils/oidc";
import { KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS, KubernetesWorkloadIdentity } from "./workload-identity";
export type { OidcIssuer } from "../../../utils/oidc";
export interface KubernetesOidcClaimMapping {
  claim: string;
  /** Defaults to oidc: to keep external identities distinct from system identities. */
  prefix?: string;
}
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
    /** Optional restriction to verified email addresses in this exact domain. */
    emailDomain?: string;
    /** Defaults to verified email with the oidc: prefix. */
    username?: KubernetesOidcClaimMapping;
    /** Explicit fixed groups or an issuer claim; no groups are assigned by default. */
    groups?: readonly string[] | KubernetesOidcClaimMapping;
    /** Exact signed claims, for example a managed domain and authorized party. */
    requiredClaims?: Readonly<Record<string, string>>;
    login?: KubernetesOidcProviderLoginOptions;
  };
  workload?: OidcIssuer & { subjects: readonly string[] };
}

/** Shared identity policy for the API server, gateway and certificate-free clients. */
export class KubernetesOidcIdentity {
  public readonly workloadIdentity: KubernetesWorkloadIdentity;
  constructor(public readonly config: KubernetesOidcIdentityConfig) {
    this.workloadIdentity = new KubernetesWorkloadIdentity({ cluster: this.config.cluster, audience: this.config.workload?.audience,
      expirationSeconds: this.config.workload ? oidcTokenLifetimeSeconds(this.config.workload, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS) : undefined });
    this.validate();
  }
  public workloadKubeconfig(): object { return this.workloadIdentity.kubeconfig(`https://${this.config.hostname}`); }
  private validate(): void {
    const c = this.config;
    if (!/^[a-z][a-z0-9-]*$/.test(c.cluster) || !/^[a-z0-9][a-z0-9.-]+$/.test(c.hostname))
      throw new Error("Access requires an exact cluster name and DNS hostname");
    for (const issuer of [c.workforce, ...(c.workload ? [c.workload] : [])]) {
      validateOidcIssuer(issuer); oidcTokenLifetimeSeconds(issuer, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS);
    }
    if (c.workforce.emailDomain !== undefined && !/^[a-z0-9][a-z0-9.-]+$/.test(c.workforce.emailDomain)) throw new Error("An exact workforce email domain is required");
    const validateMapping = (mapping: KubernetesOidcClaimMapping) => {
      if (!mapping.claim || /[\s*\u0000-\u001f\u007f]/.test(mapping.claim) || /[\u0000-\u001f\u007f]/.test(mapping.prefix ?? "") || mapping.prefix?.startsWith("system:"))
        throw new Error("OIDC claim mappings require an exact claim and a non-system prefix");
    };
    if (c.workforce.username) validateMapping(c.workforce.username);
    if (c.workforce.groups) {
      if (Array.isArray(c.workforce.groups)) {
        if (c.workforce.groups.some(group => !group || /[\u0000-\u001f\u007f]/.test(group) || group.startsWith("system:")))
          throw new Error("OIDC groups must be non-empty, non-system group names");
      } else validateMapping(c.workforce.groups as KubernetesOidcClaimMapping);
    }
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
      if (c.workload.url === c.workforce.url) throw new Error("Workforce and workload issuers must differ");
      if (!c.workload.subjects.length || c.workload.subjects.some(s => !/^system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$/.test(s)))
        throw new Error("Workload trust requires exact ServiceAccount subjects");
    }
  }

  public authenticationConfiguration(): Record<string, unknown> {
    const c = this.config;
    const username = c.workforce.username ?? { claim: "email" };
    const groups = c.workforce.groups;
    const mapping = (m: KubernetesOidcClaimMapping) => ({ claim: m.claim, prefix: m.prefix ?? "oidc:" });
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
      // Anonymous authentication is configured by the containing control plane.
      jwt: [
        {
          issuer: issuer(c.workforce), claimValidationRules: [lifetime(c.workforce),
            ...(username.claim === "email" || c.workforce.emailDomain ? [{
              expression: `claims.email_verified == true${c.workforce.emailDomain ? ` && claims.email.endsWith(${JSON.stringify(`@${c.workforce.emailDomain}`)})` : ""}`,
              message: "A verified email matching the configured identity policy is required"
            }] : []), ...Object.entries(c.workforce.requiredClaims ?? {}).map(([claim, requiredValue]) => ({ claim, requiredValue }))],
          claimMappings: {
            username: mapping(username), uid: { claim: "sub" },
            ...(groups ? { groups: Array.isArray(groups) ? { expression: JSON.stringify(groups) } : mapping(groups as KubernetesOidcClaimMapping) } : {})
          },
          userValidationRules: [
            { expression: "!user.username.startsWith('system:')", message: "System identities are reserved" },
            { expression: "user.groups.all(group, !group.startsWith('system:'))", message: "System groups are reserved" }
          ]
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
