import { ApiObject } from "cdk8s";
import { Construct } from "constructs";

export interface ArgocdPluginImageUpdateConfig {
  /** Exact Application name; wildcard selection cannot use scoped RBAC. */
  application: string;
  name: string;
  namespace?: string;
  serviceAccount?: string;
  roleName?: string;
  syncWave?: number;
  image: {
    alias: string;
    repository: string;
    trackingTag: string;
    /** CMP environment variable carrying the digest pin. */
    pluginSpec: string;
    platforms?: string[];
  };
}

/** Declare a digest-tracking policy and permission to write only its exact
 * Application. The image-updater controller is installed separately. */
export function configureArgocdPluginImageUpdate(scope: Construct, id: string, config: ArgocdPluginImageUpdateConfig): ApiObject {
  const dns = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
  const namespace = config.namespace ?? "argocd";
  const role = config.roleName ?? `${config.application}-image-updater`;
  const serviceAccount = config.serviceAccount ?? "argocd-image-updater";
  for (const name of [config.application, config.name, namespace, role, serviceAccount])
    if (!dns.test(name)) throw new Error("Image update policy requires exact Kubernetes names");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(config.image.pluginSpec) ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(config.image.alias) ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[0-9]+\/[A-Za-z0-9._/-]+)?$/.test(config.image.repository) ||
      !/^[\w][\w.-]{0,127}$/.test(config.image.trackingTag))
    throw new Error("Image update policy requires an explicit repository, tag, alias and plugin environment variable");
  if (config.syncWave !== undefined && !Number.isInteger(config.syncWave)) throw new Error("Image update sync wave must be an integer");
  const platforms = config.image.platforms ?? ["linux/amd64"];
  if (!platforms.length || platforms.some(platform => !/^[a-z0-9]+\/[a-z0-9]+(?:\/[a-z0-9]+)?$/.test(platform)))
    throw new Error("Image update platforms must be explicit OS/architecture names");
  new ApiObject(scope, `${id}-role`, {
    apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role",
    metadata: { name: role, namespace },
    rules: [{ apiGroups: ["argoproj.io"], resources: ["applications"], resourceNames: [config.application], verbs: ["patch", "update"] }],
  });
  new ApiObject(scope, `${id}-binding`, {
    apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
    metadata: { name: `${role}-binding`, namespace },
    roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: role },
    subjects: [{ kind: "ServiceAccount", name: serviceAccount, namespace }],
  });
  return new ApiObject(scope, id, {
    apiVersion: "argocd-image-updater.argoproj.io/v1alpha1", kind: "ImageUpdater",
    metadata: { name: config.name, namespace, annotations: { "argocd.argoproj.io/sync-wave": String(config.syncWave ?? 7) } },
    spec: {
      writeBackConfig: { method: "argocd" },
      applicationRefs: [{ namePattern: config.application, images: [{
        alias: config.image.alias, imageName: `${config.image.repository}:${config.image.trackingTag}`,
        commonUpdateSettings: { updateStrategy: "digest", platforms },
        manifestTargets: { plugin: { spec: config.image.pluginSpec } },
      }] }],
    },
  });
}
