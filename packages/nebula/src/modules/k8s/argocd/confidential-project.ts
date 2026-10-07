import { ApiObject } from "cdk8s";
import type { Construct } from "constructs";

export interface ConfidentialProjectConfig {
  name: string;
  repoUrl: string;
  clusterName: string;
  namespace: string;
  allowedUsers: string[];
  argoCdNamespace?: string;
  /** Shared projects which must not become a workload access boundary. */
  protectedProjectNames?: string[];
}

/** Dedicated Argo boundary with exact sources, destinations and operators. */
export function confidentialProject(scope: Construct, id: string, config: ConfidentialProjectConfig): ApiObject {
  if (!/^[a-z0-9-]+$/.test(config.name) || (config.name === "default" || config.protectedProjectNames?.includes(config.name)) ||
      !/^[a-z0-9-]+$/.test(config.namespace) || config.namespace === "default" || config.namespace.startsWith("kube-") ||
      !config.repoUrl || /[*,\s]/.test(config.repoUrl) || !config.clusterName || /[*,\s]/.test(config.clusterName) ||
      !config.allowedUsers.length || config.allowedUsers.some(user => !user || /[*,\s]/.test(user))) {
    throw new Error("confidential Argo access requires an exact source, dedicated namespace/project and named users");
  }
  return new ApiObject(scope, id, { apiVersion: "argoproj.io/v1alpha1", kind: "AppProject",
    metadata: { name: config.name, namespace: config.argoCdNamespace ?? "argocd" }, spec: {
      sourceRepos: [config.repoUrl], destinations: [{ name: config.clusterName, namespace: config.namespace }],
      clusterResourceWhitelist: [{ group: "", kind: "Namespace" }],
      namespaceResourceWhitelist: [{ group: "", kind: "Pod" }, { group: "", kind: "PersistentVolumeClaim" },
        { group: "apps", kind: "StatefulSet" }, { group: "apps", kind: "Deployment" },
        { group: "", kind: "ConfigMap" }, { group: "", kind: "Service" }, { group: "", kind: "Secret" },
        { group: "monitoring.coreos.com", kind: "PodMonitor" }, { group: "monitoring.coreos.com", kind: "ServiceMonitor" },
        { group: "networking.k8s.io", kind: "NetworkPolicy" },
        { group: "rbac.authorization.k8s.io", kind: "Role" }, { group: "rbac.authorization.k8s.io", kind: "RoleBinding" }],
      roles: [{ name: "operator", groups: config.allowedUsers,
        policies: ["get", "sync"].map(action => `p, proj:${config.name}:operator, applications, ${action}, ${config.name}/*, allow`) }],
    } });
}
