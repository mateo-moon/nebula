import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import type { EnvVar } from "cdk8s-plus-33/lib/imports/k8s";
import { BaseConstruct } from "../../../core";
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
  tokenExpirationSeconds?: number;
  ttlSecondsAfterFinished?: number;
  terminationGracePeriodSeconds?: number;
  resources: { requests: Record<string, string>; limits?: Record<string, string> };
}

/** One bounded node operation with explicit host mounts and named-node reads. */
export class NodeMaintenanceJob extends BaseConstruct<NodeMaintenanceJobConfig> {
  public readonly resources: ApiObject[] = [];
  public readonly packet: ApiObject;
  public readonly job: ApiObject;

  constructor(scope: Construct, id: string, config: NodeMaintenanceJobConfig) {
    super(scope, id, config);
    const c = this.config;
    validateHostResource(c);
    if (c.nodeName.length > 253 || c.nodeName.split(".").some(label => label.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(label)))
      throw new Error("Maintenance requires one exact node name");
    const lifetime = c.tokenExpirationSeconds ?? 600;
    if (!Number.isSafeInteger(lifetime) || lifetime < 600 || lifetime > 3600 ||
        !Number.isSafeInteger(c.activeDeadlineSeconds) || c.activeDeadlineSeconds < 1 || c.activeDeadlineSeconds > lifetime)
      throw new Error("Maintenance deadline must fit the bounded projected identity lifetime");
    if (!Number.isSafeInteger(c.runAsUser) || c.runAsUser < 0 || !c.command.length || c.command.some(arg => !arg || arg.includes("\0")))
      throw new Error("Maintenance requires an explicit user and command");
    for (const [value, maximum] of [[c.ttlSecondsAfterFinished ?? 300, 86400], [c.terminationGracePeriodSeconds ?? 30, 300]] as const) {
      if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error("Maintenance cleanup and termination must be bounded");
    }
    if (!Object.keys(c.files).length || Object.entries(c.files).some(([name, value]) =>
      !/^[A-Za-z0-9._-]{1,253}$/.test(name) || [".", ".."].includes(name) || typeof value !== "string"))
      throw new Error("Maintenance packet requires plain file names and string contents");
    const names = new Set(["packet", "identity"]);
    for (const mount of c.hostMounts ?? []) {
      if (!/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(mount.name) || names.has(mount.name) ||
          !mount.path.startsWith("/") || mount.path === "/" || /[\0\r\n]/.test(mount.path) || mount.path.split("/").includes("..") ||
          typeof mount.readOnly !== "boolean" || !["Directory", "File", "Socket"].includes(mount.type))
        throw new Error("Maintenance host mounts require distinct names and exact absolute paths");
      names.add(mount.name);
    }
    const metadata = { name: c.name, namespace: c.namespace, ...(c.labels ? { labels: c.labels } : {}) };
    const add = (id: string, manifest: ConstructorParameters<typeof ApiObject>[2]) => {
      const resource = new ApiObject(this, id, manifest);
      this.resources.push(resource);
      return resource;
    };
    this.packet = add("packet", { apiVersion: "v1", kind: "ConfigMap", metadata, immutable: true, data: c.files });
    add("identity", { apiVersion: "v1", kind: "ServiceAccount", metadata, automountServiceAccountToken: false });
    add("node-reader", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRole", metadata: { name: c.name },
      rules: [{ apiGroups: [""], resources: ["nodes"], resourceNames: [c.nodeName], verbs: ["get"] }] });
    add("node-reader-binding", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "ClusterRoleBinding", metadata: { name: c.name },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: c.name },
      subjects: [{ kind: "ServiceAccount", name: c.name, namespace: c.namespace }] });
    this.job = add("job", { apiVersion: "batch/v1", kind: "Job", metadata, spec: {
      activeDeadlineSeconds: c.activeDeadlineSeconds, ttlSecondsAfterFinished: c.ttlSecondsAfterFinished ?? 300, backoffLimit: 0,
      template: { metadata: { ...(c.labels ? { labels: c.labels } : {}) }, spec: {
        nodeName: c.nodeName, ...(c.hostPID ? { hostPID: true } : {}),
        ...(c.hostNetwork ? { hostNetwork: true, dnsPolicy: "ClusterFirstWithHostNet" } : {}),
        automountServiceAccountToken: false, serviceAccountName: c.name,
        restartPolicy: "Never", terminationGracePeriodSeconds: c.terminationGracePeriodSeconds ?? 30,
        tolerations: [{ operator: "Exists" }],
        containers: [{ name: "maintenance", image: c.image, imagePullPolicy: "IfNotPresent", command: [...c.command],
          ...(c.environment ? { env: [...c.environment] } : {}),
          securityContext: { runAsUser: c.runAsUser, readOnlyRootFilesystem: true, allowPrivilegeEscalation: false,
            capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
          resources: c.resources, volumeMounts: [
            { name: "packet", mountPath: "/packet", readOnly: true },
            { name: "identity", mountPath: "/identity", readOnly: true },
            ...(c.hostMounts ?? []).map(m => ({ name: m.name, mountPath: m.path, readOnly: m.readOnly })),
          ],
        }], volumes: [
          { name: "packet", configMap: { name: c.name } },
          { name: "identity", projected: { defaultMode: 0o400, sources: [
            { serviceAccountToken: { path: "token", expirationSeconds: lifetime } },
            { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
          ] } },
          ...(c.hostMounts ?? []).map(m => ({ name: m.name, hostPath: { path: m.path, type: m.type } })),
        ],
      } },
    } });
  }
}
