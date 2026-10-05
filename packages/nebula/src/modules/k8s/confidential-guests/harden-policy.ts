import { isDeepStrictEqual } from "node:util";
import { readConfidentialGuestAsset } from "./assets";
import { canonicalJson, sha256Hex } from "./canonical";
import { decodeGuestPolicy, replaceGuestPolicy } from "./guest-policy";
import type { GuestPodManifest, MeasuredArtifact } from "./measured";
import * as v from "./validate";
import { digestImage } from "./types";

/** Parsed JSON from the generator; deployment checks can inspect and narrow each recipient. */
export type GuestPolicyObject = Record<string, any>;

export interface GuestPolicyGuards {
  readonly devices: string;
  readonly images: string;
  readonly requiredEnv: string;
  readonly transport: string;
  readonly peers?: string;
}

export interface GuestPolicyHardening {
  /** Exact reviewed generator rules and settings, before hardening. */
  readonly reviewed: { readonly rules: string; readonly settings: GuestPolicyObject };
  readonly requiredEnvRule: string;
  readonly guards: GuestPolicyGuards;
  /** The one block-device owner and its exact generated and hardened device shapes. */
  readonly storage: {
    readonly container: string;
    readonly generatedDevice: GuestPolicyObject;
    readonly generatedTransport: GuestPolicyObject;
    readonly controlDevices: readonly GuestPolicyObject[];
  };
  /** Other containers that receive exactly the declared native devices. */
  readonly nativeDevices?: Readonly<Record<string, readonly GuestPolicyObject[]>>;
  /** A declared shared-files ConfigMap mount whose predicted local transport is absent at runtime. */
  readonly sharedConfig?: {
    readonly readers: readonly string[];
    readonly mount: GuestPolicyObject;
    readonly transport: GuestPolicyObject;
  };
  /** Trusted deployment checks, run before the common recipient checks; may narrow name/mount matching. */
  readonly refineRecipient?: (name: string, recipient: GuestPolicyObject) => void;
  readonly trailingNewline?: boolean;
}

const CONTAINER = "io.kubernetes.cri.container-name";
const SANDBOX = "io.kubernetes.cri.sandbox-name";
const NAMESPACE = "io.kubernetes.cri.sandbox-namespace";
const IMAGE = "io.kubernetes.cri.image-name";
const TOKEN_MOUNT = {
  destination: "/var/run/secrets/kubernetes.io/serviceaccount",
  source: "$(sfprefix)serviceaccount$", type_: "bind", options: ["rbind", "rprivate", "ro"],
};
// Upstream rule anchor: Copyright (c) 2023 Microsoft Corporation, Apache-2.0.
// Retained as exact text to refuse an unreviewed generator change.
const DEVICE_RULE = `allow_linux_devices(p_devices, i_devices) if {
    print("allow_linux_devices: start")
    every i_device in i_devices {
        print("allow_linux_devices: i_device =", i_device)
        some p_device in p_devices
        i_device.Path == p_device.Path
    }
    print("allow_linux_devices: true")
}`;
const IMAGE_ANCHOR = "    p_oci := p_container.OCI\n\n    # check namespace";

function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`guest policy: ${message}`);
}

function object(value: unknown): GuestPolicyObject {
  require(value !== null && typeof value === "object" && !Array.isArray(value), "expected a JSON object");
  return value as GuestPolicyObject;
}

function items(value: unknown): any[] {
  return [...v.list<any>("guest policy", "generated value", value)];
}

function strings(value: unknown): string[] {
  const result = items(value);
  require(result.every(item => typeof item === "string"), "expected a string array");
  return result;
}

function equal(value: unknown, expected: unknown, message: string): void {
  require(isDeepStrictEqual(value, expected), message);
}

function omit(value: GuestPolicyObject, key: string): void {
  require(Object.hasOwn(value, key), "unsupported generator settings");
  delete value[key];
}

/** Container overrides take precedence over Pod defaults, including explicit zero. */
function startupIdentity(spec: GuestPolicyObject, source: GuestPolicyObject): { UID: number; GID: number } {
  const contexts = [spec, source].map(value => value.securityContext === undefined ? {} : object(value.securityContext));
  for (const context of contexts) {
    for (const field of ["runAsUser", "runAsGroup"]) {
      if (context[field] !== undefined) {
        require(Number.isSafeInteger(context[field]) && context[field] >= 0 && context[field] < 0xffffffff,
          `invalid ${field}`);
      }
    }
    require(context.runAsNonRoot === undefined || typeof context.runAsNonRoot === "boolean", "invalid runAsNonRoot");
  }
  const effective = (field: string) => contexts[1][field] ?? contexts[0][field];
  // Preserve the existing root-only expectation when no numeric identity is
  // declared. Do not infer a different identity from an image's USER metadata.
  const identity = { UID: effective("runAsUser") ?? 0, GID: effective("runAsGroup") ?? 0 };
  require(effective("runAsNonRoot") !== true || identity.UID !== 0, "runAsNonRoot requires a declared non-root identity");
  return identity;
}

/** Refuse widened defaults, including path prefixes that request-default checks alone miss. */
export function checkGeneratedGuestSettings(data: GuestPolicyObject, settings: GuestPolicyObject): void {
  const sections = ["common", "sandbox", "request_defaults", "devices", "cluster_config"];
  equal(Object.keys(data).sort(), [...sections, "containers"].sort(), "unexpected generated policy sections");
  const expected = Object.fromEntries(sections.map(key => [key, structuredClone(object(settings[key]))]));
  omit(expected.common, "image_layer_verification");
  for (const entry of items(expected.sandbox.storages)) {
    const storage = object(entry);
    if (!Object.hasOwn(storage, "shared")) storage.shared = false;
  }
  const vfio = object(expected.devices.vfio);
  omit(vfio, "anno_key_regex");
  for (const key of ["gpu_anno_value_regex", "gpu_gk_device_type", "pgpu_resource_keys"]) omit(object(vfio.nvidia), key);
  for (const key of sections) equal(data[key], expected[key], `generated ${key} differs from reviewed settings`);
}

/** Standard SNP/block, image-pull, required-env and transport guards, with explicit deployment paths. */
export function snpGuestPolicyGuards(dataDevice: string, requiredEnvRule: string, peers = true): GuestPolicyGuards {
  require(/^\/dev\/[0-9a-zA-Z_./-]+$/.test(dataDevice) && !dataDevice.split("/").includes(".."), "invalid data device path");
  require(/^[a-zA-Z_][0-9a-zA-Z_]*$/.test(requiredEnvRule), "invalid required-env rule name");
  const read = (name: "storage-controls.rego" | "guest-pull.rego" | "required-env.rego" | "volume-transport.rego" | "native-peer-controls.rego") =>
    readConfidentialGuestAsset(name).replaceAll("@@DATA_DEVICE@@", JSON.stringify(dataDevice)).replaceAll("@@ENV_RULE@@", requiredEnvRule);
  return {
    devices: read("storage-controls.rego"), images: read("guest-pull.rego"),
    requiredEnv: read("required-env.rego"), transport: read("volume-transport.rego"),
    ...(peers ? { peers: read("native-peer-controls.rego") } : {}),
  };
}

/** Keep the measured generator's two-space, ASCII JSON representation. */
function policyJson(value: unknown): string {
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === "number") require(Number.isFinite(item) && (!Number.isInteger(item) || Number.isSafeInteger(item)), "unsafe policy number");
    return item;
  }, 2);
  require(typeof json === "string", "policy must be JSON");
  return json.replace(/[\u007f-\uffff]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * Harden a generator envelope against its reviewed inputs and declared Pod.
 * Deployment code still validates the Pod's role-specific API and mount boundaries.
 * Inputs are copied; neither the template nor the generator's data is mutated.
 */
export function hardenGuestPolicy(pod: GuestPodManifest, ccInitData: string, options: GuestPolicyHardening): MeasuredArtifact {
  const generated = decodeGuestPolicy(ccInitData);
  equal(generated.rules.replace(/\n+$/, ""), options.reviewed.rules.replace(/\n+$/, ""), "unreviewed rules");
  const data = structuredClone(generated.data) as GuestPolicyObject;
  checkGeneratedGuestSettings(data, options.reviewed.settings);
  equal(data.request_defaults.ExecProcessRequest, { allowed_commands: [], regex: [] }, "exec must be denied");
  require(/^[a-zA-Z_][0-9a-zA-Z_]*$/.test(options.requiredEnvRule), "invalid required-env rule name");
  require(!Object.hasOwn(data, options.requiredEnvRule) && options.requiredEnvRule !== "__proto__", "required-env rule collides with policy data");
  const spec = object(pod.spec);
  const metadata = object(pod.metadata);
  require(typeof metadata.name === "string" && typeof metadata.namespace === "string", "Pod name and namespace required");
  const expected = new Map<string, GuestPolicyObject>();
  for (const entry of [...items(spec.initContainers ?? []), ...items(spec.containers)]) {
    const source = object(entry);
    require(typeof source.name === "string" && source.name !== "pause" && !expected.has(source.name), "duplicate or reserved Pod container name");
    digestImage(source.image);
    strings(source.command);
    strings(source.args ?? []);
    const names = new Set<string>();
    for (const item of items(source.env ?? [])) {
      const env = object(item);
      require(typeof env.name === "string" && typeof env.value === "string" && !names.has(env.name)
        && Object.keys(env).every(key => key === "name" || key === "value"), "literal unique environment required");
      names.add(env.name);
    }
    expected.set(source.name, source);
  }
  require(expected.has(options.storage.container), "storage recipient is not declared");
  for (const name of Object.keys(options.nativeDevices ?? {})) require(expected.has(name) && name !== options.storage.container, "invalid native device recipient");
  for (const name of options.sharedConfig?.readers ?? []) require(expected.has(name), "invalid shared ConfigMap reader");
  const recipients = items(data.containers);
  require(recipients.length === expected.size + 1, "unexpected policy recipients");
  const seen = new Set<string>();
  for (const entry of recipients) {
    const container = object(entry);
    const oci = object(container.OCI);
    const annotations = object(oci.Annotations);
    const name = annotations[CONTAINER] ?? "pause";
    require(typeof name === "string" && !seen.has(name) && (name === "pause" || expected.has(name)), "duplicate or unknown recipient");
    seen.add(name);
    require(annotations[SANDBOX] === `^${metadata.name}$` && annotations[NAMESPACE] === metadata.namespace, "generated scope changed");
    options.refineRecipient?.(name, container);
    equal(container.exec_commands, [], "unexpected exec allowance");
    const linux = object(oci.Linux);
    if (name === options.storage.container) {
      equal(linux.Devices, [options.storage.generatedDevice], "unexpected block OCI");
      equal(container.devices, [options.storage.generatedTransport], "unexpected block transport");
      linux.Devices = structuredClone([options.storage.generatedDevice, ...options.storage.controlDevices]);
    } else {
      equal(linux.Devices, [], "unexpected native or block device");
      equal(container.devices, [], "unexpected device transport");
      if (options.nativeDevices && Object.hasOwn(options.nativeDevices, name)) linux.Devices = structuredClone(options.nativeDevices[name]);
    }
    if (name === "pause") {
      require(annotations["io.kubernetes.cri.container-type"] === "sandbox", "wrong pause role");
      continue;
    }
    const source = expected.get(name)!;
    require(annotations["io.kubernetes.cri.container-type"] === "container", "wrong workload role");
    const process = object(oci.Process);
    equal(annotations[IMAGE], source.image, "generated image drift");
    equal(process.Args, [...source.command, ...(source.args ?? [])], "generated argv drift");
    require(object(oci.Root).Readonly === true && process.NoNewPrivileges === true, "root or privilege drift");
    const identity = startupIdentity(spec, source);
    const user = object(process.User);
    require(user.UID === identity.UID && user.GID === identity.GID, "startup identity drift");
    const mounts = items(oci.Mounts).map(object);
    equal(mounts.filter(m => m.destination === TOKEN_MOUNT.destination), [TOKEN_MOUNT], "unexpected implicit token allowance");
    oci.Mounts = mounts.filter(m => m.destination !== TOKEN_MOUNT.destination);
    const shared = options.sharedConfig;
    if (shared?.readers.includes(name)) {
      equal(items(oci.Mounts).filter(m => m.destination === shared.mount.destination), [shared.mount], "shared ConfigMap mount changed");
      const storages = items(container.storages).map(object);
      equal(storages.filter(s => s.driver === "local"), [shared.transport], "unexpected ConfigMap transport");
      container.storages = storages.filter(s => !isDeepStrictEqual(s, shared.transport));
    }
  }
  require(seen.size === expected.size + 1 && seen.has("pause"), "missing recipient");
  data[options.requiredEnvRule] = Object.fromEntries([...expected].map(([name, source]) =>
    [name, (source.env ?? []).map((env: GuestPolicyObject) => `${env.name}=${env.value}`)]));
  require(generated.rules.split(DEVICE_RULE).length === 2 && generated.rules.split(IMAGE_ANCHOR).length === 2, "guard insertion point changed");
  let rules = generated.rules.replace(DEVICE_RULE, options.guards.devices).replace(IMAGE_ANCHOR,
    `    p_oci := p_container.OCI\n    allow_pinned_image(p_oci, i_oci, i_storages)\n    allow_${options.requiredEnvRule}(p_oci, i_oci)\n    allow_volume_transport(p_container, input.devices)\n\n    # check namespace`);
  rules += "\n" + options.guards.images + options.guards.requiredEnv + options.guards.transport + (options.guards.peers ?? "");
  const policy = rules + "\npolicy_data := " + policyJson(data) + (options.trailingNewline === false ? "" : "\n");
  return { canonicalPodSha256: sha256Hex(canonicalJson(pod)), ...replaceGuestPolicy(ccInitData, policy) };
}
