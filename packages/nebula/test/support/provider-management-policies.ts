import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Unmodified upstream source from the runtime embedded in AWS provider v2.6.2:
// https://github.com/crossplane/crossplane-runtime/blob/v2.2.0/pkg/reconciler/managed/policies.go
// Read its exact accepted sets rather than accepting every subset of actions.
const source = readFileSync(new URL("../fixtures/crossplane-runtime-v2.2.0-policies.go", import.meta.url), "utf8");
export const policySourceSha256 = createHash("sha256").update(source).digest("hex");
const body = source.split("func defaultSupportedManagementPolicies()")[1]?.split("\n}")[0];
assert.ok(body, "pinned runtime policy function is present");
const accepted = [...body.matchAll(/sets\.New\[xpv1\.ManagementAction\]\(([^)]*)\)/g)]
  .map(match => [...match[1].matchAll(/xpv1\.ManagementAction(\w+)/g)]
    .map(action => action[1] === "All" ? "*" : action[1]).sort().join(","));
assert.equal(accepted.length, 15, "recognize every set in the installed runtime allowlist");

export function supportsProviderPolicies(actions: readonly string[]): boolean {
  return accepted.includes([...new Set(actions)].sort().join(","));
}

export function assertProviderPolicies(resources: readonly any[]): void {
  for (const resource of resources.filter(value => value.apiVersion?.startsWith("ec2.aws.upbound.io/"))) {
    const policies = resource.spec.managementPolicies ?? ["*"];
    assert.ok(supportsProviderPolicies(policies),
      `${resource.kind}/${resource.metadata.name}: unsupported installed-provider policy ${JSON.stringify(policies)}`);
  }
}
