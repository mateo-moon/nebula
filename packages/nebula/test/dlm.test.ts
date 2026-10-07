import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsDlm, type AwsDlmConfig } from "../src/modules/infra/aws/dlm";

const schedule = { name: "daily", region: "eu-central-1", targetTags: { "example.test/backup": "daily" } };
function synth(config: Partial<AwsDlmConfig> = {}) {
  const chart = Testing.chart();
  new AwsDlm(chart, "backups", { name: "example", schedules: [schedule], ...config });
  return Testing.synth(chart);
}

test("DLM defaults still create a named shared execution role and daily snapshot policy", () => {
  const resources = synth();
  assert.equal(resources.length, 3);
  const role = resources.find(r => r.kind === "Role")!;
  assert.equal(role.metadata.name, "example-dlm-role");
  assert.equal(role.metadata.annotations["crossplane.io/external-name"], "example-dlm-role");
  assert.equal(role.spec.forProvider.description, "Nebula EBS snapshot lifecycle (DLM) execution role");
  const policy = resources.find(r => r.kind === "LifecyclePolicy")!;
  assert.equal(policy.apiVersion, "dlm.aws.upbound.io/v1beta2");
  assert.equal(policy.metadata.name, "example-daily");
  assert.deepEqual(policy.spec.forProvider.policyDetails, {
    policyType: "EBS_SNAPSHOT_MANAGEMENT", resourceTypes: ["VOLUME"], targetTags: schedule.targetTags,
    schedule: [{ name: "daily", copyTags: true,
      createRule: { interval: 24, intervalUnit: "HOURS", times: ["03:00"] }, retainRule: { count: 7 } }],
  });
  for (const resource of resources) assert.deepEqual(resource.spec.providerConfigRef, { name: "default" });
  for (const resource of [role, policy]) assert.deepEqual(resource.spec.forProvider.tags, { "nebula.sh/role": "dlm" });
});

test("adoption preserves independent MR, role and schedule identities without adding unmanaged metadata", () => {
  const resources = synth({ name: "new-prefix", roleName: "old-role", roleExternalName: null,
    roleDescription: null, tags: null, providerConfigRef: "existing-provider", schedules: [
      { ...schedule, resourceName: "old-policy", scheduleName: "daily-old", description: "existing description",
        times: ["04:30"], retain: 3, copyTags: false },
    ] });
  const role = resources.find(r => r.kind === "Role")!;
  assert.deepEqual(role.metadata, { name: "old-role" });
  assert.deepEqual(Object.keys(role.spec.forProvider), ["assumeRolePolicy"]);
  const attachment = resources.find(r => r.kind === "RolePolicyAttachment")!;
  assert.equal(attachment.metadata.name, "old-role-service");
  assert.deepEqual(attachment.spec.forProvider.roleRef, { name: "old-role" });
  const policy = resources.find(r => r.kind === "LifecyclePolicy")!;
  assert.equal(policy.metadata.name, "old-policy");
  assert.equal(policy.metadata.annotations, undefined);
  assert.equal(policy.spec.forProvider.description, "existing description");
  assert.equal(policy.spec.forProvider.tags, undefined);
  assert.deepEqual(policy.spec.forProvider.executionRoleArnRef, { name: "old-role" });
  assert.deepEqual(policy.spec.forProvider.policyDetails.schedule, [{ name: "daily-old", copyTags: false,
    createRule: { interval: 24, intervalUnit: "HOURS", times: ["04:30"] }, retainRule: { count: 3 } }]);
  for (const resource of resources) assert.deepEqual(resource.spec.providerConfigRef, { name: "existing-provider" });
});

test("DLM refuses conflicting resource identities and invalid target policies", () => {
  assert.throws(() => synth({ schedules: [{ ...schedule, name: "a", resourceName: "same" },
    { ...schedule, name: "b", resourceName: "same" }] }), /duplicate resourceName/);
  assert.throws(() => synth({ schedules: [{ ...schedule, targetTags: {} }] }), /targetTags must not be empty/);
  assert.throws(() => synth({ schedules: [{ ...schedule, intervalHours: 5 }] }), /intervalHours/);
  assert.throws(() => synth({ schedules: [{ ...schedule, description: "bad: description" }] }), /description/);
});
