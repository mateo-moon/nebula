import { ApiObject } from "cdk8s";
import { Construct } from "constructs";
import { RETAINED_REQUEST_POLICIES } from "../../../utils/crossplane-policies";

export interface GiteaBranchProtectionConfig {
  /** HTTPS Gitea API origin, for example https://git.example.com. */
  origin: string;
  owner: string;
  repository: string;
  branch: string;
  /** Explicit Gitea branch-protection fields; omitted fields remain unmanaged. */
  rule: Record<string, unknown>;
  tokenSecretRef: { name: string; namespace: string; key: string };
  httpProviderConfigName: string;
}

/** Reconcile repository policy through provider-http without an operator curl
 * step. Removing the Kubernetes resource never deletes the external rule. */
export class GiteaBranchProtection extends Construct {
  public readonly request: ApiObject;

  constructor(scope: Construct, id: string, config: GiteaBranchProtectionConfig) {
    super(scope, id);
    const origin = new URL(config.origin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash ||
        origin.pathname !== "/" || !config.owner || !config.repository || !config.branch ||
        !config.httpProviderConfigName || !config.rule || Array.isArray(config.rule) ||
        (config.rule.rule_name !== undefined && config.rule.rule_name !== config.branch)) {
      throw new Error("branch protection requires an HTTPS origin, exact repository/branch and matching rule name");
    }
    for (const value of Object.values(config.tokenSecretRef)) {
      if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error("invalid branch-protection token Secret reference");
    }
    const token = config.tokenSecretRef;
    const headers = {
      Accept: ["application/json"],
      "Content-Type": ["application/json"],
      Authorization: [`token {{ ${token.name}:${token.namespace}:${token.key} }}`],
    };
    const baseUrl = `${origin.origin}/api/v1/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repository)}/branch_protections`;
    const ruleUrl = `${baseUrl}/${encodeURIComponent(config.branch)}`;
    this.request = new ApiObject(this, "rule", {
      apiVersion: "http.crossplane.io/v1alpha2", kind: "Request",
      metadata: { name: id },
      spec: {
        deletionPolicy: "Orphan",
        managementPolicies: RETAINED_REQUEST_POLICIES,
        forProvider: {
          headers,
          payload: { baseUrl, body: JSON.stringify({ ...config.rule, rule_name: config.branch }) },
          mappings: [
            { action: "CREATE", method: "POST", url: ".payload.baseUrl", body: ".payload.body", headers },
            { action: "OBSERVE", method: "GET", url: JSON.stringify(ruleUrl), headers },
            { action: "UPDATE", method: "PATCH", url: JSON.stringify(ruleUrl), body: ".payload.body", headers },
          ],
          expectedResponseCheck: {
            type: "CUSTOM",
            // Check every declared field, including false and empty values.
            // Lists such as required checks and teams are sets in Gitea.
            // A failed HTTP observation is not policy drift. Returning false
            // would permit an UPDATE while provider-http still reports Ready;
            // fail Observe instead so authorization/server failures surface.
            logic: 'def normalize: if type == "array" then sort else . end; if .response.statusCode < 200 or .response.statusCode >= 300 then error("branch-protection observation failed with HTTP " + (.response.statusCode | tostring)) else .response.body as $observed | .payload.body | to_entries | all(.[]; . as $field | ($observed | has($field.key)) and (($observed[$field.key] | normalize) == ($field.value | normalize))) end',
          },
        },
        providerConfigRef: { name: config.httpProviderConfigName },
      },
    });
  }
}
