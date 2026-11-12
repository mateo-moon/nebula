import type { ApiObject } from "cdk8s";
import {
  KubeValidatingAdmissionPolicy, KubeValidatingAdmissionPolicyBinding,
  type KubeValidatingAdmissionPolicyBindingProps, type KubeValidatingAdmissionPolicyProps,
} from "cdk8s-plus-33/lib/imports/k8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { hasControlCharacter, isResourceName } from "../../../utils/oidc";
import { kubernetesServiceAccountTokenLifetimeSeconds } from "./workload-identity";

export interface ServiceAccountTokenLifetimePolicyConfig {
  name: string;
  requesterUsername: string;
  /** Maximum requested lifetime; defaults to 600 seconds. */
  maxTokenLifetimeSeconds?: number;
}

function policy(config: ServiceAccountTokenLifetimePolicyConfig): KubeValidatingAdmissionPolicyProps {
  const { name, requesterUsername } = config;
  if (!isResourceName(name) || !requesterUsername || hasControlCharacter(requesterUsername))
    throw new Error("Token lifetime policy requires an exact resource name and requester username");
  const lifetime = kubernetesServiceAccountTokenLifetimeSeconds(config.maxTokenLifetimeSeconds);
  return {
    metadata: { name },
    spec: {
      failurePolicy: "Fail",
      matchConstraints: { resourceRules: [{
        apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["serviceaccounts/token"],
      }] },
      matchConditions: [{ name: "requester", expression: `request.userInfo.username == ${JSON.stringify(requesterUsername)}` }],
      validations: [{
        expression: `has(object.spec.expirationSeconds) && object.spec.expirationSeconds > 0 && object.spec.expirationSeconds <= ${lifetime}`,
        message: `ServiceAccount tokens must expire within ${lifetime} seconds`,
      }],
    },
  };
}

const binding = (name: string): KubeValidatingAdmissionPolicyBindingProps => ({
  metadata: { name }, spec: { policyName: name, validationActions: ["Deny"] },
});

/** Bounds TokenRequests made by an explicitly selected requester. */
export class ServiceAccountTokenLifetimePolicy extends BaseConstruct<ServiceAccountTokenLifetimePolicyConfig> {
  public readonly resources: ApiObject[];

  constructor(scope: Construct, id: string, config: ServiceAccountTokenLifetimePolicyConfig) {
    super(scope, id, config);
    this.resources = [
      new KubeValidatingAdmissionPolicy(this, "policy-0", policy(this.config)),
      new KubeValidatingAdmissionPolicyBinding(this, "policy-1", binding(this.config.name)),
    ];
  }

  /** The same policy as plain manifests, for a control plane's bootstrap manifests. */
  public static manifests(config: ServiceAccountTokenLifetimePolicyConfig): object[] {
    const version = { apiVersion: "admissionregistration.k8s.io/v1" };
    return [
      { ...version, kind: "ValidatingAdmissionPolicy", ...policy(config) },
      { ...version, kind: "ValidatingAdmissionPolicyBinding", ...binding(config.name) },
    ];
  }
}
