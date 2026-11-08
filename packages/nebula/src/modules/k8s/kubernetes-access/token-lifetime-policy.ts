import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { BaseConstruct } from "../../../core";
import { kubernetesServiceAccountTokenLifetimeSeconds } from "./workload-identity";
export interface ServiceAccountTokenLifetimePolicyConfig {
  name: string;
  requesterUsername: string;
  /** Maximum requested lifetime; defaults to 600 seconds. */
  maxTokenLifetimeSeconds?: number;
}
/** Bounds TokenRequests made by an explicitly selected requester. */
export class ServiceAccountTokenLifetimePolicy extends BaseConstruct<ServiceAccountTokenLifetimePolicyConfig> {
  public readonly resources: ApiObject[];
  constructor(scope: Construct, id: string, config: ServiceAccountTokenLifetimePolicyConfig) {
    super(scope, id, config);
    this.resources = ServiceAccountTokenLifetimePolicy.manifests(this.config).map((manifest: any, index) => new ApiObject(this, `policy-${index}`, manifest));
  }
  public static manifests(config: ServiceAccountTokenLifetimePolicyConfig): object[] {
    const { name, requesterUsername } = config;
    if (!/^[a-z0-9][a-z0-9.-]*$/.test(name) || !requesterUsername || /[\u0000-\u001f\u007f]/.test(requesterUsername))
      throw new Error("Token lifetime policy requires an exact resource name and requester username");
    const lifetime = kubernetesServiceAccountTokenLifetimeSeconds(config.maxTokenLifetimeSeconds);
    return [{
      apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy", metadata: { name }, spec: {
        failurePolicy: "Fail", matchConstraints: { resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["serviceaccounts/token"] }] },
        matchConditions: [{ name: "requester", expression: `request.userInfo.username == ${JSON.stringify(requesterUsername)}` }],
        validations: [{ expression: `has(object.spec.expirationSeconds) && object.spec.expirationSeconds > 0 && object.spec.expirationSeconds <= ${lifetime}`, message: `ServiceAccount tokens must expire within ${lifetime} seconds` }],
      }
    }, { apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicyBinding", metadata: { name }, spec: { policyName: name, validationActions: ["Deny"] } }];
  }

}
