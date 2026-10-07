import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { App, Chart } from "cdk8s";
import { GiteaBranchProtection, type GiteaBranchProtectionConfig } from "../src/modules/infra/gitea/index.js";

const config: GiteaBranchProtectionConfig = {
  origin: "https://git.example.test", owner: "team", repository: "infrastructure", branch: "main",
  rule: { rule_name: "main", enable_push: false, enable_force_push: false, enable_status_check: true,
    status_check_contexts: ["render", "unit"], unprotected_file_patterns: "" },
  tokenSecretRef: { name: "repository-token", namespace: "crossplane-system", key: "token" },
  httpProviderConfigName: "repository-http",
};
function manifest(value = config) {
  return new GiteaBranchProtection(new Chart(new App(), "test"), "repository-main", value).request.toJson();
}
function compare(observed: Record<string, unknown>) {
  const fp = manifest().spec.forProvider;
  return execFileSync("jq", ["-r", fp.expectedResponseCheck.logic], {
    input: JSON.stringify({ payload: { body: JSON.parse(fp.payload.body) }, response: { body: observed } }), encoding: "utf8",
  }).trim() === "true";
}

test("adopts existing protection, creates missing rules and never removes protection on deletion", () => {
  const object = manifest(), fp = object.spec.forProvider;
  assert.equal(object.spec.deletionPolicy, "Orphan");
  assert.deepEqual(object.spec.managementPolicies, ["Observe", "Create", "Update"]);
  assert.deepEqual(fp.mappings.map((mapping: any) => [mapping.action, mapping.method]),
    [["CREATE", "POST"], ["OBSERVE", "GET"], ["UPDATE", "PATCH"]]);
  assert.equal(fp.mappings[1].url, '"https://git.example.test/api/v1/repos/team/infrastructure/branch_protections/main"');
  assert.deepEqual(fp.headers.Authorization, ["token {{ repository-token:crossplane-system:token }}"]);
  assert.equal(object.spec.providerConfigRef.name, "repository-http");
});

test("checks false/empty values, every required check and missing fields while allowing API metadata", () => {
  assert.equal(compare({ ...config.rule, created_at: "2026-01-01", status_check_contexts: ["unit", "render"] }), true);
  for (const change of [{ enable_push: true }, { enable_force_push: true }, { enable_status_check: false },
    { status_check_contexts: ["unit"] }, { unprotected_file_patterns: "**" }]) {
    assert.equal(compare({ ...config.rule, ...change }), false);
  }
  const missing = { ...config.rule }; delete missing.enable_force_push;
  assert.equal(compare(missing), false);
});

test("rejects credential-bearing origins and mismatched rule identities", () => {
  for (const origin of ["http://git.example.test", "https://token@git.example.test", "https://git.example.test/other", "https://git.example.test/?token=x"]) {
    assert.throws(() => manifest({ ...config, origin }), /HTTPS origin/);
  }
  assert.throws(() => manifest({ ...config, rule: { rule_name: "other" } }), /matching rule name/);
  assert.throws(() => manifest({ ...config, tokenSecretRef: { ...config.tokenSecretRef, key: "token }}" } }), /Secret reference/);
});
