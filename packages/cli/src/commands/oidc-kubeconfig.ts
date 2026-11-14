import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { parse, parseAllDocuments, stringify } from "yaml";
import { KubernetesOidcIdentity, kubernetesOidcNativeClientInput, type KubernetesOidcIdentityConfig } from "nebula-cdk8s";

export interface OidcKubeconfigOptions {
  /** Local JSON KubernetesOidcIdentityConfig; `-` reads standard input. */
  config: string;
  /** Protected local native/Desktop registration JSON; never fetched from Kubernetes. */
  clientConfig?: string;
  /** Output path; defaults to ~/.nebula/<cluster>/kubeconfig-oidc. */
  output?: string;
  /** Optional local PEM CA for the API endpoint; system trust is the default. */
  caFile?: string;
  /** Directory of synthesized manifests whose control-plane authenticator the identity must match. */
  rendered?: string;
}

export interface OidcProfile {
  readonly cluster: string;
  readonly output: string;
  readonly kubeconfig: string;
  readonly authentication: Record<string, unknown>;
  /** Credential helper the profile runs; it must be installed where kubectl is used. */
  readonly command: string;
}

function localPath(value: string): string {
  return path.resolve(value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value);
}

function readJson(file: string | number): unknown {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`Cannot read valid local OIDC JSON: ${file === 0 ? "standard input" : file}`); }
}

function nativeRegistration(identity: KubernetesOidcIdentity, clientConfig?: string): string | undefined {
  if (identity.config.workforce.login?.clientAuthentication !== "client-secret") {
    if (clientConfig) throw new Error("A native registration requires workforce.login.clientAuthentication: client-secret");
    return undefined;
  }
  const file = localPath(clientConfig ?? path.join(os.homedir(), ".config/nebula/oidc", `${identity.config.cluster}.json`));
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || ![0o400, 0o600].includes(stat.mode & 0o777) || stat.size > 16 * 1024 ||
    (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Native OIDC registration must be an owner-only regular local file (0400/0600, at most 16 KiB)");
  kubernetesOidcNativeClientInput({ issuer: identity.config.workforce.url, clientId: identity.config.workforce.audience },
    readJson(file) as Record<string, string>);
  return file;
}

function certificateAuthority(file: string): string {
  const ca = fs.readFileSync(localPath(file), "utf8");
  const certificates = ca.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g) ?? [];
  if (!certificates.length || certificates.join("").replace(/\s/g, "") !== ca.replace(/\s/g, ""))
    throw new Error("OIDC endpoint CA must contain only PEM certificates");
  for (const certificate of certificates) new X509Certificate(certificate);
  return Buffer.from(ca).toString("base64");
}

/** Build a certificate-free sign-in profile from local inputs only; nothing is written. */
export function buildOidcProfile(options: OidcKubeconfigOptions, stateRoot = path.join(os.homedir(), ".nebula")): OidcProfile {
  const fromInput = options.config === "-";
  const identity = new KubernetesOidcIdentity(readJson(fromInput ? 0 : localPath(options.config)) as KubernetesOidcIdentityConfig);
  const clientCredentialFile = nativeRegistration(identity, options.clientConfig);
  const profile = identity.userKubeconfig({ ...(clientCredentialFile ? { clientCredentialFile } : {}) }) as {
    clusters: { cluster: Record<string, unknown> }[];
    users: { user: { exec: { command: string } } }[];
  };
  if (options.caFile) profile.clusters[0]!.cluster["certificate-authority-data"] = certificateAuthority(options.caFile);
  const output = localPath(options.output ?? path.join(stateRoot, identity.config.cluster, "kubeconfig-oidc"));
  const inputs = [fromInput ? undefined : options.config, clientCredentialFile, options.caFile];
  if (inputs.some(file => file && localPath(file) === output)) throw new Error("OIDC output must not replace a local OIDC input");
  const result = {
    cluster: identity.config.cluster, output, kubeconfig: stringify(profile),
    authentication: identity.authenticationConfiguration(), command: profile.users[0]!.user.exec.command,
  };
  existingOutput(result);
  return result;
}

/** True when the identical protected profile is already in place; any other existing file is refused. */
function existingOutput({ output, kubeconfig }: OidcProfile): boolean {
  let stat: fs.Stats;
  try { stat = fs.lstatSync(output); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()) || fs.readFileSync(output, "utf8") !== kubeconfig)
    throw new Error("Refusing to replace an existing or unprotected OIDC output file");
  return true;
}

/** The authentication configuration a rendered control plane hands its API server, or undefined. */
function renderedAuthentication(objects: any[], cluster: string): unknown {
  const owner = objects.find(object => object?.kind === "Cluster" && object.metadata?.name === cluster);
  const ref = owner?.spec?.controlPlaneRef;
  const namespace = owner?.metadata?.namespace ?? "default";
  const controlPlane = objects.find(object => object?.kind === ref?.kind && object.metadata?.name === ref?.name &&
    (object.metadata?.namespace ?? "default") === namespace);
  // A control plane on its own machines carries the file in its bootstrap
  // configuration; one hosted as pods mounts it from a ConfigMap.
  const standalone = controlPlane?.spec?.k0sConfigSpec;
  const file: string | undefined = (standalone?.k0s ?? controlPlane?.spec?.k0sConfig)?.spec?.api?.extraArgs?.["authentication-config"];
  if (!file) return undefined;
  if (standalone) {
    const content = standalone.files?.find((item: { path: string }) => item.path === file)?.content;
    return typeof content === "string" ? parse(content) : undefined;
  }
  for (const mount of controlPlane.spec.mounts ?? []) {
    if (!mount.configMap?.name || !file.startsWith(`${mount.path}/`)) continue;
    const configMap = objects.find(object => object?.kind === "ConfigMap" && object.metadata?.name === mount.configMap.name &&
      (object.metadata?.namespace ?? "default") === namespace);
    const content = configMap?.data?.[file.slice(mount.path.length + 1)];
    if (typeof content === "string") return parse(content);
  }
  return undefined;
}

/** Check the identity against the authenticator a synthesized control plane will enforce. */
export function assertRenderedAuthenticator(directory: string, profile: OidcProfile): void {
  const objects = fs.readdirSync(directory).filter(file => file.endsWith(".k8s.yaml"))
    .flatMap(file => parseAllDocuments(fs.readFileSync(path.join(directory, file), "utf8")).map(document => document.toJSON()));
  if (!isDeepStrictEqual(renderedAuthentication(objects, profile.cluster), profile.authentication))
    throw new Error(`Local OIDC identity does not match the rendered control-plane authentication configuration of ${profile.cluster}`);
}

/** Write the profile unless the identical one exists; existing files are never replaced. */
export function writeOidcProfile(profile: OidcProfile): string {
  if (!existingOutput(profile)) {
    fs.mkdirSync(path.dirname(profile.output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(profile.output, profile.kubeconfig, { mode: 0o600, flag: "wx" });
  }
  return profile.output;
}

export async function oidcKubeconfig(options: OidcKubeconfigOptions): Promise<void> {
  const profile = buildOidcProfile(options);
  if (options.rendered) assertRenderedAuthenticator(localPath(options.rendered), profile);
  const output = writeOidcProfile(profile);
  const helper = profile.command === "kubectl" ? "the kubectl oidc-login plugin" : profile.command;
  console.log(`Sign-in kubeconfig for ${profile.cluster}: ${output}`);
  console.log(`Requires ${helper} on this machine.`);
  console.log(`   export KUBECONFIG="${output}"`);
  console.log("   kubectl auth whoami");
}
