import type { KyvernoConfig, KyvernoPolicyConfig, KyvernoRbacRule } from "../kyverno";

/** Grant one group a role in every Namespace classified as a workload. */
export interface NamespaceGroupAccessConfig {
  /** Group that receives the role, as the API server sees it. */
  group: string;
  /** ClusterRole bound in each matching Namespace. */
  adminRole: string;
  /** Namespace label whose value `workload` marks a Namespace as grantable. */
  classificationLabel: string;
  /** Namespaces that never receive the grant, whatever their label. */
  protectedNamespaces: readonly string[];
  /** ClusterPolicy name (default developer-workload-access). */
  policyName?: string;
  /** Name of the generated RoleBinding (default kyverno-workload-developers). */
  bindingName?: string;
}

/**
 * A Kyverno policy that keeps a RoleBinding in every workload Namespace and
 * removes it when the Namespace stops being one. Classifying a Namespace is
 * the only act that grants access.
 */
export function namespaceAccessPolicy(config: NamespaceGroupAccessConfig): KyvernoPolicyConfig {
  return {
    apiVersion: "kyverno.io/v1", kind: "ClusterPolicy",
    metadata: { name: config.policyName ?? "developer-workload-access" },
    // Declare admission defaults so Argo compares the policy Kyverno stores.
    spec: { admission: true, background: true, emitWarning: false,
      validationFailureAction: "Audit", rules: [{
      name: "namespace-rolebinding", skipBackgroundRequests: true,
      // Matching the classification, rather than checking it in preconditions,
      // lets synchronization remove a grant when a Namespace stops matching.
      match: { any: [{ resources: { kinds: ["Namespace"],
        selector: { matchLabels: { [config.classificationLabel]: "workload" } } } }] },
      exclude: { any: [{ resources: { kinds: ["Namespace"], names: [...config.protectedNamespaces] } }] },
      generate: {
        generateExisting: true, synchronize: true, orphanDownstreamOnPolicyDelete: false,
        apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
        name: config.bindingName ?? "kyverno-workload-developers", namespace: "{{ request.object.metadata.name }}",
        data: {
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: config.adminRole },
          subjects: [{ kind: "Group", apiGroup: "rbac.authorization.k8s.io", name: config.group }],
        },
      },
    }] },
  };
}

/** What Kyverno's background controller needs to manage those RoleBindings, and no more. */
export function namespaceAccessPermissions(config: NamespaceGroupAccessConfig): readonly KyvernoRbacRule[] {
  return [
    { apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"] },
    { apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"],
      verbs: ["bind"], resourceNames: [config.adminRole] },
  ];
}

/** The policy and controller permissions, ready to spread into a Kyverno config. */
export function namespaceAccessKyverno(config: NamespaceGroupAccessConfig): Pick<KyvernoConfig, "controllerExtraRules" | "policies"> {
  return { controllerExtraRules: { background: namespaceAccessPermissions(config) }, policies: [namespaceAccessPolicy(config)] };
}
