import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, parseAllDocuments, stringify } from "yaml";
import { KubernetesOidcIdentity, kubernetesOidcNativeClientInput, type KubernetesOidcIdentityConfig } from "nebula-cdk8s";
import type { BootstrapOptions } from "./types";

export interface OidcHandoff {
  readonly output: string;
  readonly kubeconfig: string;
  readonly authentication: Record<string, unknown>;
  readonly command: string;
}

function localPath(value: string): string {
  return path.resolve(value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

function readJson(file: string): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`Cannot read valid local OIDC JSON: ${file}`); }
}

/** Prepare a certificate-free profile entirely from local configuration. */
export function prepareOidcHandoff(cluster: string, stateDirectory: string, options: BootstrapOptions): OidcHandoff | undefined {
  if (!options.oidcConfig) {
    if (options.oidcClientConfig || options.oidcKubeconfig || options.oidcCaFile)
      throw new Error("OIDC handoff options require --oidc-config");
    return undefined;
  }
  const identity = new KubernetesOidcIdentity(readJson(localPath(options.oidcConfig)) as KubernetesOidcIdentityConfig);
  if (identity.config.cluster !== cluster) throw new Error("OIDC identity must name the management cluster being bootstrapped");
  const nativeClient = identity.config.workforce.login?.clientAuthentication === "client-secret";
  let clientCredentialFile: string | undefined;
  if (nativeClient) {
    clientCredentialFile = localPath(options.oidcClientConfig ?? path.join(os.homedir(), ".config/nebula/oidc", `${cluster}.json`));
    const stat = fs.lstatSync(clientCredentialFile);
    if (!stat.isFile() || ![0o400, 0o600].includes(stat.mode & 0o777) || stat.size > 16 * 1024 ||
      (process.getuid && stat.uid !== process.getuid()))
      throw new Error("Native OIDC registration must be an owner-only regular local file (0400/0600, at most 16 KiB)");
    kubernetesOidcNativeClientInput({ issuer: identity.config.workforce.url, clientId: identity.config.workforce.audience },
      readJson(clientCredentialFile) as Record<string, string>);
  } else if (options.oidcClientConfig) {
    throw new Error("A native registration requires workforce.login.clientAuthentication: client-secret");
  }
  const profile = identity.userKubeconfig({ ...(clientCredentialFile ? { clientCredentialFile } : {}) }) as {
    clusters: { cluster: Record<string, unknown> }[];
    users: { user: { exec: { command: string } } }[];
  };
  if (options.oidcCaFile) {
    const ca = fs.readFileSync(localPath(options.oidcCaFile), "utf8");
    const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
    if (!certificates.length || certificates.join("").replace(/\s/g, "") !== ca.replace(/\s/g, ""))
      throw new Error("OIDC endpoint CA must contain only PEM certificates");
    for (const certificate of certificates) new X509Certificate(certificate);
    profile.clusters[0]!.cluster["certificate-authority-data"] = Buffer.from(ca).toString("base64");
  }
  const output = localPath(options.oidcKubeconfig ?? path.join(stateDirectory, "kubeconfig-oidc"));
  if ([path.join(stateDirectory, "kubeconfig"), options.oidcConfig, clientCredentialFile, options.oidcCaFile]
    .filter((file): file is string => !!file).some(file => localPath(file) === output))
    throw new Error("OIDC output must not replace bootstrap credentials or local OIDC inputs");
  const handoff = { output, kubeconfig: stringify(profile), authentication: identity.authenticationConfiguration(), command: profile.users[0]!.user.exec.command };
  checkExistingOutput(handoff);
  return handoff;
}

function checkExistingOutput({ output, kubeconfig }: OidcHandoff): boolean {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(output); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || fs.readFileSync(output, "utf8") !== kubeconfig)
    throw new Error("Refusing to replace an existing or unprotected OIDC output file");
  return true;
}

/** Ensure local client inputs describe the actual management authenticator before applying CAPI resources. */
export function assertManagementOidc(directory: string, cluster: string, handoff?: OidcHandoff): void {
  const objects = fs.readdirSync(directory).filter(file => file.endsWith(".k8s.yaml"))
    .flatMap(file => parseAllDocuments(fs.readFileSync(path.join(directory, file), "utf8")).map(document => document.toJSON()));
  const management = objects.find(object => object?.kind === "Cluster" && object.metadata?.name === cluster);
  const ref = management?.spec?.controlPlaneRef;
  const cp = objects.find(object => object?.kind === "K0sControlPlane" && object.metadata?.name === ref?.name &&
    (object.metadata?.namespace ?? "default") === (management?.metadata?.namespace ?? "default"));
  const config = cp?.spec?.k0sConfigSpec;
  const authenticationPath = config?.k0s?.spec?.api?.extraArgs?.["authentication-config"];
  if (!handoff) {
    if (authenticationPath) throw new Error("OIDC-enabled management bootstrap requires --oidc-config for the operator handoff");
    return;
  }
  const file = config?.files?.find((item: { path: string }) => item.path === authenticationPath);
  if (!authenticationPath || typeof file?.content !== "string" || !isDeepStrictEqual(parse(file.content), handoff.authentication))
    throw new Error("Local OIDC identity does not match the management control-plane authentication configuration");
}

/** Preserve existing files and write only the new sign-in profile. */
export function writeOidcHandoff(handoff: OidcHandoff): string {
  if (!checkExistingOutput(handoff)) {
    fs.mkdirSync(path.dirname(handoff.output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(handoff.output, handoff.kubeconfig, { mode: 0o600, flag: "wx" });
  }
  return handoff.output;
}
