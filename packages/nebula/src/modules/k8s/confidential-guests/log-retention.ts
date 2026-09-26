import { posix } from "node:path";
import { Construct } from "constructs";
import { KubeConfigMap, KubeDeployment, KubeRole, KubeRoleBinding, KubeServiceAccount, Quantity } from "cdk8s-plus-33/lib/imports/k8s";
import { canonicalJson, sha256Hex } from "./canonical";
import { dnsLabel, dnsSubdomain, fail, labelDomain, labelValue, list, nonEmptyString, record, syncWave, unique, waveAnnotations } from "./validate";
import { digestImage } from "./types";

const OWNER = "GuestLogRetention";

/**
 * Entry point of an image-mode collector unless `command` says otherwise:
 * isolated like code mode, but with site-packages, where the image installs it.
 */
export const LOG_RETENTION_COMMAND: readonly string[] = Object.freeze(["python3", "-I", "-B", "-m", "confidential_guests.log_retention"]);

/** The containers of one guest Pod whose logs are retained. */
export interface GuestLogScope {
  readonly pod: string;
  readonly containers: readonly string[];
}

/** Collector code shipped as a ConfigMap and run on a pinned runtime image. */
export interface GuestLogRetentionCode {
  /** Files by name, mounted at `/opt/<name>`. */
  readonly code: Readonly<Record<string, string>>;
  /** The file to run. Default: the only file of `code`. */
  readonly entry?: string;
  /** Interpreter image, pinned by digest. */
  readonly runtimeImage: string;
}

/** Collector shipped in an image, pinned by digest. */
export interface GuestLogRetentionImage {
  readonly image: string;
  /** Default {@link LOG_RETENTION_COMMAND}. */
  readonly command?: readonly string[];
}

export type GuestLogCollector = GuestLogRetentionCode | GuestLogRetentionImage;

export interface GuestLogRetentionProps {
  readonly namespace: string;
  /** The node the guests run on; the collector runs there too. */
  readonly nodeName: string;
  /** Domain of the collector's `<labelDomain>/code-sha256` annotation. Required, no default. */
  readonly labelDomain: string;
  /** The guest containers to follow. */
  readonly scopes: readonly GuestLogScope[];
  /** Host directory the logs are retained in (created if missing). */
  readonly hostPath: string;
  readonly collector: GuestLogCollector;
  /** Base name of the collector's resources. Default `log-retention`. */
  readonly name?: string;
  /** Argo sync wave: ahead of the guests, since it only reads their logs. Default `-3`. */
  readonly wave?: string;
  /** Pull secrets for the collector Pod. Default none. */
  readonly imagePullSecrets?: readonly string[];
}

const FILE = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const isCode = (collector: GuestLogCollector): collector is GuestLogRetentionCode =>
  collector !== null && typeof collector === "object" && "code" in collector;

/**
 * One host-side collector that follows each listed guest container's log
 * into a host directory. A guest replacement otherwise takes its whole log
 * history with it, and that history is where recovery and shutdown evidence
 * lives. Renders, in order: ServiceAccount, Role (`pods/log` of the listed
 * Pods only), RoleBinding, the code ConfigMap (code mode only) and the
 * Deployment. The collector reads `LOG_NAMESPACE` and `LOG_SCOPE`
 * (`[[pod, [container, ...]], ...]` as JSON) and writes under `/logs`.
 */
export class GuestLogRetention extends Construct {
  constructor(scope: Construct, id: string, props: GuestLogRetentionProps) {
    super(scope, id);
    const namespace = dnsLabel(OWNER, "namespace", props.namespace);
    const nodeName = dnsSubdomain(OWNER, "nodeName", props.nodeName);
    const domain = labelDomain(OWNER, "labelDomain", props.labelDomain);
    const name = dnsLabel(OWNER, "name", props.name ?? "log-retention");
    labelValue(OWNER, "collector label", `${namespace}-${name}`);
    const wave = syncWave(OWNER, "wave", props.wave ?? "-3");
    const hostPath = nonEmptyString(OWNER, "hostPath", props.hostPath);
    if (!posix.isAbsolute(hostPath) || posix.normalize(hostPath) !== hostPath || hostPath === "/") fail(OWNER, "hostPath must be a normalized absolute directory other than /");
    const scopes = list<GuestLogScope>(OWNER, "scopes", props.scopes, 1);
    unique(OWNER, "scope Pod", scopes.map(s => s?.pod));
    for (const item of scopes) {
      dnsSubdomain(OWNER, "scope pod", item.pod);
      const containers = list<string>(OWNER, `scope ${item.pod} containers`, item.containers, 1);
      containers.forEach(c => dnsLabel(OWNER, `scope ${item.pod} container`, c));
      unique(OWNER, `scope ${item.pod} container`, containers);
    }
    for (const secret of props.imagePullSecrets ?? []) dnsSubdomain(OWNER, "imagePullSecrets entry", secret);
    const collector = props.collector;
    let code: Record<string, string> | undefined, image: string, command: string[];
    if (isCode(collector)) {
      code = { ...record<string>(OWNER, "collector.code", collector.code) };
      const files = Object.keys(code);
      for (const file of files) {
        if (!FILE.test(file) || typeof code[file] !== "string") fail(OWNER, `collector.code file ${JSON.stringify(file)} must be a plain file name with text`);
      }
      const entry = collector.entry ?? (files.length === 1 ? files[0] : fail(OWNER, "collector.entry is required when the code has more than one file"));
      if (!Object.hasOwn(code, entry)) fail(OWNER, `collector.entry ${JSON.stringify(entry)} is not a file of collector.code`);
      image = digestImage(collector.runtimeImage);
      command = ["python3", "-I", "-S", "-B", `/opt/${name}/${entry}`];
    } else {
      if (collector === null || typeof collector !== "object" || !("image" in collector)) fail(OWNER, "collector must be {code, runtimeImage} or {image}");
      image = digestImage(collector.image);
      command = [...list<string>(OWNER, "collector.command", collector.command ?? LOG_RETENTION_COMMAND, 1)];
      command.forEach(a => nonEmptyString(OWNER, "collector.command entry", a));
    }

    const metadata = (resource: string) => ({ name: resource, namespace, annotations: waveAnnotations(wave) });
    const labels = { app: `${namespace}-${name}` };
    new KubeServiceAccount(this, `${name}-account`, { metadata: metadata(name), automountServiceAccountToken: true });
    new KubeRole(this, `${name}-role`, { metadata: metadata(name), rules: [
      { apiGroups: [""], resources: ["pods/log"], resourceNames: scopes.map(s => s.pod), verbs: ["get"] },
    ] });
    new KubeRoleBinding(this, `${name}-binding`, { metadata: metadata(name),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
      subjects: [{ kind: "ServiceAccount", name, namespace }] });
    if (code) new KubeConfigMap(this, `${name}-code`, { metadata: metadata(`${name}-code`), data: code });
    new KubeDeployment(this, `${name}-deployment`, { metadata: metadata(name), spec: {
      replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels },
      template: {
        metadata: { labels, ...(code ? { annotations: { [`${domain}/code-sha256`]: sha256Hex(canonicalJson(code)) } } : {}) },
        spec: {
          nodeName, serviceAccountName: name, automountServiceAccountToken: true, terminationGracePeriodSeconds: 15,
          ...(props.imagePullSecrets?.length ? { imagePullSecrets: props.imagePullSecrets.map(secret => ({ name: secret })) } : {}),
          containers: [{ name: "collector", image, command,
            env: [{ name: "LOG_NAMESPACE", value: namespace },
              { name: "LOG_SCOPE", value: JSON.stringify(scopes.map(s => [s.pod, s.containers])) }],
            securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: Quantity.fromString("10m"), memory: Quantity.fromString("32Mi") },
              limits: { memory: Quantity.fromString("256Mi") } },
            volumeMounts: [{ name: "logs", mountPath: "/logs" }, ...(code ? [{ name: "code", mountPath: `/opt/${name}`, readOnly: true }] : [])] }],
          volumes: [{ name: "logs", hostPath: { path: hostPath, type: "DirectoryOrCreate" } },
            ...(code ? [{ name: "code", configMap: { name: `${name}-code` } }] : [])],
        },
      },
    } });
  }
}
