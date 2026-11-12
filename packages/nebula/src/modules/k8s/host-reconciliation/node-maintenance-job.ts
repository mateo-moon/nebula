import type { ApiObject } from "cdk8s";
import {
  KubeClusterRole, KubeClusterRoleBinding, KubeConfigMap, KubeJob, KubeServiceAccount, Quantity, type EnvVar,
} from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { BaseConstruct, confinedContainer } from "../../../core";
import { type HostResourceConfig, validateHostResource } from "./shared";

export interface NodeMaintenanceHostMount {
  name: string;
  path: string;
  type: "Directory" | "File" | "Socket";
  readOnly: boolean;
}

export interface NodeMaintenanceJobConfig extends HostResourceConfig {
  nodeName: string;
  /** Public scripts and configuration, mounted at /packet. */
  files: Readonly<Record<string, string>>;
  command: readonly string[];
  environment?: readonly EnvVar[];
  hostMounts?: readonly NodeMaintenanceHostMount[];
  labels?: Record<string, string>;
  hostPID?: boolean;
  hostNetwork?: boolean;
  runAsUser: number;
  activeDeadlineSeconds: number;
  /** Lifetime of the projected API token, 600 to 3600 seconds; defaults to 600. */
  tokenExpirationSeconds?: number;
  ttlSecondsAfterFinished?: number;
  terminationGracePeriodSeconds?: number;
  resources: { requests: Record<string, string>; limits?: Record<string, string> };
}

const label = /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const within = (value: number, minimum: number, maximum: number) =>
  Number.isSafeInteger(value) && value >= minimum && value <= maximum;
const quantities = (values: Record<string, string>) =>
  Object.fromEntries(Object.entries(values).map(([resource, amount]) => [resource, Quantity.fromString(amount)]));

function validHostMount(mount: NodeMaintenanceHostMount, taken: Set<string>): boolean {
  return label.test(mount.name) && !taken.has(mount.name) &&
    mount.path.startsWith("/") && mount.path !== "/" && !/[\0\r\n]/.test(mount.path) && !mount.path.split("/").includes("..") &&
    typeof mount.readOnly === "boolean" && ["Directory", "File", "Socket"].includes(mount.type);
}

function validate(c: NodeMaintenanceJobConfig, bounds: { token: number; ttl: number; grace: number }): void {
  validateHostResource(c);
  if (c.nodeName.length > 253 || c.nodeName.split(".").some(part => part.length > 63 || !label.test(part)))
    throw new Error("Maintenance requires one exact node name");
  if (!within(bounds.token, 600, 3600) || !within(c.activeDeadlineSeconds, 1, bounds.token))
    throw new Error("Maintenance deadline must fit the bounded projected identity lifetime");
  if (!within(c.runAsUser, 0, Number.MAX_SAFE_INTEGER) || !c.command.length || c.command.some(arg => !arg || arg.includes("\0")))
    throw new Error("Maintenance requires an explicit user and command");
  if (!within(bounds.ttl, 0, 86400) || !within(bounds.grace, 0, 300))
    throw new Error("Maintenance cleanup and termination must be bounded");
  const files = Object.entries(c.files);
  if (!files.length || files.some(([name, content]) =>
    !/^[A-Za-z0-9._-]{1,253}$/.test(name) || [".", ".."].includes(name) || typeof content !== "string"))
    throw new Error("Maintenance packet requires plain file names and string contents");
  const taken = new Set(["packet", "identity"]);
  for (const mount of c.hostMounts ?? []) {
    if (!validHostMount(mount, taken)) throw new Error("Maintenance host mounts require distinct names and exact absolute paths");
    taken.add(mount.name);
  }
}

/** One bounded node operation with explicit host mounts and named-node reads. */
export class NodeMaintenanceJob extends BaseConstruct<NodeMaintenanceJobConfig> {
  public readonly resources: ApiObject[];
  public readonly packet: KubeConfigMap;
  public readonly job: KubeJob;

  constructor(scope: Construct, id: string, config: NodeMaintenanceJobConfig) {
    super(scope, id, config);
    const c = this.config;
    const token = c.tokenExpirationSeconds ?? 600;
    const ttl = c.ttlSecondsAfterFinished ?? 300;
    const grace = c.terminationGracePeriodSeconds ?? 30;
    validate(c, { token, ttl, grace });

    const { name, namespace } = c;
    const labels = c.labels ? { labels: c.labels } : {};
    const metadata = () => ({ name, namespace, ...labels });
    const hostMounts = c.hostMounts ?? [];

    this.packet = new KubeConfigMap(this, "packet", { metadata: metadata(), immutable: true, data: { ...c.files } });
    const identity = new KubeServiceAccount(this, "identity", { metadata: metadata(), automountServiceAccountToken: false });
    const nodeReader = new KubeClusterRole(this, "node-reader", {
      metadata: { name },
      rules: [{ apiGroups: [""], resources: ["nodes"], resourceNames: [c.nodeName], verbs: ["get"] }],
    });
    const nodeReaderBinding = new KubeClusterRoleBinding(this, "node-reader-binding", {
      metadata: { name },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name },
      subjects: [{ kind: "ServiceAccount", name, namespace }],
    });
    this.job = new KubeJob(this, "job", {
      metadata: metadata(),
      spec: {
        activeDeadlineSeconds: c.activeDeadlineSeconds, ttlSecondsAfterFinished: ttl, backoffLimit: 0,
        template: {
          metadata: { ...labels },
          spec: {
            nodeName: c.nodeName,
            ...(c.hostPID ? { hostPid: true } : {}),
            ...(c.hostNetwork ? { hostNetwork: true, dnsPolicy: "ClusterFirstWithHostNet" } : {}),
            automountServiceAccountToken: false, serviceAccountName: name,
            restartPolicy: "Never", terminationGracePeriodSeconds: grace,
            tolerations: [{ operator: "Exists" }],
            containers: [{
              name: "maintenance", image: c.image, imagePullPolicy: "IfNotPresent", command: [...c.command],
              ...(c.environment ? { env: [...c.environment] } : {}),
              securityContext: { ...confinedContainer, runAsUser: c.runAsUser, seccompProfile: { type: "RuntimeDefault" } },
              resources: {
                requests: quantities(c.resources.requests),
                ...(c.resources.limits ? { limits: quantities(c.resources.limits) } : {}),
              },
              volumeMounts: [
                { name: "packet", mountPath: "/packet", readOnly: true },
                { name: "identity", mountPath: "/identity", readOnly: true },
                ...hostMounts.map(mount => ({ name: mount.name, mountPath: mount.path, readOnly: mount.readOnly })),
              ],
            }],
            volumes: [
              { name: "packet", configMap: { name } },
              { name: "identity", projected: { defaultMode: 0o400, sources: [
                { serviceAccountToken: { path: "token", expirationSeconds: token } },
                { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
              ] } },
              ...hostMounts.map(mount => ({ name: mount.name, hostPath: { path: mount.path, type: mount.type } })),
            ],
          },
        },
      },
    });
    this.resources = [this.packet, identity, nodeReader, nodeReaderBinding, this.job];
  }
}
