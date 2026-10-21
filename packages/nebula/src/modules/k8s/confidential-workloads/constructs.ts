import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { isDigestImage } from "../confidential-guests/types";
import { publicConfig } from "../trustee/validation";
import { confidentialCrds } from "./schema";
import { validateStorage, validateWorkload } from "./validation";
import { CONFIDENTIAL_API, CONFIDENTIAL_GROUP, type ConfidentialStorageResource, type ConfidentialStorageSpec,
  type ConfidentialWorkloadResource, type ConfidentialWorkloadSpec } from "./types";

export interface ConfidentialStorageConfig {
  name: string;
  namespace: string;
  spec: ConfidentialStorageSpec;
}
export class ConfidentialStorage extends BaseConstruct<ConfidentialStorageConfig> {
  readonly resource: ApiObject;
  readonly declaration: ConfidentialStorageResource;
  constructor(scope: Construct, id: string, config: ConfidentialStorageConfig) {
    super(scope, id, publicConfig("ConfidentialStorage", config));
    this.declaration = { apiVersion: CONFIDENTIAL_API, kind: "ConfidentialStorage",
      metadata: { name: config.name, namespace: config.namespace }, spec: config.spec };
    validateStorage(this.declaration);
    this.resource = new ApiObject(this, "resource", { ...this.declaration,
      metadata: { ...this.declaration.metadata, annotations: {
        "argocd.argoproj.io/sync-wave": "-1", "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
      } } });
  }
}

export interface ConfidentialWorkloadConfig {
  name: string;
  namespace: string;
  spec: ConfidentialWorkloadSpec;
  /** Public declarations for validating references during Nebula synthesis. */
  storages?: readonly ConfidentialStorageResource[];
}
export class ConfidentialWorkload extends BaseConstruct<ConfidentialWorkloadConfig> {
  readonly resource: ApiObject;
  readonly declaration: ConfidentialWorkloadResource;
  constructor(scope: Construct, id: string, config: ConfidentialWorkloadConfig) {
    super(scope, id, publicConfig("ConfidentialWorkload", config));
    this.declaration = { apiVersion: CONFIDENTIAL_API, kind: "ConfidentialWorkload",
      metadata: { name: config.name, namespace: config.namespace }, spec: config.spec };
    validateWorkload(this.declaration, config.storages ?? []);
    this.resource = new ApiObject(this, "resource", { ...this.declaration,
      metadata: { ...this.declaration.metadata, annotations: {
        "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
      } } });
  }
}

export interface ConfidentialOperatorConfig {
  name?: string;
  namespace: string;
  image: string;
  watchNamespaces: readonly string[];
  installCrds?: boolean;
}

/** Installs orchestration only. No owner credentials, enrollment pins or
 * decryption keys are mounted into this controller. */
export class ConfidentialOperator extends BaseConstruct<ConfidentialOperatorConfig> {
  readonly deployment: ApiObject;
  constructor(scope: Construct, id: string, config: ConfidentialOperatorConfig) {
    super(scope, id, publicConfig("ConfidentialOperator", config));
    const name = config.name ?? "confidential-operator", namespace = config.namespace;
    if (!isDigestImage(config.image) || !config.watchNamespaces.length ||
        [name, namespace, ...config.watchNamespaces].some(value => !/^[a-z][a-z0-9-]{0,39}$/.test(value)) ||
        new Set(config.watchNamespaces).size !== config.watchNamespaces.length) throw new Error("Invalid operator configuration");
    if (config.installCrds !== false) for (const crd of confidentialCrds()) new ApiObject(this, crd.metadata.name, crd);
    const metadata = { name, namespace, annotations: { "argocd.argoproj.io/sync-wave": "-2" } };
    new ApiObject(this, "account", { apiVersion: "v1", kind: "ServiceAccount", metadata });
    for (const target of config.watchNamespaces) {
      const role = { ...metadata, namespace: target };
      new ApiObject(this, `role-${target}`, { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: role,
        rules: [
          { apiGroups: [CONFIDENTIAL_GROUP], resources: ["confidentialworkloads", "confidentialstorages"], verbs: ["get", "list", "watch"] },
          { apiGroups: [CONFIDENTIAL_GROUP], resources: ["confidentialworkloads/status", "confidentialstorages/status"], verbs: ["get", "patch", "update"] },
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch", "create"] },
          { apiGroups: [""], resources: ["services"], verbs: ["get", "list", "watch", "create", "patch"] },
          { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get", "list", "watch"] },
          { apiGroups: [""], resources: ["events"], verbs: ["create", "patch"] },
        ] });
      new ApiObject(this, `binding-${target}`, { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: role,
        roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name },
        subjects: [{ kind: "ServiceAccount", name, namespace }] });
    }
    new ApiObject(this, "leader-role", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role",
      metadata: { ...metadata, name: `${name}-leader` }, rules: [
        { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["get", "create", "update"] },
        { apiGroups: [""], resources: ["events"], verbs: ["create", "patch"] },
      ] });
    new ApiObject(this, "leader-binding", { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
      metadata: { ...metadata, name: `${name}-leader` },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: `${name}-leader` },
      subjects: [{ kind: "ServiceAccount", name, namespace }] });
    this.deployment = new ApiObject(this, "deployment", { apiVersion: "apps/v1", kind: "Deployment", metadata,
      spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: { app: name } },
        template: { metadata: { labels: { app: name } }, spec: {
          serviceAccountName: name, containers: [{ name: "operator", image: config.image,
            command: ["/manager"], args: ["--leader-elect"],
            env: [{ name: "WATCH_NAMESPACES", value: config.watchNamespaces.join(",") },
              { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
              { name: "HOME", value: "/tmp" }],
            ports: [{ name: "health", containerPort: 8081 }],
            readinessProbe: { httpGet: { path: "/readyz", port: "health" }, initialDelaySeconds: 5 },
            livenessProbe: { httpGet: { path: "/healthz", port: "health" }, initialDelaySeconds: 15 },
            securityContext: { runAsUser: 10001, runAsGroup: 10001, runAsNonRoot: true,
              allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "2Gi" } },
            volumeMounts: [{ name: "tmp", mountPath: "/tmp" }],
          }], volumes: [{ name: "tmp", emptyDir: { sizeLimit: "2Gi" } }],
        } } },
    });
  }
}
