import {
  type OidcIssuer, hasControlCharacter, isClusterName, isDnsName, isExact, oidcTokenLifetimeSeconds, validateOidcIssuer,
} from "../../../utils/oidc";
import { authenticationConfiguration } from "./authentication-configuration";
import { userKubeconfig } from "./user-kubeconfig";
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
    /** Additional groups by exact verified email, keyed by group; extends fixed `groups`. */
    emailGroups?: Readonly<Record<string, readonly string[]>>;
    /** Exact signed claims, for example a managed domain and authorized party. */
    requiredClaims?: Readonly<Record<string, string>>;
    login?: KubernetesOidcProviderLoginOptions;
  };
  workload?: OidcIssuer & { subjects: readonly string[] };
}

type Workforce = KubernetesOidcIdentityConfig["workforce"];

const reservedAuthParams = new Set([
  "client_id", "client_secret", "response_type", "redirect_uri", "scope", "state", "nonce",
  "code_challenge", "code_challenge_method", "request", "request_uri",
]);
const invalidGroup = (group: string) => !group || hasControlCharacter(group) || group.startsWith("system:");

function validateMapping(mapping: KubernetesOidcClaimMapping): void {
  if (!isExact(mapping.claim) || hasControlCharacter(mapping.prefix ?? "") || mapping.prefix?.startsWith("system:"))
    throw new Error("OIDC claim mappings require an exact claim and a non-system prefix");
}

function validateWorkforce({ emailDomain, username, groups, emailGroups, requiredClaims = {} }: Workforce): void {
  if (emailDomain !== undefined && !isDnsName(emailDomain)) throw new Error("An exact workforce email domain is required");
  if (username) validateMapping(username);
  if (Array.isArray(groups)) {
    if (groups.some(invalidGroup)) throw new Error("OIDC groups must be non-empty, non-system group names");
  } else if (groups) validateMapping(groups as KubernetesOidcClaimMapping);
  if (emailGroups) {
    if (groups && !Array.isArray(groups)) throw new Error("Email groups extend fixed groups, not a claim mapping");
    for (const [group, emails] of Object.entries(emailGroups)) {
      if (invalidGroup(group) || !Array.isArray(emails) || !emails.length || emails.some(email => !/^[^\s@"']+@[^\s@"']+$/.test(email)))
        throw new Error("Email groups require a non-system group name and exact email addresses");
    }
  }
  for (const [claim, value] of Object.entries(requiredClaims)) {
    if (!isExact(claim) || typeof value !== "string" || !value)
      throw new Error("Required workforce claims need an exact claim name and a non-empty string value");
  }
}

function validateLogin(login: KubernetesOidcProviderLoginOptions = {}): void {
  if (login.clientAuthentication && !["none", "client-secret"].includes(login.clientAuthentication))
    throw new Error("Unsupported OIDC client authentication mode");
  for (const scope of login.extraScopes ?? []) {
    if (!scope || /[\s,]/.test(scope) || hasControlCharacter(scope)) throw new Error("OIDC extra scopes must be individual non-empty scopes");
  }
  for (const [key, value] of Object.entries(login.authRequestExtraParams ?? {})) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) || reservedAuthParams.has(key) || !value || /[,"\r\n]/.test(value))
      throw new Error("OIDC extra auth parameters must not override protocol security or contain CSV delimiters");
  }
}

function validate(c: KubernetesOidcIdentityConfig): void {
  if (!isClusterName(c.cluster) || !isDnsName(c.hostname))
    throw new Error("Access requires an exact cluster name and DNS hostname");
  for (const issuer of [c.workforce, ...(c.workload ? [c.workload] : [])]) {
    validateOidcIssuer(issuer);
    oidcTokenLifetimeSeconds(issuer, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS);
  }
  validateWorkforce(c.workforce);
  validateLogin(c.workforce.login);
  if (!c.workload) return;
  if (c.workload.url === c.workforce.url) throw new Error("Workforce and workload issuers must differ");
  if (!c.workload.subjects.length || c.workload.subjects.some(s => !/^system:serviceaccount:[a-z0-9-]+:[a-z0-9-]+$/.test(s)))
    throw new Error("Workload trust requires exact ServiceAccount subjects");
}

/** Shared identity policy for the API server, gateway and certificate-free clients. */
export class KubernetesOidcIdentity {
  public readonly workloadIdentity: KubernetesWorkloadIdentity;

  constructor(public readonly config: KubernetesOidcIdentityConfig) {
    const { cluster, workload } = config;
    this.workloadIdentity = new KubernetesWorkloadIdentity({
      cluster, audience: workload?.audience,
      expirationSeconds: workload ? oidcTokenLifetimeSeconds(workload, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS) : undefined,
    });
    validate(config);
  }

  /** The API server's structured authentication configuration. */
  public authenticationConfiguration(): Record<string, unknown> { return authenticationConfiguration(this.config); }

  /** A kubectl exec profile for people. */
  public userKubeconfig(options: KubernetesOidcLoginOptions = {}): object { return userKubeconfig(this.config, options); }

  /** A kubeconfig reading the projected token file of a management workload. */
  public workloadKubeconfig(): object { return this.workloadIdentity.kubeconfig(`https://${this.config.hostname}`); }
}
