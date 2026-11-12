import { type OidcIssuer, oidcTokenLifetimeSeconds } from "../../../utils/oidc";
import type { KubernetesOidcClaimMapping, KubernetesOidcIdentityConfig } from "./identity";
import { KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS, WORKLOAD_USERNAME_PREFIX } from "./workload-identity";

type Workforce = KubernetesOidcIdentityConfig["workforce"];
type Workload = NonNullable<KubernetesOidcIdentityConfig["workload"]>;

// The document is serialized into control-plane files. Each rule is a fresh
// object, because YAML would alias a shared one, and key order is part of the output.
const notSystemUser = () => ({ expression: "!user.username.startsWith('system:')", message: "System identities are reserved" });
const notSystemGroups = () => ({ expression: "user.groups.all(group, !group.startsWith('system:'))", message: "System groups are reserved" });

const issuer = (i: OidcIssuer) => ({
  url: i.url, audiences: [i.audience], audienceMatchPolicy: "MatchAny",
  ...(i.certificateAuthority ? { certificateAuthority: i.certificateAuthority } : {}),
});

function lifetime(i: OidcIssuer) {
  const seconds = oidcTokenLifetimeSeconds(i, KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS);
  return {
    expression: `claims.exp - claims.iat <= ${seconds} && claims.exp > claims.iat`,
    message: `Tokens must have a lifetime of at most ${seconds} seconds`,
  };
}

const mapping = (m: KubernetesOidcClaimMapping) => ({ claim: m.claim, prefix: m.prefix ?? "oidc:" });

/** An issuer claim, or the fixed groups plus one conditional term per email group. */
function groupMapping({ groups, emailGroups = {} }: Workforce) {
  if (groups && !Array.isArray(groups)) return mapping(groups as KubernetesOidcClaimMapping);
  const byEmail = Object.entries(emailGroups).map(([group, emails]) =>
    ` + (claims.email in ${JSON.stringify(emails)} ? [${JSON.stringify(group)}] : [])`).join("");
  return groups || byEmail ? { expression: JSON.stringify(groups ?? []) + byEmail } : undefined;
}

function workforceAuthenticator(workforce: Workforce) {
  const username = workforce.username ?? { claim: "email" };
  const groups = groupMapping(workforce);
  const readsEmail = username.claim === "email" || workforce.emailDomain || Object.keys(workforce.emailGroups ?? {}).length;
  const inDomain = workforce.emailDomain ? ` && claims.email.endsWith(${JSON.stringify(`@${workforce.emailDomain}`)})` : "";
  return {
    issuer: issuer(workforce),
    claimValidationRules: [
      lifetime(workforce),
      ...(readsEmail ? [{
        expression: `claims.email_verified == true${inDomain}`,
        message: "A verified email matching the configured identity policy is required",
      }] : []),
      ...Object.entries(workforce.requiredClaims ?? {}).map(([claim, requiredValue]) => ({ claim, requiredValue })),
    ],
    claimMappings: { username: mapping(username), uid: { claim: "sub" }, ...(groups ? { groups } : {}) },
    userValidationRules: [notSystemUser(), notSystemGroups()],
  };
}

function workloadAuthenticator(workload: Workload) {
  return {
    issuer: issuer(workload),
    claimValidationRules: [
      lifetime(workload),
      { expression: `claims.sub in ${JSON.stringify([...workload.subjects])}`, message: "Workload is not allowed in this cluster" },
      { expression: `has(claims['kubernetes.io'].pod) && has(claims['kubernetes.io'].pod.uid)`, message: "A pod-bound workload token is required" },
    ],
    claimMappings: { username: { expression: `'${WORKLOAD_USERNAME_PREFIX}' + claims.sub` }, uid: { claim: "sub" } },
    userValidationRules: [notSystemUser()],
  };
}

/** Anonymous authentication is configured by the containing control plane. */
export function authenticationConfiguration(config: KubernetesOidcIdentityConfig): Record<string, unknown> {
  return {
    apiVersion: "apiserver.config.k8s.io/v1", kind: "AuthenticationConfiguration",
    jwt: [workforceAuthenticator(config.workforce), ...(config.workload ? [workloadAuthenticator(config.workload)] : [])],
  };
}
