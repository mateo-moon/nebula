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

export function oidcTokenLifetimeSeconds(issuer: Pick<OidcIssuer, "maxTokenLifetimeSeconds">, defaultSeconds: number): number {
  const seconds = issuer.maxTokenLifetimeSeconds ?? defaultSeconds;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600)
    throw new Error("OIDC token lifetime must be a positive integer of at most 3600 seconds");
  return seconds;
}

export function validateOidcIssuer(issuer: OidcIssuer): void {
  validateOidcHttpsUrl(issuer.url); validateOidcHttpsUrl(issuer.jwksUrl);
  validateOidcAudience(issuer.audience);
  if (issuer.maxTokenLifetimeSeconds !== undefined) oidcTokenLifetimeSeconds(issuer, 600);
}

export function validateOidcAudience(audience: string): void {
  if (!isExact(audience)) throw new Error("OIDC requires one exact, non-empty audience");
}

/** One exact value: non-empty, without whitespace, wildcard or control character. */
export const isExact = (value: unknown): value is string =>
  typeof value === "string" && value !== "" && !/[\s*\u0000-\u001f\u007f]/.test(value);
export const hasControlCharacter = (value: string): boolean => /[\u0000-\u001f\u007f]/.test(value);
/** A lower-case DNS name of at least two characters: a host, domain or backend. */
export const isDnsName = (value: string): boolean => /^[a-z0-9][a-z0-9.-]+$/.test(value);
/** A Kubernetes object name as these modules accept it. */
export const isResourceName = (value: string): boolean => /^[a-z0-9][a-z0-9.-]*$/.test(value);
/** A cluster name, also used in resource names, token paths and audiences. */
export const isClusterName = (value: string): boolean => /^[a-z][a-z0-9-]*$/.test(value);

export function validateOidcHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`OIDC URLs must use HTTPS without credentials, query or fragment: ${value}`);
  return url;
}
