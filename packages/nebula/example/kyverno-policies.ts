import type { KyvernoPolicyConfig, KyvernoRbacRule } from "../src/modules/k8s/kyverno";

// Deployment-owned examples. Add or import further policies without changing Nebula.
export const requirePodTeamLabel: KyvernoPolicyConfig = {
  apiVersion: "kyverno.io/v1",
  kind: "ClusterPolicy",
  metadata: { name: "require-pod-team-label" },
  spec: {
    validationFailureAction: "Enforce",
    rules: [{
      name: "require-team",
      match: { any: [{ resources: { kinds: ["Pod"] } }] },
      validate: { message: "Pods must declare a team label", pattern: { metadata: { labels: { team: "?*" } } } },
    }],
  },
};

export const defaultPodLabels: KyvernoPolicyConfig = {
  apiVersion: "kyverno.io/v1",
  kind: "ClusterPolicy",
  metadata: { name: "default-pod-labels" },
  spec: {
    rules: [{
      name: "mark-managed",
      match: { any: [{ resources: { kinds: ["Pod"] } }] },
      mutate: { patchStrategicMerge: { metadata: { labels: { "+(example.com/managed)": "true" } } } },
    }],
  },
};

// RoleBinding generation is one ordinary policy, with ordinary controller RBAC.
export const namespaceAccessPermissions: readonly KyvernoRbacRule[] = [{
  apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings"],
  verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
}, {
  apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"],
  verbs: ["bind"], resourceNames: ["edit"],
}];

export const namespaceAccessPolicy: KyvernoPolicyConfig = {
  apiVersion: "kyverno.io/v1",
  kind: "ClusterPolicy",
  metadata: { name: "developer-workload-access" },
  spec: {
    background: true,
    rules: [{
      name: "namespace-rolebinding",
      // Put classification in match so synchronization also revokes on changes.
      match: { any: [{ resources: {
        kinds: ["Namespace"], selector: { matchLabels: { "example.com/namespace-class": "workload" } },
      } }] },
      generate: {
        generateExisting: true,
        synchronize: true,
        orphanDownstreamOnPolicyDelete: true,
        apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
        name: "kyverno-workload-developers", namespace: "{{ request.object.metadata.name }}",
        data: {
          roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "edit" },
          subjects: [{ kind: "Group", name: "example-developers", apiGroup: "rbac.authorization.k8s.io" }],
        },
      },
    }],
  },
};
