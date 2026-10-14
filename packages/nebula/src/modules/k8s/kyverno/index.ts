import { ApiObject, Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { Construct } from "constructs";
import { HelmModule } from "../../../core";

export const KYVERNO_CHART_VERSION = "3.9.1";
export const KYVERNO_CHART_REPOSITORY = "https://kyverno.github.io/kyverno/";

export interface KyvernoRbacRule {
  apiGroups: readonly string[];
  resources: readonly string[];
  verbs: readonly string[];
  resourceNames?: readonly string[];
}

export interface KyvernoClusterPolicyConfig {
  name: string;
  /** Native ClusterPolicy spec, including validate, mutate or generate rules. */
  spec: Record<string, unknown> & { rules: readonly Record<string, unknown>[] };
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
}

/** Can also be placed in a separate policy application after Kyverno is ready. */
export class KyvernoClusterPolicy extends ApiObject {
  constructor(scope: Construct, id: string, config: KyvernoClusterPolicyConfig) {
    super(scope, id, {
      apiVersion: "kyverno.io/v1",
      kind: "ClusterPolicy",
      metadata: {
        name: config.name,
        labels: config.labels,
        annotations: { "argocd.argoproj.io/sync-wave": "1", ...config.annotations },
      },
      spec: config.spec,
    });
  }
}

export interface KyvernoConfig {
  namespace?: string;
  releaseName?: string;
  /** Exact Helm chart version; defaults to 3.9.1 (Kyverno v1.19.1). */
  version?: string;
  repository?: string;
  /** Opt in to generating RoleBindings for these existing ClusterRoles only. */
  roleBindingClusterRoles?: readonly string[];
  /** Additional background-controller permissions for other generate rules. */
  backgroundControllerExtraRules?: readonly KyvernoRbacRule[];
  policies?: readonly KyvernoClusterPolicyConfig[];
  /** Helm overrides, deep-merged last using HelmModule's normal conventions. */
  values?: Record<string, unknown>;
}

export function kyvernoValues(config: KyvernoConfig = {}): Record<string, unknown> {
  const roles = [...new Set(config.roleBindingClusterRoles ?? [])];
  if (roles.some(role => !role.trim() || role.includes("*"))) {
    throw new Error("roleBindingClusterRoles must contain explicit ClusterRole names");
  }
  const extraResources: KyvernoRbacRule[] = [...(config.backgroundControllerExtraRules ?? [])];
  if (roles.length) {
    extraResources.push({
      apiGroups: ["rbac.authorization.k8s.io"], resources: ["rolebindings"],
      verbs: ["get", "list", "watch", "create", "update", "patch", "delete"],
    }, {
      apiGroups: ["rbac.authorization.k8s.io"], resources: ["clusterroles"],
      verbs: ["bind"], resourceNames: roles,
    });
  }
  const crdAnnotations = {
    "helm.sh/resource-policy": "keep",
    "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
  };
  return {
    crds: {
      install: true,
      annotations: crdAnnotations,
    },
    // This dependency has independent annotation values from the main CRDs.
    "kyverno-api": { annotations: crdAnnotations },
    admissionController: { replicas: 1 },
    backgroundController: {
      enabled: true, replicas: 1,
      rbac: {
        // Replace upstream's broad generation writes with explicit opt-ins.
        coreClusterRole: { extraResources: [] },
        clusterRole: { extraResources },
      },
    },
    // Synchronized generation is handled by the background controller.
    cleanupController: { enabled: false },
    reportsController: { enabled: false },
    reportsServer: { enabled: false },
    grafana: { enabled: false },
    features: {
      admissionReports: { enabled: false },
      aggregateReports: { enabled: false },
      policyReports: { enabled: false },
      validatingAdmissionPolicyReports: { enabled: false },
      mutatingAdmissionPolicyReports: { enabled: false },
      generateValidatingAdmissionPolicy: { enabled: false },
    },
  };
}

/** Installs Kyverno only when explicitly composed by a deployment repository. */
export class Kyverno extends HelmModule<KyvernoConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly helm: Helm;
  public readonly policies: readonly KyvernoClusterPolicy[];

  constructor(scope: Construct, id: string, config: KyvernoConfig = {}) {
    super(scope, id, config);
    const defaultValues = kyvernoValues(this.config);
    const namespace = this.config.namespace ?? "kyverno";
    this.namespace = this.createNamespace(namespace);
    ApiObject.of(this.namespace).metadata.addAnnotation("argocd.argoproj.io/sync-wave", "-1");
    this.helm = this.createHelmRelease({
      namespace, chart: "kyverno", releaseName: this.config.releaseName ?? "kyverno",
      repo: this.config.repository ?? KYVERNO_CHART_REPOSITORY,
      version: this.config.version ?? KYVERNO_CHART_VERSION,
      defaultValues, values: this.config.values,
    });
    this.policies = (this.config.policies ?? []).map((policy, index) =>
      new KyvernoClusterPolicy(this, `policy-${index}`, policy));
  }
}

export type KyvernoBindingSubject =
  | { kind: "User" | "Group"; name: string }
  | { kind: "ServiceAccount"; name: string; namespace: string };

export interface NamespaceRoleBindingPolicyConfig {
  name: string;
  /** All labels must match; removing/changing one revokes the generated grant. */
  matchLabels: Record<string, string>;
  /** A new, exclusively Kyverno-owned binding name; never an existing binding. */
  bindingName: string;
  /** Existing ClusterRole; also list it in Kyverno.roleBindingClusterRoles. */
  clusterRoleName: string;
  subjects: readonly KyvernoBindingSubject[];
}

/** Declarative namespace access with backfill and revocation on reclassification. */
export function namespaceRoleBindingPolicy(config: NamespaceRoleBindingPolicyConfig): KyvernoClusterPolicyConfig {
  if (!Object.keys(config.matchLabels).length || !config.subjects.length) {
    throw new Error("Namespace RoleBinding policies require classification labels and subjects");
  }
  return {
    name: config.name,
    spec: {
      background: true,
      rules: [{
        name: "namespace-rolebinding",
        // Classification belongs in match, not preconditions: synchronization
        // uses match to remove downstream resources after a trigger changes.
        match: { any: [{ resources: { kinds: ["Namespace"], selector: { matchLabels: config.matchLabels } } }] },
        generate: {
          generateExisting: true,
          synchronize: true,
          // Preserve grants on policy removal; namespace reclassification still
          // revokes them while the policy/controller remain active.
          orphanDownstreamOnPolicyDelete: true,
          apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding",
          name: config.bindingName, namespace: "{{ request.object.metadata.name }}",
          data: {
            roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: config.clusterRoleName },
            subjects: config.subjects.map(subject => ({
              ...subject, apiGroup: subject.kind === "ServiceAccount" ? "" : "rbac.authorization.k8s.io",
            })),
          },
        },
      }],
    },
  };
}
