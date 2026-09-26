// Renderers for a guest's measured deployment env: GUEST_STORAGE_LAYOUT,
// GUEST_WORKLOAD_API, the three variables together, and the adapter's and
// storage's own variables. Each value is read back by the guest's rules
// (guest-env.ts) before it is returned.
import { canonicalJson } from "./canonical";
import {
  MODE_ENV, STORAGE_LAYOUT_ENV, WORKLOAD_API_ENV, readGuestEnv, readStorageLayoutValue, readWorkloadApiValue,
  type GuestRecordFormat, type GuestStorageLayout, type GuestWorkloadApi,
} from "./guest-env";
import { deepFreeze, wireProfileEnv, type WireProfile } from "./wire";

/** One env entry of a container. */
export interface GuestEnvVar<N extends string = string> {
  readonly name: N;
  readonly value: string;
}

/** A guest deployment's measured env: the Pod's wire profile, and the layout and API every Pod of the deployment shares. */
export interface GuestDeploymentEnv {
  readonly wire: WireProfile;
  readonly storageLayout: GuestStorageLayout;
  readonly workloadApi: GuestWorkloadApi;
}

/**
 * The workload API of the neutral attestation adapter: mode `attest`, its
 * `/v1` routes and its signing and key-resolver domains. Frozen like
 * {@link NEUTRAL_WIRE}: a change is a new version, never an edit.
 */
export const NEUTRAL_WORKLOAD_API: GuestWorkloadApi = deepFreeze({
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
 * format. Frozen: a disk made under them keeps them for life, so a new
 * format is added to `secrets.formats` after the old one, never edited.
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
 * The deployment env of every guest container that reads it (the adapter,
 * a control bridge, observers): GUEST_WIRE_PROFILE, GUEST_STORAGE_LAYOUT and
 * GUEST_WORKLOAD_API, in the order a guest reads them. All three are
 * required: nebula renders no legacy default. The rendered env is read back
 * as a guest's components read it at start.
 * @throws GuestEnvError (a TypeError) when a guest would refuse it.
 */
export function guestEnv(deployment: GuestDeploymentEnv): GuestEnvVar[] {
  for (const key of ["wire", "storageLayout", "workloadApi"] as const) {
    if (deployment?.[key] === null || typeof deployment?.[key] !== "object") throw new TypeError(`guestEnv: ${key} is required`);
  }
  const env = [wireProfileEnv(deployment.wire), storageLayoutEnv(deployment.storageLayout), workloadApiEnv(deployment.workloadApi)];
  readGuestEnv(Object.fromEntries(env.map(entry => [entry.name, entry.value])));
  return env;
}

/** The adapter's MODE: the mode of the workload API it serves. */
export function adapterModeEnv(api: GuestWorkloadApi): GuestEnvVar<typeof MODE_ENV> {
  workloadApiEnv(api);
  return { name: MODE_ENV, value: api.mode };
}

/**
 * The env of the sealed-storage container that opens one of the layout's
 * volumes: the same GUEST_STORAGE_LAYOUT as the adapter beside it (which
 * seals the passphrase storage opens), and the volume's NODE_ID and VOLUME_ID.
 */
export function sealedStorageEnv(layout: GuestStorageLayout, volume: "chain" | "workspace"): GuestEnvVar[] {
  const rendered = storageLayoutEnv(layout);
  if (volume !== "chain" && volume !== "workspace") throw new TypeError(`sealedStorageEnv: volume must be chain or workspace, got ${JSON.stringify(volume)}`);
  const { node, volume: id } = readStorageLayoutValue(rendered.value)[volume];
  return [rendered, { name: "NODE_ID", value: node }, { name: "VOLUME_ID", value: id }];
}
