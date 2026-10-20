import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "fflate";
import { parse, stringify } from "smol-toml";
import { parseAllDocuments, stringify as yaml } from "yaml";
import { initDataDocument, INIT_DATA_ANNOTATION, initDataSha256, type GuestPodManifest } from "../confidential-guests/measured";
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

/** Upstream InitData uses a HashMap, whose TOML field order changes across
 * processes. Serialize only its envelope in fixed order; native policy and AA
 * strings remain byte-for-byte identical. No policy can be supplied by callers. */
export function deterministicInitData(encoded: string, configKeys = ["aa.toml"]): string {
  const original = parse(initDataDocument(encoded).toString("utf8")) as any;
  if (Object.keys(original).sort().join() !== "algorithm,data,version" ||
      original.version !== "0.1.0" || original.algorithm !== "sha256" ||
      Object.keys(original.data ?? {}).sort().join() !== [...configKeys, "policy.rego"].sort().join() ||
      Object.values(original.data).some(value => typeof value !== "string")) {
    throw new Error("Trustee: unexpected native Init-Data envelope");
  }
  const document = stringify({ version: original.version, algorithm: original.algorithm,
    data: Object.fromEntries([...configKeys, "policy.rego"].sort().map(key => [key, original.data[key]])) });
  if (!isDeepStrictEqual(parse(document), original)) throw new Error("Trustee: Init-Data serialization changed its contents");
  // Pinned pure-JS compression is independent of Node's platform zlib version.
  const compressed = gzipSync(Buffer.from(document), { level: 9, mtime: 0 });
  // A fixed OS byte avoids a platform-specific gzip header in the Pod template.
  compressed[9] = 255;
  return Buffer.from(compressed).toString("base64");
}

/** Generate and validate native policy, then stabilize the transport envelope.
 * Expected identity always hashes the exact bytes sent to the guest. */
export function generateTrusteePolicy(workload: TrusteeDeploymentManifest, aaToml: string, config: TrusteeConfig) {
  return generatePolicy(genpolicyInput(workload), workload.spec.template.spec.containers,
    { "aa.toml": aaToml }, config, asset("trustee.rego"), true);
}

type NativePolicyConfig = Pick<TrusteeConfig, "network" | "genpolicy" | "k8sDistribution" | "ociVersion">;

/** Native guest policy for workloads consuming an attested Trustee. Public
 * bootstrap sidecars start before encrypted containers; all run in one TEE.
 * Callers supply Kubernetes declarations and measured CoCo configuration, never
 * a pre-generated policy or an observed identity. */
export function generateAttestedWorkloadPolicy(workload: GuestPodManifest,
  guestConfig: { "aa.toml": string; "cdh.toml": string }, config: NativePolicyConfig) {
  return generateWorkloadPolicy(workload, guestConfig, config, false);
}

/** Combined-workload builder entry point. Raw block devices remain ciphertext;
 * only the measured storage helper and mount launcher receive added capabilities. */
export function generateConfidentialWorkloadPolicy(workload: GuestPodManifest,
  guestConfig: { "aa.toml": string; "cdh.toml": string }, config: NativePolicyConfig) {
  return generateWorkloadPolicy(workload, guestConfig, config, true);
}

function generateWorkloadPolicy(workload: GuestPodManifest,
  guestConfig: { "aa.toml": string; "cdh.toml": string }, config: NativePolicyConfig, block: boolean) {
  if (workload.kind !== "Pod" || !workload.spec) throw new TypeError("Attested workload requires a Pod");
  const copy = structuredClone(workload) as any;
  const spec = copy.spec;
  if (!["kata-qemu-snp", "kata-qemu-tdx"].includes(spec.runtimeClassName) ||
      spec.automountServiceAccountToken !== false || spec.enableServiceLinks !== false ||
      spec.hostNetwork || spec.hostPID || spec.hostIPC || spec.shareProcessNamespace || spec.ephemeralContainers?.length ||
      spec.volumes?.some((volume: any) =>
        !(Object.keys(volume).sort().join() === "emptyDir,name" && volume.emptyDir.medium === "Memory") &&
        !(block && Object.keys(volume).sort().join() === "name,persistentVolumeClaim" &&
          Object.keys(volume.persistentVolumeClaim).join() === "claimName"))) {
    throw new TypeError("Attested workload requires private namespaces, no API credentials and only guest tmpfs");
  }
  const containers = [...(spec.initContainers ?? []), ...spec.containers];
  if (containers.length < 1 || new Set(containers.map(c => c.name)).size !== containers.length) throw new TypeError("Invalid workload containers");
  for (const container of containers) {
    const security = container.securityContext;
    if (!container.image?.match(/@sha256:[a-f0-9]{64}$/) || !container.command?.length || !Array.isArray(container.args) ||
        container.envFrom?.length || container.env?.some((e: any) => typeof e.value !== "string" || e.valueFrom) ||
        container.volumeMounts?.some((m: any) => m.subPath || m.subPathExpr || m.mountPropagation) ||
        !security || security.privileged || security.allowPrivilegeEscalation !== false || security.readOnlyRootFilesystem !== true ||
        !Number.isSafeInteger(security.runAsUser) || security.runAsUser < 0 ||
        !Number.isSafeInteger(security.runAsGroup) || security.runAsGroup < 0 ||
        security.capabilities?.drop?.join() !== "ALL" ||
        security.capabilities?.add?.some((cap: string) => !(block
          ? ["SETUID", "SETGID", "SYS_CHROOT", "SYS_ADMIN", "SETPCAP", "MKNOD", "CHOWN"]
          : ["SETUID", "SETGID", "SYS_CHROOT"]).includes(cap))) {
      throw new TypeError(`Invalid attested workload container ${container.name}`);
    }
    delete security.runAsNonRoot;
    delete security.seccompProfile;
  }
  if (spec.initContainers?.some((c: any) => c.restartPolicy !== "Always" &&
      !(block && c.name === "nebula-install-storage" && c.restartPolicy === undefined))) {
    throw new TypeError("Only persistent bootstrap sidecars and the measured storage installer are supported");
  }
  delete spec.automountServiceAccountToken;
  delete spec.enableServiceLinks;
  // RuntimeClass overhead affects host scheduling only. VM sizing remains in
  // the independently measured launch identity.
  delete spec.overhead;
  if (spec.securityContext) {
    delete spec.securityContext.runAsNonRoot;
    delete spec.securityContext.seccompProfile;
  }
  if (Object.keys(guestConfig).sort().join() !== "aa.toml,cdh.toml" || Object.values(guestConfig).some(v => typeof v !== "string")) {
    throw new TypeError("Expected measured AA and CDH configuration");
  }
  return generatePolicy(copy, containers, guestConfig, config, asset("client.rego"), false, block);
}

function generatePolicy(workload: any, containers: readonly any[], guestConfig: Record<string, string>,
  config: NativePolicyConfig, profile: string, trustee: boolean, block = false) {
  validateNetwork(config.network);
  const directory = mkdtempSync(join(tmpdir(), "nebula-trustee-genpolicy-"));
  try {
    let nativeRules = asset("rules.rego");
    if (block) {
      // Select stricter device predicates in genpolicy's INPUT rules. Generated
      // policy data and native output are never patched after synthesis.
      nativeRules = nativeRules
        .replace("allow_linux_devices(p_oci.Linux.Devices, i_oci.Linux.Devices)",
          "confidential_linux_devices(p_oci.Linux.Devices, i_oci.Linux.Devices)")
        .replace("allow_volume_devices(p_volume_devices, i_volume_devices)",
          "confidential_volume_devices(p_volume_devices, i_volume_devices)");
      profile += `\n${asset("confidential-block.rego")}`;
    }
    const rules = `${nativeRules}\n${profile}\ntrustee_network := ${JSON.stringify(config.network)}\n`;
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
    writeFileSync(initdataPath, stringify({ version: "0.1.0", algorithm: "sha256", data: guestConfig }));
    const cache = config.genpolicy?.cacheDirectory ? resolve(config.genpolicy.cacheDirectory) : directory;
    mkdirSync(cache, { recursive: true, mode: 0o700 });
    let output: string;
    try {
      const executable = config.genpolicy?.executable ?? "genpolicy";
      const version = execFileSync(executable, ["--version", "-j", directory],
        { cwd: directory, encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
      if (!version.includes(GENPOLICY_REVISION) || version.includes("-dirty")) throw new Error("Unexpected genpolicy revision");
      output = execFileSync(executable, ["-p", rulesPath, "-j", directory,
        `--initdata-path=${initdataPath}`, "--use-cached-files"], { cwd: cache, input: yaml(workload),
        encoding: "utf8", timeout: 600_000, maxBuffer: 4 * 1024 * 1024, stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, RUST_LOG: "error" } });
    } catch (error) {
      const stderr = (error as { stderr?: string }).stderr;
      throw new Error(`Trustee: native genpolicy failed; use revision ${GENPOLICY_REVISION}. ${stderr?.slice(-2000) ?? "Check the executable and registry access."}`);
    }
    const documents = parseAllDocuments(output);
    if (documents.length !== 1 || documents.some(document => document.errors.length)) throw new Error("Trustee: invalid genpolicy output");
    const generated = documents[0].toJSON();
    const encoded = (generated.kind === "Pod" ? generated.metadata : generated?.spec?.template?.metadata)?.annotations?.[INIT_DATA_ANNOTATION];
    if (typeof encoded !== "string") throw new Error("Trustee: genpolicy did not produce native Init-Data");
    const document = parse(initDataDocument(encoded).toString("utf8")) as any;
    if (document.version !== "0.1.0" || document.algorithm !== "sha256" ||
        Object.keys(document.data ?? {}).sort().join() !== [...Object.keys(guestConfig), "policy.rego"].sort().join() ||
        Object.entries(guestConfig).some(([key, value]) => document.data[key] !== value)) {
      throw new Error("Trustee: genpolicy changed the guest configuration");
    }
    const parts = document.data["policy.rego"].split("\npolicy_data := ");
    if (parts.length !== 2 || parts[0] !== rules) throw new Error("Trustee: genpolicy changed the rules profile");
    const data = JSON.parse(parts[1]);
    if (data.containers?.length !== containers.length + 1 || data.cluster_config.guest_pull !== true) {
      throw new Error("Trustee: incompatible genpolicy guest-pull output");
    }
    for (const container of containers) {
      const policy = data.containers.find((item: any) => item.OCI.Annotations["io.kubernetes.cri.container-name"] === container.name);
      if (!policy || policy.image !== container.image ||
          !isDeepStrictEqual(policy.OCI.Process.Args, [...container.command!, ...container.args!]) ||
          policy.OCI.Root.Readonly !== true || policy.OCI.Process.NoNewPrivileges !== true ||
          policy.OCI.Process.User.UID !== (trustee ? 10001 : container.securityContext.runAsUser) ||
          policy.OCI.Process.User.GID !== (trustee ? 10001 : container.securityContext.runAsGroup) ||
          !isDeepStrictEqual([...policy.OCI.Process.Capabilities.Bounding].map((c: string) => c.replace(/^CAP_/, "")).sort(),
            trustee ? [] : [...(container.securityContext.capabilities.add ?? [])].sort()) || policy.exec_commands.length !== 0 ||
          policy.OCI.Mounts.some((mount: any) => mount.destination.startsWith("/var/run/secrets/")) ||
          policy.storages.length !== (container.volumeMounts ?? []).length ||
          policy.storages.some((storage: any) => storage.driver !== "ephemeral" || storage.fstype !== "tmpfs" || storage.source !== "tmpfs") ||
          (container.env ?? []).some((variable: any) => !policy.OCI.Process.Env.includes(`${variable.name}=${variable.value}`))) {
        throw new Error(`Trustee: genpolicy did not bind the required image, process or guest storage for ${container.name}`);
      }
    }
    const ccInitData = deterministicInitData(encoded, Object.keys(guestConfig));
    return { ccInitData, initDataSha256: initDataSha256(ccInitData) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
