import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import { parseAllDocuments, stringify as yaml } from "yaml";
import { initDataDocument, INIT_DATA_ANNOTATION, initDataSha256 } from "../confidential-guests/measured";
import type { TrusteeDeploymentManifest } from "./manifests";
import type { TrusteeConfig, TrusteeNetworkConfig } from "./types";

const asset = (name: string) => readFileSync(new URL(`./assets/genpolicy/${name}`, import.meta.url), "utf8");
export const GENPOLICY_REVISION = "5b57d5c41ffb9d9515e76ef51cfa851068cfc439";

export function validateNetwork(network: TrusteeNetworkConfig): void {
  for (const key of ["ipv4AddressPattern", "ipv6AddressPattern"] as const) {
    const pattern = network?.[key];
    if (typeof pattern !== "string" || pattern.length > 256 || !pattern.startsWith("^") || !pattern.endsWith("$")) {
      throw new TypeError("Trustee: provide anchored CNI address patterns");
    }
    new RegExp(pattern);
  }
}

/** genpolicy does not model these Kubernetes-only controls. Keep them in the
 * Helm Deployment and project just these known fields out of generator input.
 * UID/GID, mount permissions and absence of credentials are enforced in Rego. */
export function genpolicyInput(workload: TrusteeDeploymentManifest): object {
  const copy = structuredClone(workload) as any;
  const spec = copy.spec.template.spec;
  delete spec.automountServiceAccountToken;
  delete spec.enableServiceLinks;
  delete spec.securityContext.runAsNonRoot;
  delete spec.securityContext.seccompProfile;
  return copy;
}

/** Native genpolicy writes Init-Data itself. Nebula never edits, repackages or
 * accepts a caller-supplied policy. Expected identity comes from these bytes. */
export function generateTrusteePolicy(workload: TrusteeDeploymentManifest, aaToml: string, config: TrusteeConfig) {
  validateNetwork(config.network);
  const directory = mkdtempSync(join(tmpdir(), "nebula-trustee-genpolicy-"));
  try {
    const rules = `${asset("rules.rego")}\n${asset("trustee.rego")}\ntrustee_network := ${JSON.stringify(config.network)}\n`;
    const rulesPath = join(directory, "rules.rego");
    const settingsPath = join(directory, "genpolicy-settings.json");
    const initdataPath = join(directory, "initdata.toml");
    writeFileSync(rulesPath, rules);
    writeFileSync(settingsPath, asset("genpolicy-settings.json"));
    const distribution = config.k8sDistribution ?? "k0s", ociVersion = config.ociVersion ?? "1.3.0";
    if (!["k0s", "kubernetes"].includes(distribution) || !["1.1.0", "1.2.0", "1.3.0"].includes(ociVersion)) {
      throw new TypeError("Trustee: unsupported genpolicy runtime settings");
    }
    const bundle = `/run/${distribution === "k0s" ? "k0s/" : ""}containerd/io.containerd.runtime.v2.task/k8s.io/$(bundle-id)`;
    const dropins = join(directory, "genpolicy-settings.d");
    mkdirSync(dropins);
    writeFileSync(join(dropins, "10-runtime.json"), JSON.stringify([
      { op: "replace", path: "/kata_config/oci_version", value: ociVersion },
      ...["pause_container", "other_container"].map(key => ({ op: "replace",
        path: `/${key}/Annotations/io.katacontainers.pkg.oci.bundle_path`, value: bundle })),
    ]));
    writeFileSync(initdataPath, stringify({ version: "0.1.0", algorithm: "sha256", data: { "aa.toml": aaToml } }));
    const cache = config.genpolicy?.cacheDirectory ? resolve(config.genpolicy.cacheDirectory) : directory;
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    let output: string;
    try {
      const executable = config.genpolicy?.executable ?? "genpolicy";
      const version = execFileSync(executable, ["--version", "-j", directory],
        { cwd: directory, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      if (!version.includes(GENPOLICY_REVISION) || version.includes("-dirty")) throw new Error("Unexpected genpolicy revision");
      output = execFileSync(executable, ["-p", rulesPath, "-j", directory,
        `--initdata-path=${initdataPath}`, "--use-cached-files"], { cwd: cache, input: yaml(genpolicyInput(workload)),
        encoding: "utf8", timeout: 600_000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "error" } });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr;
      throw new Error(`Trustee: native genpolicy failed; use revision ${GENPOLICY_REVISION}. ${stderr?.slice(-2000) ?? "Check the executable and registry access."}`);
    }
    const documents = parseAllDocuments(output);
    if (documents.length !== 1 || documents.some(document => document.errors.length)) throw new Error("Trustee: invalid genpolicy output");
    const generated = documents[0].toJSON();
    const encoded = generated?.spec?.template?.metadata?.annotations?.[INIT_DATA_ANNOTATION];
    if (typeof encoded !== "string") throw new Error("Trustee: genpolicy did not produce native Init-Data");
    const document = parse(initDataDocument(encoded).toString("utf8")) as any;
    if (document.version !== "0.1.0" || document.algorithm !== "sha256" ||
        Object.keys(document.data ?? {}).sort().join() !== "aa.toml,policy.rego" || document.data["aa.toml"] !== aaToml) {
      throw new Error("Trustee: genpolicy changed the guest configuration");
    }
    const parts = document.data["policy.rego"].split("\npolicy_data := ");
    if (parts.length !== 2 || parts[0] !== rules) throw new Error("Trustee: genpolicy changed the rules profile");
    const data = JSON.parse(parts[1]);
    if (data.containers?.length !== workload.spec.template.spec.containers.length + 1 || data.cluster_config.guest_pull !== true) {
      throw new Error("Trustee: incompatible genpolicy guest-pull output");
    }
    for (const container of workload.spec.template.spec.containers) {
      const policy = data.containers.find((item: any) => item.OCI.Annotations["io.kubernetes.cri.container-name"] === container.name);
      if (!policy || policy.image !== container.image ||
          !isDeepStrictEqual(policy.OCI.Process.Args, [...container.command!, ...container.args!]) ||
          policy.OCI.Root.Readonly !== true || policy.OCI.Process.NoNewPrivileges !== true ||
          policy.OCI.Process.User.UID !== 10001 || policy.OCI.Process.User.GID !== 10001 ||
          policy.OCI.Process.Capabilities.Bounding.length !== 0 || policy.exec_commands.length !== 0 ||
          policy.OCI.Mounts.some((mount: any) => mount.destination.startsWith("/var/run/secrets/")) ||
          policy.storages.length !== container.volumeMounts!.length ||
          policy.storages.some((storage: any) => storage.driver !== "ephemeral" || storage.fstype !== "tmpfs" || storage.source !== "tmpfs") ||
          container.env!.some(variable => !policy.OCI.Process.Env.includes(`${variable.name}=${variable.value}`))) {
        throw new Error(`Trustee: genpolicy did not bind the required image, process or guest storage for ${container.name}`);
      }
    }
    return { ccInitData: encoded, initDataSha256: initDataSha256(encoded) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
