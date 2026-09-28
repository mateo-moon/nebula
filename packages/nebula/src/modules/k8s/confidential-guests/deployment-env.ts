// Renderers for a guest's measured deployment env: GUEST_STORAGE_LAYOUT,
// GUEST_WORKLOAD_API, the runtime paths, all of them together, and the
// adapter's and storage's own variables. Each value is read back by the
// guest's rules (guest-env.ts) before it is returned.
import { posix } from "node:path";
import { canonicalJson } from "./canonical";
import {
  MODE_ENV, STORAGE_CONTROL_DIR_ENV, STORAGE_LAYOUT_ENV, VERIFIER_SOCKET_ENV, WORKLOAD_API_ENV, WORKLOAD_SOCKET_ENV,
  readGuestEnv, readRuntimePathValue, readStorageLayoutValue, readWorkloadApiValue,
  type GuestRecordFormat, type GuestRuntimePaths, type GuestStorageLayout, type GuestWorkloadApi,
} from "./guest-env";
import { deepFreeze, wireProfileEnv, type WireProfile } from "./wire";

/** One env entry of a container. */
export interface GuestEnvVar<N extends string = string> {
  readonly name: N;
  readonly value: string;
}

/**
 * A guest deployment's measured env: the Pod's wire profile, the layout and
 * API every Pod of the deployment shares, and the runtime paths as the
 * reading containers mount them.
 */
export interface GuestDeploymentEnv {
  readonly wire: WireProfile;
  readonly storageLayout: GuestStorageLayout;
  readonly workloadApi: GuestWorkloadApi;
  readonly runtimePaths: GuestRuntimePaths;
}

/** The names of a workload API: its mode, routes and domains. The base image and the adapter's bodies are the deployment's. */
export type GuestWorkloadApiNames = Pick<GuestWorkloadApi, "mode" | "routes" | "signDomain" | "keyResolverDomain">;

/**
 * The names of the neutral attestation adapter's workload API: mode
 * `attest`, its `/v1` routes and its signing and key-resolver domains. A
 * deployment adds its base image reference and the adapter's bodies
 * (`config`, `statusFields`, `checkName`). Frozen like {@link NEUTRAL_WIRE}:
 * a change is a new version, never an edit.
 */
export const NEUTRAL_WORKLOAD_API: GuestWorkloadApiNames = deepFreeze({
  mode: "attest",
  routes: {
    status: "/v1/status",
    evidence: "/v1/session/evidence-bundle",
    sign: "/v1/sign-message",
    config: "/v1/config",
    verify: "/v1/verify-session-bundle",
  },
  signDomain: "CONFIDENTIAL_GUESTS_SESSION_SIGN_V1",
  keyResolverDomain: "CONFIDENTIAL_GUESTS_KEY_RESOLVER_V1",
});

/**
 * The neutral sealed-storage names of a {@link GuestStorageLayout}: the
 * key-derivation labels of the volume passphrases and the identity record
 * format. The volumes, their at-rest files and clients are the deployment's.
 * Frozen: a disk made under them keeps them for life, so a new format is
 * added to `secrets.formats` after the old one, never edited.
 */
export const NEUTRAL_SEALED_STORAGE: {
  readonly kdf: GuestStorageLayout["kdf"];
  readonly recordFormat: GuestRecordFormat;
} = deepFreeze({
  kdf: { extract: "confidential-guests/sealed-storage/extract/v1", passphrase: "confidential-guests/sealed-storage/luks-passphrase/v1" },
  recordFormat: { header: "CONFIDENTIAL_GUESTS_SECRETS_V1", fingerprint: "CONFIDENTIAL_GUESTS_IDENTITY_FINGERPRINT_V1" },
});

/**
 * Render a {@link GuestStorageLayout} as the value of GUEST_STORAGE_LAYOUT
 * (one canonical line, at most 8 KiB), refused with the guest's message when
 * a guest would refuse it.
 * @throws GuestEnvError (a TypeError) when a guest would refuse the value.
 */
export function storageLayoutEnv(layout: GuestStorageLayout): GuestEnvVar<typeof STORAGE_LAYOUT_ENV> {
  const value = canonicalJson(layout);
  readStorageLayoutValue(value);
  return { name: STORAGE_LAYOUT_ENV, value };
}

/**
 * Render a {@link GuestWorkloadApi} as the value of GUEST_WORKLOAD_API (one
 * canonical line, at most 4 KiB).
 * @throws GuestEnvError (a TypeError) when a guest would refuse the value.
 */
export function workloadApiEnv(api: GuestWorkloadApi): GuestEnvVar<typeof WORKLOAD_API_ENV> {
  const value = canonicalJson(api);
  readWorkloadApiValue(value);
  return { name: WORKLOAD_API_ENV, value };
}

/**
 * Render {@link GuestRuntimePaths} as GUEST_WORKLOAD_SOCKET,
 * GUEST_VERIFIER_SOCKET and GUEST_STORAGE_CONTROL_DIR, in the order a guest
 * reads them. Each is a path as the reading container mounts it: absolute,
 * without `.` or `..`, of at most 107 bytes.
 * @throws GuestEnvError (a TypeError) when a guest would refuse a value.
 */
export function runtimePathsEnv(paths: GuestRuntimePaths): GuestEnvVar[] {
  const entries = [[WORKLOAD_SOCKET_ENV, paths?.workloadSocket], [VERIFIER_SOCKET_ENV, paths?.verifierSocket], [STORAGE_CONTROL_DIR_ENV, paths?.storageControlDir]] as const;
  return entries.map(([name, value]) => ({ name, value: readRuntimePathValue(name, typeof value === "string" ? value : "") }));
}

/** The volumes a reading container mounts its runtime paths from. */
export interface RuntimePathVolumes {
  /** The volume holding the adapter's two sockets, mounted at their directory. */
  readonly sockets: string;
  /** For a reader of sealed storage's status (an observer), the volume holding it, mounted read-only at the control directory. */
  readonly control?: string;
}

/** One volume mount of a container. */
export interface GuestVolumeMount {
  readonly name: string;
  readonly mountPath: string;
  readonly readOnly?: boolean;
}

const VOLUME_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * The volume mounts that put a container's runtime paths where its env
 * names them: the sockets volume at the sockets' one directory (the adapter
 * binds them there, the bridge and observers ask them there) and, when
 * `control` is given, the control volume read-only at the storage control
 * directory. Render the same paths into that container's env.
 * @throws GuestEnvError (a TypeError) when a guest would refuse a path.
 * @throws TypeError when the sockets are one path or lie in two directories,
 * their directory is `/`, the control directory is theirs, or a volume name
 * is not one.
 */
export function runtimePathMounts(paths: GuestRuntimePaths, volumes: RuntimePathVolumes): GuestVolumeMount[] {
  const where = "runtimePathMounts";
  runtimePathsEnv(paths);
  const volume = (key: keyof RuntimePathVolumes) => {
    const name = volumes?.[key];
    if (typeof name !== "string" || !VOLUME_NAME.test(name)) throw new TypeError(`${where}: ${key} must be a volume name, got ${JSON.stringify(name)}`);
    return name;
  };
  const sockets = volume("sockets");
  const control = volumes.control === undefined ? undefined : volume("control");
  if (control === sockets) throw new TypeError(`${where}: sockets and control must name two volumes`);
  if (paths.workloadSocket === paths.verifierSocket) throw new TypeError(`${where}: the workload and verifier sockets must differ`);
  const directory = posix.dirname(paths.workloadSocket);
  if (posix.dirname(paths.verifierSocket) !== directory) {
    throw new TypeError(`${where}: the workload and verifier sockets must lie in one directory, which the sockets volume is mounted at`);
  }
  if (directory === "/") throw new TypeError(`${where}: the sockets' directory must not be /`);
  if (control !== undefined && paths.storageControlDir === directory) throw new TypeError(`${where}: the control directory must differ from the sockets' directory`);
  return [{ name: sockets, mountPath: directory }, ...(control === undefined ? [] : [{ name: control, mountPath: paths.storageControlDir, readOnly: true }])];
}

/**
 * The deployment env of every guest container that reads it (the adapter,
 * a control bridge, observers): GUEST_WIRE_PROFILE, GUEST_STORAGE_LAYOUT,
 * GUEST_WORKLOAD_API and the three runtime paths, in the order a guest
 * reads them. All are required: nebula renders no legacy default. The
 * rendered env is read back as a guest's components read it at start.
 * @throws GuestEnvError (a TypeError) when a guest would refuse it.
 */
export function guestEnv(deployment: GuestDeploymentEnv): GuestEnvVar[] {
  for (const key of ["wire", "storageLayout", "workloadApi", "runtimePaths"] as const) {
    if (deployment?.[key] === null || typeof deployment?.[key] !== "object") throw new TypeError(`guestEnv: ${key} is required`);
  }
  const env = [wireProfileEnv(deployment.wire), storageLayoutEnv(deployment.storageLayout), workloadApiEnv(deployment.workloadApi),
    ...runtimePathsEnv(deployment.runtimePaths)];
  readGuestEnv(Object.fromEntries(env.map(entry => [entry.name, entry.value])));
  return env;
}

/** The adapter's MODE: the mode of the workload API it serves. */
export function adapterModeEnv(api: GuestWorkloadApi): GuestEnvVar<typeof MODE_ENV> {
  workloadApiEnv(api);
  return { name: MODE_ENV, value: api.mode };
}

/**
 * The env of the sealed-storage container that serves one of the layout's
 * volumes, by its name in the layout: the same GUEST_STORAGE_LAYOUT as the
 * adapter beside it (which seals the passphrase storage opens), and the
 * volume's NODE_ID and VOLUME_ID.
 * @throws GuestEnvError (a TypeError) when a guest would refuse the layout.
 * @throws TypeError when the layout names no such volume.
 */
export function sealedStorageEnv(layout: GuestStorageLayout, volumeName: string): GuestEnvVar[] {
  const rendered = storageLayoutEnv(layout);
  const { volumes } = readStorageLayoutValue(rendered.value);
  if (typeof volumeName !== "string" || !Object.hasOwn(volumes, volumeName)) {
    throw new TypeError(`sealedStorageEnv: volumeName must name one of the layout's volumes (${Object.keys(volumes).sort().join(", ")}), got ${JSON.stringify(volumeName)}`);
  }
  const { node, volume } = volumes[volumeName];
  return [rendered, { name: "NODE_ID", value: node }, { name: "VOLUME_ID", value: volume }];
}
