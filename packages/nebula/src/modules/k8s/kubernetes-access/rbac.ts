import { kubernetesWorkloadUsername } from "./workload-identity";

const apiGroup = "rbac.authorization.k8s.io";

export interface RbacRule {
  apiGroups: string[];
  resources: string[];
  /** Narrows the rule to named objects. */
  resourceNames?: string[];
  verbs: string[];
}

export interface RbacSubject {
  kind: "User" | "Group";
  apiGroup: string;
  name: string;
}

const subject = (kind: RbacSubject["kind"]) => (name: string): RbacSubject => ({ kind, apiGroup, name });

function binding(name: string, role: { kind: "Role" | "ClusterRole"; name: string }, subjects: RbacSubject[], namespace?: string) {
  return {
    apiVersion: `${apiGroup}/v1`, kind: namespace ? "RoleBinding" : "ClusterRoleBinding",
    metadata: { name, ...(namespace ? { namespace } : {}) },
    roleRef: { apiGroup, ...role }, subjects,
  };
}

/** Plain RBAC manifests for a control plane's `bootstrapManifests`. They are
 * written into provisioning files, so their key order is fixed. */
export const rbac = {
  user: subject("User"),
  group: subject("Group"),

  /** A management-cluster ServiceAccount, as a target cluster's authenticator names it. */
  workload: (serviceAccountSubject: string): RbacSubject => subject("User")(kubernetesWorkloadUsername(serviceAccountSubject)),

  /** Binds an existing ClusterRole, cluster-wide or inside one namespace. */
  bind: (name: string, clusterRole: string, subjects: RbacSubject[], namespace?: string): object =>
    binding(name, { kind: "ClusterRole", name: clusterRole }, subjects, namespace),

  /** A Role (a ClusterRole when no namespace is given) and its binding, both called `name`. */
  grant(name: string, subjects: RbacSubject[], rules: RbacRule[], namespace?: string): object[] {
    const kind = namespace ? "Role" : "ClusterRole";
    return [
      { apiVersion: `${apiGroup}/v1`, kind, metadata: { name, ...(namespace ? { namespace } : {}) }, rules },
      binding(name, { kind, name }, subjects, namespace),
    ];
  },
};
