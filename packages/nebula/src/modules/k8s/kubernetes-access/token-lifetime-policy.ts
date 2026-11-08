import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS } from "./workload-identity";
export interface ServiceAccountTokenLifetimePolicyConfig { name: string; requesterUsername: string }
/** Enforces ten-minute TokenRequests for an explicitly selected requester. */
export class ServiceAccountTokenLifetimePolicy extends BaseConstruct<ServiceAccountTokenLifetimePolicyConfig> {
  public readonly resources: ApiObject[];
  constructor(scope: Construct, id: string, config: ServiceAccountTokenLifetimePolicyConfig) {
    super(scope, id, config);
    this.resources = ServiceAccountTokenLifetimePolicy.manifests(this.config).map((manifest: any, index) => new ApiObject(this, `policy-${index}`, manifest));
  }
  public static manifests(config: ServiceAccountTokenLifetimePolicyConfig): object[] {
    const { name, requesterUsername } = config;
    return [{
      apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy", metadata: { name }, spec: {
        failurePolicy: "Fail", matchConstraints: { resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["serviceaccounts/token"] }] },
        matchConditions: [{ name: "query-refresher", expression: `request.userInfo.username == ${JSON.stringify(requesterUsername)}` }],
        validations: [{ expression: `has(object.spec.expirationSeconds) && object.spec.expirationSeconds > 0 && object.spec.expirationSeconds <= ${KUBERNETES_OIDC_TOKEN_LIFETIME_SECONDS}`, message: "Monitoring reader tokens must expire within ten minutes" }],
      }
    }, { apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicyBinding", metadata: { name }, spec: { policyName: name, validationActions: ["Deny"] } }];
  }

}
