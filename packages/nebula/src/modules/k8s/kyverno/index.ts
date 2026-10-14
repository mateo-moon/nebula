import { ApiObject, type ApiObjectMetadata, Helm } from "cdk8s";
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

export type KyvernoController = "admission" | "background" | "cleanup" | "reports";

/** Native manifest: no policy-kind allowlist, rule DSL or policy-specific fields. */
export interface KyvernoPolicyConfig {
  apiVersion: string;
  kind: string;
  metadata: ApiObjectMetadata & { name: string };
  spec: Record<string, unknown>;
}

/** Declare a policy independently of the installation, including in another app. */
export class KyvernoPolicy extends ApiObject {
  constructor(scope: Construct, id: string, manifest: KyvernoPolicyConfig) {
    super(scope, id, {
      ...manifest,
      metadata: {
        ...manifest.metadata,
        annotations: { "argocd.argoproj.io/sync-wave": "1", ...manifest.metadata.annotations },
      },
    });
  }
}

export interface KyvernoConfig {
  namespace?: string;
  releaseName?: string;
  /** Exact Helm chart version; defaults to 3.9.1 (Kyverno v1.19.1). */
  version?: string;
  repository?: string;
  /** Extra native RBAC rules for each controller, independent of policy type. */
  controllerExtraRules?: Partial<Record<KyvernoController, readonly KyvernoRbacRule[]>>;
  /** Any native policy manifests supported by the installed Kyverno version. */
  policies?: readonly KyvernoPolicyConfig[];
  /** Upstream Helm overrides, deep-merged last using HelmModule conventions. */
  values?: Record<string, unknown>;
}

export function kyvernoValues(config: KyvernoConfig = {}): Record<string, unknown> {
  const crdAnnotations = {
    "helm.sh/resource-policy": "keep",
    "argocd.argoproj.io/sync-options": "Prune=false,Delete=false",
  };
  const controllerRules = (controller: KyvernoController) => ({
    clusterRole: { extraResources: [...(config.controllerExtraRules?.[controller] ?? [])] },
  });
  return {
    crds: { install: true, annotations: crdAnnotations },
    // This dependency has independent annotation values from the main CRDs.
    "kyverno-api": { annotations: crdAnnotations },
    admissionController: { replicas: 1, rbac: controllerRules("admission") },
    backgroundController: {
      enabled: true, replicas: 1,
      rbac: {
        // Generation writes are caller-defined, just like the policies.
        coreClusterRole: { extraResources: [] },
        ...controllerRules("background"),
      },
    },
    // Optional services can be enabled through native Helm values as needed.
    cleanupController: { enabled: false, rbac: controllerRules("cleanup") },
    reportsController: { enabled: false, rbac: controllerRules("reports") },
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

/** Pinned installation with an open-ended collection of caller-owned policies. */
export class Kyverno extends HelmModule<KyvernoConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly helm: Helm;
  private readonly policyResources: KyvernoPolicy[] = [];

  /** Policies added through the constructor or addPolicy(). */
  public get policies(): readonly KyvernoPolicy[] {
    return [...this.policyResources];
  }

  constructor(scope: Construct, id: string, config: KyvernoConfig = {}) {
    super(scope, id, config);
    const namespace = this.config.namespace ?? "kyverno";
    this.namespace = this.createNamespace(namespace);
    ApiObject.of(this.namespace).metadata.addAnnotation("argocd.argoproj.io/sync-wave", "-1");
    this.helm = this.createHelmRelease({
      namespace, chart: "kyverno", releaseName: this.config.releaseName ?? "kyverno",
      repo: this.config.repository ?? KYVERNO_CHART_REPOSITORY,
      version: this.config.version ?? KYVERNO_CHART_VERSION,
      defaultValues: kyvernoValues(this.config), values: this.config.values,
    });
    for (const [index, policy] of (this.config.policies ?? []).entries()) {
      this.addPolicy(`policy-${index}`, policy);
    }
  }

  /** Add another native policy during composition, before app.synth(). */
  public addPolicy(id: string, manifest: KyvernoPolicyConfig): KyvernoPolicy {
    const policy = new KyvernoPolicy(this, id, manifest);
    this.policyResources.push(policy);
    return policy;
  }
}
