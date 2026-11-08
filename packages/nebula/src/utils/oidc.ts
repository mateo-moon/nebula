/** Standard issuer metadata shared by token validators and HTTPS proxies. */
export interface OidcIssuer {
  url: string;
  jwksUrl: string;
  audience: string;
  /** Public PEM trust bundle; omit for an issuer using system trust roots. */
  certificateAuthority?: string;
}

export function validateOidcHttpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`OIDC URLs must use HTTPS without credentials, query or fragment: ${value}`);
  return url;
}
