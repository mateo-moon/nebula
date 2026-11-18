import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";
import { BaseConstruct } from "../../../core/base-construct";
import { isDigestImage } from "../confidential-guests/types";
import { publicConfig } from "../trustee/validation";
import { confidentialCrds } from "./schema";
import { validateStorage, validateWorkload } from "./validation";
import { confidentialAccessTokenHash } from "./access-token";
import { CONFIDENTIAL_API, CONFIDENTIAL_GROUP, type ConfidentialStorageResource, type ConfidentialStorageSpec,
  type ConfidentialWorkloadResource, type ConfidentialWorkloadSpec } from "./types";
import { validateImageStore } from "./image-store";

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
  /** Temporary user access capability supplied during deployment. Never emitted
   * in Kubernetes or retained by the construct; only its SHA-256 is measured. */
  accessToken?: string;
}
export class ConfidentialWorkload extends BaseConstruct<ConfidentialWorkloadConfig> {
  readonly resource: ApiObject;
  readonly declaration: ConfidentialWorkloadResource;
  constructor(scope: Construct, id: string, config: ConfidentialWorkloadConfig) {
    const { accessToken, ...publicPart } = config;
    const hash = accessToken === undefined ? undefined : confidentialAccessTokenHash(accessToken);
    if (hash && config.spec.ownerClaimSha256 && hash !== config.spec.ownerClaimSha256) {
      throw new TypeError("Access token differs from the declared claim commitment");
    }
    const safe = { ...publicPart, spec: { ...config.spec, ...(hash ? { ownerClaimSha256: hash } : {}) } };
    super(scope, id, publicConfig("ConfidentialWorkload", safe));
    this.declaration = { apiVersion: CONFIDENTIAL_API, kind: "ConfidentialWorkload",
      metadata: { name: safe.name, namespace: safe.namespace }, spec: safe.spec };
    validateWorkload(this.declaration, safe.storages ?? []);
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
  /** Exact bootstrap Secrets the controller may read/update. No owner or
   * decryption credential is ever stored in these Secrets. */
  accessLinkSecrets?: readonly { namespace: string; name: string }[];
  /** Existing dedicated filesystem PVC containing only public OCI metadata and
   * ciphertext. Never mounted in a TEE or used for owner state or keys. */
  imageStore?: {
    claimName: string;
    repository: string;
    maxBytes?: number;
    /** Exact preparation label in the repository namespace. Omission denies
     * all remote writes instead of opening a wildcard publisher. */
    preparationPodSelector?: Readonly<Record<string, string>>;
  };
}

/** Installs orchestration only. No owner credentials, enrollment pins or
 * decryption keys are mounted into this controller. */
export class ConfidentialOperator extends BaseConstruct<ConfidentialOperatorConfig> {
  readonly deployment: ApiObject;
  constructor(scope: Construct, id: string, config: ConfidentialOperatorConfig) {
    super(scope, id, publicConfig("ConfidentialOperator", config));
    const name = config.name ?? "confidential-operator", namespace = config.namespace;
    const accessSecrets = config.accessLinkSecrets ?? [];
    if (!isDigestImage(config.image) || !config.watchNamespaces.length ||
        [name, namespace, ...config.watchNamespaces].some(value => !/^[a-z][a-z0-9-]{0,39}$/.test(value)) ||
        new Set(config.watchNamespaces).size !== config.watchNamespaces.length || accessSecrets.some(secret =>
          !config.watchNamespaces.includes(secret.namespace) || !/^[a-z][a-z0-9-]{0,39}$/.test(secret.name))) throw new Error("Invalid operator configuration");
    const imageStore = config.imageStore;
    const storeService = `${name}-images`;
    if (imageStore !== undefined) {
      if (!imageStore || typeof imageStore !== "object" || Array.isArray(imageStore) ||
          Object.keys(imageStore).some(key => !["claimName", "repository", "maxBytes", "preparationPodSelector"].includes(key)) ||
          !/^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(imageStore.claimName) ||
          !Number.isSafeInteger(imageStore.maxBytes ?? 8 * 1024 ** 3) ||
          (imageStore.maxBytes ?? 8 * 1024 ** 3) < 1024 ** 2 || (imageStore.maxBytes ?? 8 * 1024 ** 3) > 64 * 1024 ** 3) {
        throw new Error("Invalid public ciphertext store configuration");
      }
      validateImageStore({ endpoint: `http://${storeService}.${namespace}.svc:8084`,
        writeEndpoint: `http://${storeService}.${namespace}.svc:8085`, repository: imageStore.repository });
      if (!config.watchNamespaces.includes(imageStore.repository.split("/")[0])) throw new Error("Image store repository must use a watched namespace");
      const selector = imageStore.preparationPodSelector;
      if (selector !== undefined && (!selector || typeof selector !== "object" || Array.isArray(selector) ||
          !Object.hasOwn(selector, "confidential.nebula.dev/browser") || !Object.keys(selector).length || Object.keys(selector).length > 16 ||
          Object.entries(selector).some(([key, value]) => !/^[A-Za-z0-9_.\/-]{1,253}$/.test(key) || typeof value !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,61}[A-Za-z0-9])?$/.test(value)))) {
        throw new Error("Image store writer requires exact preparation Pod labels");
      }
    }
    if (config.installCrds !== false) for (const crd of confidentialCrds()) new ApiObject(this, crd.metadata.name, crd);
    const metadata = { name, namespace, annotations: { "argocd.argoproj.io/sync-wave": "-2" } };
    new ApiObject(this, "account", { apiVersion: "v1", kind: "ServiceAccount", metadata });
    for (const target of config.watchNamespaces) {
      const role = { ...metadata, namespace: target };
      new ApiObject(this, `role-${target}`, { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: role,
        rules: [
          { apiGroups: [CONFIDENTIAL_GROUP], resources: ["confidentialworkloads", "confidentialstorages"], verbs: ["get", "list", "watch"] },
          { apiGroups: [CONFIDENTIAL_GROUP], resources: ["confidentialworkloads"], verbs: ["patch"] },
          { apiGroups: [CONFIDENTIAL_GROUP], resources: ["confidentialworkloads/finalizers"], verbs: ["patch", "update"] },
          { apiGroups: [CONFIDENTIAL_GROUP], resources: ["confidentialworkloads/status", "confidentialstorages/status"], verbs: ["get", "patch", "update"] },
          { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch", "create", "patch", "delete"] },
          { apiGroups: [""], resources: ["services"], verbs: ["get", "list", "watch", "create", "patch"] },
          { apiGroups: [""], resources: ["persistentvolumeclaims"], verbs: ["get", "list", "watch"] },
          { apiGroups: ["coordination.k8s.io"], resources: ["leases"], verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
          { apiGroups: [""], resources: ["events"], verbs: ["create", "patch"] },
          ...(accessSecrets.some(secret => secret.namespace === target) ? [
            // Kubernetes cannot restrict Secret create by resourceNames. Reads
            // and mutations remain restricted to the explicitly named links.
            { apiGroups: [""], resources: ["secrets"], verbs: ["create"] },
            { apiGroups: [""], resources: ["secrets"], verbs: ["get", "update"],
              resourceNames: accessSecrets.filter(secret => secret.namespace === target).map(secret => secret.name) },
          ] : []),
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
          ...(imageStore ? { securityContext: { fsGroup: 10001, fsGroupChangePolicy: "OnRootMismatch" } } : {}),
          serviceAccountName: name, containers: [{ name: "operator", image: config.image,
            command: ["/manager"], args: ["--leader-elect"],
            env: [{ name: "WATCH_NAMESPACES", value: config.watchNamespaces.join(",") },
              ...(accessSecrets.length ? [{ name: "ACCESS_LINKS", value: "true" }] : []),
              ...(imageStore ? [{ name: "IMAGE_STORE_DIRECTORY", value: "/var/lib/nebula-images" },
                { name: "IMAGE_STORE_REPOSITORY", value: imageStore.repository },
                { name: "IMAGE_STORE_MAX_BYTES", value: String(imageStore.maxBytes ?? 8 * 1024 ** 3) }] : []),
              { name: "POD_NAMESPACE", valueFrom: { fieldRef: { fieldPath: "metadata.namespace" } } },
              { name: "HOME", value: "/tmp" }],
            ports: [{ name: "health", containerPort: 8081 }, ...(accessSecrets.length ? [{ name: "access", containerPort: 8083 }] : []),
              ...(imageStore ? [{ name: "image-read", containerPort: 8084 }, { name: "image-write", containerPort: 8085 }] : [])],
            readinessProbe: { httpGet: { path: "/readyz", port: "health" }, initialDelaySeconds: 5 },
            livenessProbe: { httpGet: { path: "/healthz", port: "health" }, initialDelaySeconds: 15 },
            securityContext: { runAsUser: 10001, runAsGroup: 10001, runAsNonRoot: true,
              allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
            resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "2Gi" } },
            volumeMounts: [{ name: "tmp", mountPath: "/tmp" },
              ...(imageStore ? [{ name: "image-store", mountPath: "/var/lib/nebula-images" }] : [])],
          }], volumes: [{ name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
            ...(imageStore ? [{ name: "image-store", persistentVolumeClaim: { claimName: imageStore.claimName } }] : [])],
        } } },
    });
    if (accessSecrets.length) new ApiObject(this, "access-service", { apiVersion: "v1", kind: "Service", metadata: {
      name: `${name}-access`, namespace }, spec: { selector: { app: name }, ports: [{ name: "http", port: 8083, targetPort: "access" }] } });
    if (imageStore) {
      new ApiObject(this, "image-store-service", { apiVersion: "v1", kind: "Service", metadata: { name: storeService, namespace },
        spec: { selector: { app: name }, ports: [{ name: "read", port: 8084, targetPort: "image-read" }, { name: "write", port: 8085, targetPort: "image-write" }] } });
      const [workloadNamespace, workload] = imageStore.repository.split("/");
      const peer = (labels: Readonly<Record<string, string>>) => ({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": workloadNamespace } }, podSelector: { matchLabels: labels } });
      const preparation = imageStore.preparationPodSelector ? peer(imageStore.preparationPodSelector) : undefined;
      new ApiObject(this, "image-store-network", { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name: storeService, namespace },
        spec: { podSelector: { matchLabels: { app: name } }, policyTypes: ["Ingress"], ingress: [
          // Preserve ordinary health and the existing public access service; only store ports add restrictions.
          { ports: [{ protocol: "TCP", port: 8081 }, ...(accessSecrets.length ? [{ protocol: "TCP", port: 8083 }] : [])] },
          { from: [{ podSelector: { matchLabels: { app: name } } }, peer({ "confidential.nebula.dev/workload": workload }), ...(preparation ? [preparation] : [])], ports: [{ protocol: "TCP", port: 8084 }] },
          ...(preparation ? [{ from: [preparation], ports: [{ protocol: "TCP", port: 8085 }] }] : []),
        ] } });
    }
  }
}
