import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { assertOidcAuthenticator, buildOidcProfile, readRenderedAuthentication, type OidcProfile } from "../oidc-kubeconfig";
import type { BootstrapOptions } from "./types";

/** Validate the operator handoff against the exact cluster manifests before applying them. */
export function prepareBootstrapOidcProfile(
  rendered: string,
  cluster: string,
  options: Pick<BootstrapOptions, "oidcConfig" | "oidcClientConfig" | "oidcCaFile">,
  stateRoot?: string,
): OidcProfile | undefined {
  const authentication = readRenderedAuthentication(rendered, cluster);
  if (!Array.isArray(authentication?.jwt) || !authentication.jwt.length) {
    if (options.oidcConfig || options.oidcClientConfig || options.oidcCaFile)
      throw new Error(`Cluster ${cluster} has no rendered OIDC authenticator`);
    return undefined;
  }
  if (!options.oidcConfig)
    throw new Error(`Cluster ${cluster} uses OIDC authentication. Supply --oidc-config with its local workforce identity JSON.`);
  const profile = buildOidcProfile({
    config: options.oidcConfig,
    clientConfig: options.oidcClientConfig,
    caFile: options.oidcCaFile,
  }, stateRoot);
  if (profile.cluster !== cluster) throw new Error(`Local OIDC identity must name the management cluster ${cluster}`);
  assertOidcAuthenticator(authentication, profile);
  return profile;
}

/** Expose a private admin kubeconfig path only for the duration of OIDC bootstrap. */
export async function withTemporaryBootstrapKubeconfig<T>(use: (file: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-bootstrap-"));
  try {
    return await use(path.join(directory, "kubeconfig"));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
