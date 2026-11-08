/** Standard issuer metadata shared by token validators and HTTPS proxies. */
export interface OidcIssuer {
  url: string;
  jwksUrl: string;
  audience: string;
  /** Public PEM trust bundle; omit for an issuer using system trust roots. */
  certificateAuthority?: string;
  /** Maximum issued/remaining JWT lifetime; defaults to the consumer's limit. */
  maxTokenLifetimeSeconds?: number;
}

export function oidcTokenLifetimeSeconds(issuer: OidcIssuer, defaultSeconds: number): number {
  const seconds = issuer.maxTokenLifetimeSeconds ?? defaultSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600)
    throw new Error("OIDC token lifetime must be a positive integer of at most 3600 seconds");
  return seconds;
}

export function validateOidcIssuer(issuer: OidcIssuer): void {
  validateOidcHttpsUrl(issuer.url); validateOidcHttpsUrl(issuer.jwksUrl);
  if (!issuer.audience || /[\s*\u0000-\u001f\u007f]/.test(issuer.audience))
    throw new Error("OIDC requires one exact, non-empty audience");
  if (issuer.maxTokenLifetimeSeconds !== undefined) oidcTokenLifetimeSeconds(issuer, 600);
}

export function validateOidcHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`OIDC URLs must use HTTPS without credentials, query or fragment: ${value}`);
  return url;
}
