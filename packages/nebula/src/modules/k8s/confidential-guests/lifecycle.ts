import { Construct } from "constructs";
import { KubeConfigMap, KubeDeployment, KubeRole, KubeRoleBinding, KubeServiceAccount, Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import { canonicalJson, sha256Hex } from "./canonical";
import { INIT_DATA_ANNOTATION, initDataSha256, type GuestPodManifest } from "./measured";
import {
  ARGO_TRACKING_ID, dnsLabel, dnsSubdomain, fail, integer, labelDomain, labelValue, list, nonEmptyString, port, record,
  syncWave, unique, waveAnnotations,
} from "./validate";
import { digestImage } from "./types";

const OWNER = "GuestLifecycle";

/**
 * Versions of the spec document ({@link guestLifecycleSpec}) by controller
 * mode. A code-mode controller reads version 1. An image-mode controller
 * reads version 2, which adds `node_name`, `runtime_class_name` and
 * `label_domains`, so the controller takes its placement and keys from Git.
 */
export const LIFECYCLE_SPEC_VERSIONS = Object.freeze({ code: 1, image: 2 } as const);
/**
 * The claim a release template may name instead of a real one: the controller
 * substitutes the phase's claim (the holder's or the stage's) when it creates
 * the guest, so one measured template serves both.
 */
export const LIFECYCLE_CLAIM_PLACEHOLDER = "${DISK}";
/**
 * Entry point of an image-mode controller unless `command` says otherwise:
 * isolated like code mode, but with site-packages, where the image installs it.
 */
export const LIFECYCLE_CONTROLLER_COMMAND: readonly string[] = Object.freeze(["python3", "-I", "-B", "-m", "confidential_guests.lifecycle"]);
/** The volume that carries a guest's data claim; the controller rewrites its claim. */
export const LIFECYCLE_DATA_VOLUME = "data";

/** `[container, path, port]` of an HTTP readiness probe the controller watches. */
export type GuestHealthSignal = readonly [container: string, path: string, port: number];

/** A second boot of the same release beside the holder (for example a handoff target). */
export interface GuestLifecycleStage {
  /** Pod name of the stage boot. */
  readonly name: string;
  /** Its claim. */
  readonly claim: string;
  /** The containers the stage boot runs, a subset of the template's. */
  readonly containers: readonly string[];
}

/** A ledger from an earlier controller that this one imports once. */
export interface GuestLifecycleImportedLedger {
  /** ConfigMap name, as the controller looks it up. */
  readonly name: string;
  /** Its initial `data.state`, rendered with `JSON.stringify`. */
  readonly state: unknown;
}

/** One guest role and its controller. Resource names derive from `role`. */
export interface GuestLifecycleRole {
  /** Role name: the controller is `<role>-lifecycle`, its spec `<role>-lifecycle-spec`, its ledger `<role>-lifecycle-ledger`. */
  readonly role: string;
  /** Pod name of the serving guest (the holder). */
  readonly holder: string;
  /** The holder's data claim. */
  readonly claim: string;
  /** Generation of the data disk behind `claim`. */
  readonly generation: number;
  /** The guests' terminationGracePeriodSeconds; every template must declare it. */
  readonly graceSeconds: number;
  readonly live: GuestHealthSignal;
  readonly ready: GuestHealthSignal;
  /**
   * Measured templates by release id: Pod manifests carrying the init-data
   * annotation (see `measuredGuest`). The controller creates guests from them.
   */
  readonly releases: Readonly<Record<string, GuestPodManifest>>;
  /** The release the holder runs. */
  readonly current: string;
  /** The release a rollout started from. Default null. */
  readonly previous?: string | null;
  /** The rollout counter. Default 0. */
  readonly rolloutId?: number;
  readonly stage?: GuestLifecycleStage;
  /** A ledger to import once, rendered with Prune=false,Delete=false. */
  readonly importedLedger?: GuestLifecycleImportedLedger;
}

/** Controller code shipped as a ConfigMap and run on a pinned runtime image. */
export interface GuestLifecycleCode {
  /** Python package files by file name; must include `__init__.py` and `lifecycle.py`. */
  readonly code: Readonly<Record<string, string>>;
  /** Interpreter image, pinned by digest. */
  readonly runtimeImage: string;
  /** Package name the files form (they are mounted at `/opt/lifecycle/<package>`). */
  readonly package: string;
}

/** Controller shipped in an image, pinned by digest. */
export interface GuestLifecycleImage {
  readonly image: string;
  /** Default {@link LIFECYCLE_CONTROLLER_COMMAND}. */
  readonly command?: readonly string[];
}

export type GuestLifecycleController = GuestLifecycleCode | GuestLifecycleImage;

export interface GuestLifecycleRollout {
  readonly limit: number;
  readonly stageSeconds: number;
  readonly backoffSeconds: number;
  readonly settleSeconds: number;
}

export interface GuestLifecycleWaves {
  /** Code ConfigMap, ledgers, ServiceAccount, Role and RoleBinding. Default `-2`. */
  readonly setup?: string;
  /** Spec ConfigMap and controller Deployment: last, because the controller acts at once. Default `0`. */
  readonly controller?: string;
}

export interface GuestLifecycleProps {
  readonly namespace: string;
  /** The node every guest and controller runs on. */
  readonly nodeName: string;
  /** Runtime class every guest template must declare. */
  readonly runtimeClassName: string;
  /**
   * Domain of the keys the controllers write and read: the pod label
   * `<labelDomain>/lifecycle`, the annotation `<labelDomain>/create-nonce` and
   * the controller's `<labelDomain>/code-sha256`. Required, no default.
   */
  readonly labelDomain: string;
  /**
   * Further domains an image-mode controller reads (never writes), for
   * guests created under an earlier domain; the spec's `label_domains` lists
   * `labelDomain` first, then these. Code-mode controllers read their own
   * constants, so this needs image mode.
   */
  readonly acceptLabelDomains?: readonly string[];
  readonly controller: GuestLifecycleController;
  readonly roles: readonly GuestLifecycleRole[];
  /** Recovery budget: attempts per epoch. */
  readonly budget: { readonly epoch: number; readonly limit: number };
  /** How long a guest may take to become ready. */
  readonly startupSeconds: number;
  readonly rollout: GuestLifecycleRollout;
  /** Claim name a template may carry in place of the role's claim. Default {@link LIFECYCLE_CLAIM_PLACEHOLDER}. */
  readonly claimPlaceholder?: string;
  /**
   * Containers every stage boot must run, for a controller that requires them
   * (for example the one that unlocks the stage's disk). Checked at render
   * time only; nothing is rendered for it. Default none.
   */
  readonly requiredStageContainers?: readonly string[];
  /** Pull secrets for the controller Pods. Default none. */
  readonly imagePullSecrets?: readonly string[];
  readonly waves?: GuestLifecycleWaves;
}

/** The spec document a role's controller reads from `<role>-lifecycle-spec`. */
export interface GuestLifecycleSpec {
  /** {@link LIFECYCLE_SPEC_VERSIONS}: 1 in code mode, 2 in image mode. */
  readonly version: 1 | 2;
  readonly role: string;
  readonly holder_name: string;
  readonly stage_name: string | null;
  readonly generation: number;
  readonly claims: { readonly data: string; readonly stage: string | null };
  readonly releases: Readonly<Record<string, { readonly template: GuestPodManifest; readonly init_data_sha256: string; readonly stage_containers: readonly string[] }>>;
  readonly current: string;
  readonly previous: string | null;
  readonly rollout_id: number;
  readonly grace_seconds: number;
  readonly containers: readonly string[];
  readonly initializers: readonly string[];
  readonly live: GuestHealthSignal;
  readonly ready: GuestHealthSignal;
  readonly startup_seconds: number;
  readonly budget: { readonly epoch: number; readonly limit: number };
  readonly rollout: { readonly limit: number; readonly stage_seconds: number; readonly backoff_seconds: number; readonly settle_seconds: number };
  /** Version 2: the node every guest runs on. */
  readonly node_name?: string;
  /** Version 2: the runtime class every guest declares. */
  readonly runtime_class_name?: string;
  /** Version 2: the label domains, the emitted one first, then those only read. */
  readonly label_domains?: readonly string[];
}

/** An Argo CD `spec.ignoreDifferences` entry. */
export interface ArgoIgnoreDifference {
  readonly group: string;
  readonly kind: string;
  readonly name: string;
  readonly namespace: string;
  readonly jsonPointers: readonly string[];
}

/** The names of a role's controller resources: the contract the controller looks them up by. */
export function lifecycleNames(role: string) {
  const controller = `${role}-lifecycle`;
  return { controller, code: `${controller}-code`, spec: `${controller}-spec`, ledger: `${controller}-ledger` } as const;
}

/** The pod label key a controller sets (`holder` or `stage`) on the guests it creates. */
export function lifecycleLabelKey(domain: string): string {
  return `${labelDomain(OWNER, "labelDomain", domain)}/lifecycle`;
}

const RELEASE_ID = /^[a-z0-9][a-z0-9.-]{0,62}$/;
const PYTHON_PACKAGE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CODE_FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*\.py$/;
const SHARED_NAMESPACES = ["hostNetwork", "hostPID", "hostIPC", "shareProcessNamespace"] as const;
const VOLUME_SOURCES = new Set(["configMap", "emptyDir", "persistentVolumeClaim"]);
const LIVE_METADATA = ["uid", "resourceVersion", "creationTimestamp", "deletionTimestamp"];

const isCode = (controller: GuestLifecycleController): controller is GuestLifecycleCode =>
  controller !== null && typeof controller === "object" && "code" in controller;

function domainsOf(props: GuestLifecycleProps): string[] {
  const domains = [labelDomain(OWNER, "labelDomain", props.labelDomain),
    ...list<string>(OWNER, "acceptLabelDomains", props.acceptLabelDomains ?? []).map(d => labelDomain(OWNER, "acceptLabelDomains entry", d))];
  unique(OWNER, "label domain", domains);
  return domains;
}

function names(value: unknown, what: string, allowEmpty = false): string[] {
  const items = list<{ name?: unknown }>(OWNER, what, value ?? [], allowEmpty ? 0 : 1).map(c => nonEmptyString(OWNER, `${what} name`, c?.name));
  unique(OWNER, what, items);
  return items;
}

function signal(value: unknown, what: string): GuestHealthSignal {
  const item = list<unknown>(OWNER, what, value, 3);
  if (item.length !== 3) fail(OWNER, `${what} must be [container, path, port]`);
  return [nonEmptyString(OWNER, `${what} container`, item[0]), nonEmptyString(OWNER, `${what} path`, item[1]), port(OWNER, `${what} port`, item[2])];
}

/** Check one release template against what the controller will accept, and return its HOST_DATA. */
function checkTemplate(props: GuestLifecycleProps, role: GuestLifecycleRole, id: string, template: GuestPodManifest,
  expected: { containers: string[]; initializers: string[] }, domains: string[]): string {
  const where = `role ${role.role} release ${id}`;
  const metadata = template?.metadata, spec = template?.spec;
  if (!metadata || !spec) fail(OWNER, `${where}: template must be a Pod manifest`);
  if (metadata.name !== role.holder) fail(OWNER, `${where}: template is named ${JSON.stringify(metadata.name)}, not the holder ${role.holder}`);
  if (metadata.namespace !== props.namespace) fail(OWNER, `${where}: template namespace must be ${props.namespace}`);
  const annotations = metadata.annotations ?? {};
  for (const key of [ARGO_TRACKING_ID, ...domains.map(d => `${d}/create-nonce`)]) {
    if (key in annotations) fail(OWNER, `${where}: template must not carry ${key}`);
  }
  for (const field of LIVE_METADATA) if (field in metadata) fail(OWNER, `${where}: template must not carry live metadata (${field})`);
  const initData = annotations[INIT_DATA_ANNOTATION];
  if (typeof initData !== "string") fail(OWNER, `${where}: template carries no init-data (${INIT_DATA_ANNOTATION}); measure it first`);
  let hostData: string;
  try {
    hostData = initDataSha256(initData);
  } catch (error) {
    fail(OWNER, `${where}: ${(error as Error).message}`);
  }
  if (spec.restartPolicy !== "Never") fail(OWNER, `${where}: guests run with restartPolicy Never`);
  if (spec.terminationGracePeriodSeconds !== role.graceSeconds) fail(OWNER, `${where}: terminationGracePeriodSeconds must be the role's ${role.graceSeconds}`);
  if (spec.automountServiceAccountToken !== false) fail(OWNER, `${where}: automountServiceAccountToken must be false`);
  if ((spec.serviceAccountName ?? "default") !== "default") fail(OWNER, `${where}: guests run as the default ServiceAccount`);
  if (spec.runtimeClassName !== props.runtimeClassName) fail(OWNER, `${where}: runtimeClassName must be ${props.runtimeClassName}`);
  if (spec.nodeName !== props.nodeName) fail(OWNER, `${where}: nodeName must be ${props.nodeName}`);
  for (const field of SHARED_NAMESPACES) if (spec[field]) fail(OWNER, `${where}: guests must not set ${field}`);
  const containers = names(spec.containers, `${where} containers`);
  const initializers = names(spec.initContainers, `${where} initContainers`, true);
  if ([...containers].sort().join() !== [...expected.containers].sort().join() || initializers.join() !== expected.initializers.join()) {
    fail(OWNER, `${where}: every release of a role runs the same containers and initContainers`);
  }
  const volumes = list<Record<string, any>>(OWNER, `${where} volumes`, spec.volumes, 1);
  unique(OWNER, `${where} volume`, volumes.map(v => v?.name));
  for (const volume of volumes) {
    const sources = Object.keys(volume).filter(k => k !== "name");
    if (sources.length !== 1 || !VOLUME_SOURCES.has(sources[0])) {
      fail(OWNER, `${where}: volume ${JSON.stringify(volume.name)} must be exactly one of configMap, emptyDir, persistentVolumeClaim`);
    }
  }
  const claims = volumes.filter(v => v.persistentVolumeClaim);
  if (claims.length !== 1 || claims[0].name !== LIFECYCLE_DATA_VOLUME) fail(OWNER, `${where}: exactly one claim, in the volume named ${LIFECYCLE_DATA_VOLUME}`);
  const claim = claims[0].persistentVolumeClaim.claimName;
  const placeholder = props.claimPlaceholder ?? LIFECYCLE_CLAIM_PLACEHOLDER;
  if (claim !== role.claim && claim !== placeholder) fail(OWNER, `${where}: the data claim must be the role's claim or ${placeholder}`);
  const byName = new Map<string, any>((spec.containers as any[]).map(c => [c.name, c]));
  for (const [what, [container, path, at]] of [["live", role.live], ["ready", role.ready]] as const) {
    const probe = byName.get(container)?.readinessProbe?.httpGet;
    if (probe?.path !== path || probe?.port !== at) fail(OWNER, `${where}: the ${what} signal must be ${container}'s readinessProbe on ${path}:${at}`);
  }
  return hostData;
}

function checkProps(props: GuestLifecycleProps): string[] {
  dnsLabel(OWNER, "namespace", props.namespace);
  dnsSubdomain(OWNER, "nodeName", props.nodeName);
  dnsSubdomain(OWNER, "runtimeClassName", props.runtimeClassName);
  const domains = domainsOf(props);
  integer(OWNER, "budget.epoch", props.budget?.epoch, 1);
  integer(OWNER, "budget.limit", props.budget?.limit, 0);
  integer(OWNER, "startupSeconds", props.startupSeconds, 1);
  for (const key of ["limit", "stageSeconds", "backoffSeconds", "settleSeconds"] as const) integer(OWNER, `rollout.${key}`, props.rollout?.[key], 0);
  if (props.claimPlaceholder !== undefined) nonEmptyString(OWNER, "claimPlaceholder", props.claimPlaceholder);
  const placeholder = props.claimPlaceholder ?? LIFECYCLE_CLAIM_PLACEHOLDER;
  const requiredStage = list<string>(OWNER, "requiredStageContainers", props.requiredStageContainers ?? []);
  requiredStage.forEach(container => nonEmptyString(OWNER, "requiredStageContainers entry", container));
  const roles = list<GuestLifecycleRole>(OWNER, "roles", props.roles, 1);
  unique(OWNER, "role", roles.map(r => r?.role));
  unique(OWNER, "guest Pod name", roles.flatMap(r => [r?.holder, ...(r?.stage ? [r.stage.name] : [])]));
  for (const role of roles) {
    dnsLabel(OWNER, "role", role.role);
    labelValue(OWNER, `role ${role.role} controller label`, `${props.namespace}-${lifecycleNames(role.role).controller}`);
    dnsSubdomain(OWNER, `role ${role.role} ledger name`, lifecycleNames(role.role).ledger);
    dnsSubdomain(OWNER, `role ${role.role} holder`, role.holder);
    dnsSubdomain(OWNER, `role ${role.role} claim`, role.claim);
    integer(OWNER, `role ${role.role} generation`, role.generation, 1);
    integer(OWNER, `role ${role.role} graceSeconds`, role.graceSeconds, 1);
    if (role.claim === placeholder) fail(OWNER, `role ${role.role}: claim ${role.claim} is the claim placeholder`);
    if (role.stage) {
      dnsSubdomain(OWNER, `role ${role.role} stage name`, role.stage.name);
      dnsSubdomain(OWNER, `role ${role.role} stage claim`, role.stage.claim);
      if (role.stage.claim === role.claim) fail(OWNER, `role ${role.role}: the stage claim is the data claim ${role.claim}; a stage boot never mounts its holder's disk`);
      if (role.stage.claim === placeholder) fail(OWNER, `role ${role.role}: stage claim ${role.stage.claim} is the claim placeholder`);
      const containers = list<string>(OWNER, `role ${role.role} stage containers`, role.stage.containers, 1);
      for (const container of requiredStage) {
        if (!containers.includes(container)) fail(OWNER, `role ${role.role}: the stage boot must run ${container} (requiredStageContainers)`);
      }
    }
    if (role.importedLedger) dnsSubdomain(OWNER, `role ${role.role} importedLedger name`, role.importedLedger.name);
  }
  unique(OWNER, "claim", roles.flatMap(r => [r.claim, ...(r.stage ? [r.stage.claim] : [])]));
  unique(OWNER, "ConfigMap", roles.flatMap(r => {
    const own = lifecycleNames(r.role);
    return [...(isCode(props.controller) ? [own.code] : []), own.spec, own.ledger, ...(r.importedLedger ? [r.importedLedger.name] : [])];
  }));
  if (isCode(props.controller)) {
    if (props.acceptLabelDomains?.length) fail(OWNER, "acceptLabelDomains needs an image-mode controller; code-mode controllers read their own constants");
    const code = record<string>(OWNER, "controller.code", props.controller.code);
    for (const [file, text] of Object.entries(code)) {
      if (!CODE_FILE.test(file)) fail(OWNER, `controller.code file ${JSON.stringify(file)} must be a Python file name`);
      if (typeof text !== "string") fail(OWNER, `controller.code ${file} must be text`);
    }
    for (const file of ["__init__.py", "lifecycle.py"]) if (!Object.hasOwn(code, file)) fail(OWNER, `controller.code must include ${file}`);
    if (typeof props.controller.package !== "string" || !PYTHON_PACKAGE.test(props.controller.package)) fail(OWNER, "controller.package must be a Python package name");
    digestImage(props.controller.runtimeImage);
  } else {
    const controller = props.controller as GuestLifecycleImage;
    if (controller === null || typeof controller !== "object" || !("image" in controller)) fail(OWNER, "controller must be {code, runtimeImage, package} or {image}");
    digestImage(controller.image);
    if (controller.command !== undefined) list<string>(OWNER, "controller.command", controller.command, 1).forEach(a => nonEmptyString(OWNER, "controller.command entry", a));
  }
  for (const secret of props.imagePullSecrets ?? []) dnsSubdomain(OWNER, "imagePullSecrets entry", secret);
  syncWave(OWNER, "waves.setup", props.waves?.setup ?? "-2");
  syncWave(OWNER, "waves.controller", props.waves?.controller ?? "0");
  return domains;
}

function roleOf(props: GuestLifecycleProps, role: string): GuestLifecycleRole {
  return props.roles.find(r => r.role === role) ?? fail(OWNER, `unknown role ${JSON.stringify(role)}`);
}

function specOf(props: GuestLifecycleProps, role: GuestLifecycleRole, domains: string[]): GuestLifecycleSpec {
  const releases = record<GuestPodManifest>(OWNER, `role ${role.role} releases`, role.releases);
  const ids = Object.keys(releases);
  if (ids.length === 0) fail(OWNER, `role ${role.role} declares no release`);
  for (const id of ids) if (!RELEASE_ID.test(id)) fail(OWNER, `role ${role.role} release id ${JSON.stringify(id)} is invalid`);
  if (!Object.hasOwn(releases, role.current)) fail(OWNER, `role ${role.role} current release ${JSON.stringify(role.current)} is not declared`);
  const previous = role.previous ?? null;
  if (previous !== null && (!Object.hasOwn(releases, previous) || previous === role.current)) {
    fail(OWNER, `role ${role.role} previous release must be declared and differ from current`);
  }
  const rolloutId = integer(OWNER, `role ${role.role} rolloutId`, role.rolloutId ?? 0, 0);
  const current = releases[role.current];
  const containers = names(current?.spec?.containers, `role ${role.role} release ${role.current} containers`);
  const initializers = names(current?.spec?.initContainers, `role ${role.role} release ${role.current} initContainers`, true);
  const live = signal(role.live, `role ${role.role} live`), ready = signal(role.ready, `role ${role.role} ready`);
  for (const [what, [container]] of [["live", live], ["ready", ready]] as const) {
    if (!containers.includes(container)) fail(OWNER, `role ${role.role} ${what} container ${container} is not in the template`);
  }
  const stageContainers = role.stage ? list<string>(OWNER, `role ${role.role} stage containers`, role.stage.containers, 1) : [];
  unique(OWNER, `role ${role.role} stage container`, stageContainers);
  for (const name of stageContainers) if (!containers.includes(name)) fail(OWNER, `role ${role.role} stage container ${name} is not in the template`);
  const hostData = Object.fromEntries(ids.map(id => [id, checkTemplate(props, role, id, releases[id], { containers, initializers }, domains)]));
  const placement = isCode(props.controller) ? { version: LIFECYCLE_SPEC_VERSIONS.code }
    : { version: LIFECYCLE_SPEC_VERSIONS.image, node_name: props.nodeName, runtime_class_name: props.runtimeClassName, label_domains: domains };
  return {
    ...placement, role: role.role, holder_name: role.holder, stage_name: role.stage?.name ?? null,
    generation: role.generation,
    claims: { data: role.claim, stage: role.stage?.claim ?? null },
    releases: Object.fromEntries(ids.map(id => [id, { template: releases[id], init_data_sha256: hostData[id], stage_containers: [...stageContainers] }])),
    current: role.current, previous, rollout_id: rolloutId,
    grace_seconds: role.graceSeconds, containers, initializers,
    live, ready, startup_seconds: props.startupSeconds, budget: { epoch: props.budget.epoch, limit: props.budget.limit },
    rollout: { limit: props.rollout.limit, stage_seconds: props.rollout.stageSeconds, backoff_seconds: props.rollout.backoffSeconds,
      settle_seconds: props.rollout.settleSeconds },
  };
}

/**
 * The spec a role's controller creates its guests from (rendered as canonical
 * JSON into `<role>-lifecycle-spec`). Every release template is checked
 * against what the controller accepts, so a mistake fails the render rather
 * than the controller.
 * @throws Error when the props or a template are outside the controller's contract.
 */
export function guestLifecycleSpec(props: GuestLifecycleProps, role: string): GuestLifecycleSpec {
  const domains = checkProps(props);
  return specOf(props, roleOf(props, role), domains);
}

/**
 * Argo CD `ignoreDifferences` for the ledgers the controllers own: Git
 * declares each ledger once and a sync must never reset it. Imported ledgers
 * come first, then the lifecycle ledgers, each in role order.
 */
export function lifecycleIgnoreDifferences(props: {
  readonly namespace: string;
  readonly roles: readonly { readonly role: string; readonly importedLedger?: { readonly name: string } }[];
}): ArgoIgnoreDifference[] {
  const namespace = dnsLabel(OWNER, "namespace", props.namespace);
  const entry = (name: string): ArgoIgnoreDifference => ({ group: "", kind: "ConfigMap", name, namespace, jsonPointers: ["/data/state"] });
  return [...props.roles.flatMap(r => (r.importedLedger ? [entry(r.importedLedger.name)] : [])), ...props.roles.map(r => entry(lifecycleNames(r.role).ledger))];
}

/**
 * Per-role lifecycle controllers for measured confidential guests: the
 * controller alone creates and deletes its role's guest Pods from a
 * Git-declared spec, records every step in a ledger it owns, and recovers a
 * failed guest within a budget. Per role, in order: the code ConfigMap (code
 * mode only), the spec, the ledger, an imported ledger if any, the
 * ServiceAccount, Role, RoleBinding and the controller Deployment.
 *
 * Guest Pods are created by the controller, not by Argo; pair this with a
 * {@link GuestAdmissionFence} so only the controllers can create them, and set
 * {@link lifecycleIgnoreDifferences} on the Application so a sync never
 * resets a ledger.
 */
export class GuestLifecycle extends Construct {
  /** The label key the controllers set on their guests (`<labelDomain>/lifecycle`). */
  public readonly lifecycleLabel: string;
  /** Per role, in order: the ServiceAccount the controller runs as. */
  public readonly serviceAccounts: readonly { readonly role: string; readonly namespace: string; readonly name: string }[];
  /** The rendered specs by role. */
  public readonly specs: Readonly<Record<string, GuestLifecycleSpec>>;
  private readonly props: GuestLifecycleProps;

  constructor(scope: Construct, id: string, props: GuestLifecycleProps) {
    super(scope, id);
    const domains = checkProps(props);
    this.props = props;
    const { namespace, controller } = props;
    const setup = props.waves?.setup ?? "-2", last = props.waves?.controller ?? "0";
    const specs = Object.fromEntries(props.roles.map(role => [role.role, specOf(props, role, domains)]));
    const code = isCode(controller) ? { ...controller.code } : undefined;
    const pullSecrets = props.imagePullSecrets?.length ? { imagePullSecrets: props.imagePullSecrets.map(name => ({ name })) } : {};
    for (const role of props.roles) {
      const own = lifecycleNames(role.role), name = own.controller;
      const meta = (resource: string, annotations: Record<string, string>) => ({ name: resource, namespace, annotations });
      const labels = { app: `${namespace}-${name}` };
      if (code) new KubeConfigMap(this, own.code, { metadata: meta(own.code, waveAnnotations(setup)), data: code });
      new KubeConfigMap(this, own.spec, { metadata: meta(own.spec, waveAnnotations(last)), data: { "spec.json": canonicalJson(specs[role.role]) } });
      new KubeConfigMap(this, own.ledger, { metadata: meta(own.ledger, waveAnnotations(setup, true)) });
      if (role.importedLedger) {
        new KubeConfigMap(this, role.importedLedger.name, { metadata: meta(role.importedLedger.name, waveAnnotations(setup, true)),
          data: { state: JSON.stringify(role.importedLedger.state) } });
      }
      new KubeServiceAccount(this, `${name}-account`, { metadata: meta(name, waveAnnotations(setup)), automountServiceAccountToken: false });
      new KubeRole(this, `${name}-role`, { metadata: meta(name, waveAnnotations(setup)), rules: [
        { apiGroups: [""], resources: ["pods"], resourceNames: role.stage ? [role.holder, role.stage.name] : [role.holder], verbs: ["get", "delete"] },
        // RBAC cannot scope a create by name; the admission fence does.
        { apiGroups: [""], resources: ["pods"], verbs: ["create"] },
        { apiGroups: [""], resources: ["configmaps"], resourceNames: [own.spec, ...(role.importedLedger ? [role.importedLedger.name] : [])], verbs: ["get"] },
        { apiGroups: [""], resources: ["configmaps"], resourceNames: [own.ledger], verbs: ["get", "patch"] },
      ] });
      new KubeRoleBinding(this, `${name}-binding`, { metadata: meta(name, waveAnnotations(setup)),
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
        subjects: [{ kind: "ServiceAccount", name, namespace }] });
      const env = [{ name: "LIFECYCLE_ROLE", value: role.role }, { name: "LIFECYCLE_NAMESPACE", value: namespace }];
      const container = {
        name: "controller",
        securityContext: { runAsUser: 65532, runAsGroup: 65532, runAsNonRoot: true, allowPrivilegeEscalation: false,
          readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
        resources: { requests: { cpu: Quantity.fromString("10m"), memory: Quantity.fromString("32Mi") }, limits: { memory: Quantity.fromString("128Mi") } },
      };
      new KubeDeployment(this, `${name}-deployment`, { metadata: meta(name, waveAnnotations(last)), spec: {
        replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels },
        template: {
          metadata: { labels, ...(code ? { annotations: { [`${props.labelDomain}/code-sha256`]: sha256Hex(canonicalJson(code)) } } : {}) },
          spec: {
            nodeName: props.nodeName, serviceAccountName: name, automountServiceAccountToken: true, enableServiceLinks: false,
            terminationGracePeriodSeconds: 15, ...pullSecrets,
            containers: [isCode(controller)
              ? { ...container, image: controller.runtimeImage, env,
                command: ["python3", "-I", "-S", "-B", "-c",
                  `import sys; sys.path.insert(0, '/opt/lifecycle'); from ${controller.package} import lifecycle; lifecycle.main()`],
                volumeMounts: [{ name: "code", mountPath: `/opt/lifecycle/${controller.package}`, readOnly: true }] }
              : { ...container, image: controller.image, env, command: [...(controller.command ?? LIFECYCLE_CONTROLLER_COMMAND)] }],
            ...(code ? { volumes: [{ name: "code", configMap: { name: own.code } }] } : {}),
          },
        },
      } });
    }
    this.lifecycleLabel = `${props.labelDomain}/lifecycle`;
    this.serviceAccounts = props.roles.map(r => ({ role: r.role, namespace, name: lifecycleNames(r.role).controller }));
    this.specs = specs;
  }

  /** Argo CD `ignoreDifferences` for this construct's ledgers ({@link lifecycleIgnoreDifferences}). */
  public ignoreDifferences(): ArgoIgnoreDifference[] {
    return lifecycleIgnoreDifferences(this.props);
  }
}
