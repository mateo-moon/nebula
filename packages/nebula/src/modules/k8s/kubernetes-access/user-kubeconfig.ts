import type { KubernetesOidcIdentityConfig, KubernetesOidcLoginOptions } from "./identity";

const loopbackHosts = ["127.0.0.1", "[::1]", "localhost"];

function validateCallback({ redirectUrl, listenAddress }: KubernetesOidcLoginOptions): void {
  if (redirectUrl) {
    const url = new URL(redirectUrl);
    if (url.protocol !== "http:" || !loopbackHosts.includes(url.hostname) || url.username || url.password || url.search || url.hash)
      throw new Error("OIDC desktop callbacks must use an HTTP loopback URL");
  }
  if (listenAddress && !/^(127\.0\.0\.1|localhost|\[::1\]):[0-9]+$/.test(listenAddress))
    throw new Error("OIDC desktop listeners must bind a loopback address");
}

const when = (condition: unknown, argument: string) => condition ? [argument] : [];

/** A kubectl exec profile. It names the issuer and client; it holds no token,
 * certificate or key, and the argument order is part of its public bytes. */
export function userKubeconfig(c: KubernetesOidcIdentityConfig, options: KubernetesOidcLoginOptions = {}): object {
  validateCallback(options);
  const login = c.workforce.login;
  const user = `oidc-${c.cluster}`;
  const grantType = options.grantType ?? login?.grantType;
  // A provider that needs an app credential uses the adapter, which reads it from a protected file.
  const credentialFile = login?.clientAuthentication === "client-secret" || options.clientCredentialFile !== undefined;
  const authParams = Object.entries(login?.authRequestExtraParams ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const args = [
    ...when(!options.command && !credentialFile, "oidc-login"),
    "get-token",
    `--oidc-issuer-url=${c.workforce.url}`,
    `--oidc-client-id=${c.workforce.audience}`,
    ...when(credentialFile, `--oidc-client-secret-file=${options.clientCredentialFile ?? `~/.config/nebula/oidc/${c.cluster}.json`}`),
    ...[...new Set(login?.extraScopes ?? ["email", "offline_access"])].map(scope => `--oidc-extra-scope=${scope}`),
    ...authParams.map(([key, value]) => `--oidc-auth-request-extra-params=${key}=${value}`),
    "--oidc-pkce-method=S256",
    `--token-cache-storage=${options.tokenCacheStorage ?? "keyring"}`,
    ...when(grantType, `--grant-type=${grantType}`),
    ...when(options.tokenCacheDirectory, `--token-cache-dir=${options.tokenCacheDirectory}`),
    ...when(options.skipOpenBrowser, "--skip-open-browser"),
    ...when(options.redirectUrl, `--oidc-redirect-url=${options.redirectUrl}`),
    ...when(options.listenAddress, `--listen-address=${options.listenAddress}`),
  ];
  return {
    apiVersion: "v1", kind: "Config",
    clusters: [{ name: c.cluster, cluster: { server: `https://${c.hostname}` } }],
    users: [{ name: user, user: { exec: {
      apiVersion: "client.authentication.k8s.io/v1",
      command: options.command ?? (credentialFile ? "nebula-oidc-login" : "kubectl"),
      interactiveMode: "IfAvailable", provideClusterInfo: false, args,
    } } }],
    contexts: [{ name: c.cluster, context: { cluster: c.cluster, user } }],
    "current-context": c.cluster,
  };
}
