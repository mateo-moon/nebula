import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { EcrRepository, type EcrRepositoryConfig } from "../src/modules/infra/aws/ecr";
import { AwsProvider } from "../src/modules/providers/aws";

const config: EcrRepositoryConfig = {
  name: "app-images", repositoryName: "team/app", accountId: "123456789012", region: "eu-central-1",
  grants: [{ roleName: "publisher", access: "push" }, { roleName: "puller", access: "pull" }],
};
test("repository retains immutable private images; pull and publication grants are isolated", () => {
  const chart = Testing.chart();
  const repo = new EcrRepository(chart, "images", config);
  const resources = Testing.synth(chart);
  assert.equal(repo.repositoryPolicy, undefined);
  assert.equal(resources.some(r => r.kind === "RepositoryPolicy"), false, "existing callers remain unchanged");
  const repository = resources.find(r => r.kind === "Repository");
  assert.equal(repository.apiVersion, "ecr.aws.upbound.io/v1beta2");
  assert.equal(repository.spec.deletionPolicy, "Orphan");
  assert.equal(repository.spec.forProvider.imageTagMutability, "IMMUTABLE");
  assert.equal(repository.spec.forProvider.forceDelete, false);
  assert.equal(repository.metadata.annotations["crossplane.io/external-name"], config.repositoryName);
  assert.equal(repo.repositoryUrl, "123456789012.dkr.ecr.eu-central-1.amazonaws.com/team/app");
  const policies = resources.filter(r => r.kind === "Policy").map(r => JSON.parse(r.spec.forProvider.policy));
  for (const policy of policies) {
    assert.deepEqual(policy.Statement[0], { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" });
    assert.equal(policy.Statement[1].Resource, repo.repositoryArn);
    assert.ok(policy.Statement[1].Action.every((a: string) => !/Delete|\*/.test(a)));
  }
  assert.ok(policies[0].Statement[1].Action.includes("ecr:PutImage"));
  assert.deepEqual(policies[1].Statement[1].Action, ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"]);
  assert.deepEqual(resources.filter(r => r.kind === "RolePolicyAttachment").map(r => r.spec.forProvider.role), ["publisher", "puller"]);
});
test("invalid identity or ambiguous grants fail before a policy can be rendered", () => {
  for (const patch of [
    { accountId: "*" }, { repositoryName: "other/*" }, { region: "cn-north-1" },
    { name: "bad/name" }, { grants: [{ roleName: "*", access: "pull" }] },
    { grants: [{ roleName: "same", access: "pull" }, { roleName: "same", access: "push" }] },
  ]) assert.throws(() => new EcrRepository(Testing.chart(), "images", { ...config, ...patch } as EcrRepositoryConfig));
});
test("ECR uses the same pinned provider family and projected identity as other AWS resources", () => {
  const chart = Testing.chart();
  new AwsProvider(chart, "provider", { families: ["ecr"], credentials: { type: "webIdentity", roleArn: "arn:aws:iam::123456789012:role/provider", region: "eu-central-1" } });
  const resources = Testing.synth(chart);
  const provider = resources.find(r => r.kind === "Provider" && r.metadata.name === "provider-aws-ecr");
  assert.equal(provider.spec.package, "xpkg.upbound.io/upbound/provider-aws-ecr:v2.6.2");
  assert.equal(provider.spec.runtimeConfigRef.name, "provider-aws-ecr-irsa");
  const runtime = resources.find(r => r.kind === "DeploymentRuntimeConfig");
  assert.equal(runtime.spec.deploymentTemplate.spec.template.spec.volumes[0].projected.sources[0].serviceAccountToken.audience, "sts.amazonaws.com");
});

test("explicit writer boundary denies other IAM identities without expanding grants", () => {
  const chart = Testing.chart();
  const repo = new EcrRepository(chart, "images", { ...config, exclusivePush: true, retainContent: true,
    providerConfigRef: "registry-controller" });
  assert.ok(repo.repositoryPolicy);
  const resources = Testing.synth(chart), policy = resources.find(r => r.kind === "RepositoryPolicy");
  assert.equal(resources.filter(r => r.kind === "RepositoryPolicy").length, 1);
  assert.equal(policy.apiVersion, "ecr.aws.upbound.io/v1beta1");
  assert.equal(policy.metadata.annotations["crossplane.io/external-name"], "team/app");
  assert.equal(policy.spec.deletionPolicy, "Orphan");
  assert.deepEqual(policy.spec.providerConfigRef, { name: "registry-controller" });
  assert.deepEqual(policy.spec.forProvider.repositoryRef, { name: "app-images" });
  assert.equal(policy.spec.forProvider.region, config.region);
  const statements = JSON.parse(policy.spec.forProvider.policy).Statement;
  assert.deepEqual(statements, [{
    Sid: "OnlyDeclaredWriters", Effect: "Deny", Principal: "*",
    Action: ["ecr:InitiateLayerUpload", "ecr:UploadLayerPart", "ecr:CompleteLayerUpload", "ecr:PutImage",
      "ecr:ReplicateImage", "ecr:BatchImportUpstreamImage"],
    Condition: { ArnNotEquals: { "aws:PrincipalArn": ["arn:aws:iam::123456789012:role/publisher"] } },
  }, {
    Sid: "RetainRepositoryContent", Effect: "Deny", Principal: "*",
    Action: ["ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:PutLifecyclePolicy"],
  }]);
  assert.ok(statements.every((s: any) => !("Resource" in s)), "ECR scopes its repository policy at attachment, not with Resource");
  // The boundary never grants access, creates keys, or modifies read permissions.
  assert.equal(statements.some((s: any) => s.Effect === "Allow" || s.Action.some((a: string) => a.includes("Get"))), false);
  const baseline = Testing.chart(); new EcrRepository(baseline, "images", { ...config, providerConfigRef: "registry-controller" });
  assert.deepEqual(resources.filter(r => r.kind !== "RepositoryPolicy"), Testing.synth(baseline));
  assert.equal(resources.some(r => r.kind === "LifecyclePolicy" || r.kind === "AccessKey" || r.kind === "User"), false);
});

test("writer and retention guardrails are independent, explicit and fail closed on ambiguous input", () => {
  for (const patch of [{ exclusivePush: "true" }, { retainContent: "true" },
    { exclusivePush: true, grants: [] }, { exclusivePush: true, grants: [{ roleName: "puller", access: "pull" }] }]) {
    assert.throws(() => new EcrRepository(Testing.chart(), "images", { ...config, ...patch } as EcrRepositoryConfig));
  }
  for (const [patch, expected] of [
    [{ exclusivePush: true }, ["OnlyDeclaredWriters"]],
    [{ retainContent: true, grants: [] }, ["RetainRepositoryContent"]],
  ] as const) {
    const chart = Testing.chart();
    new EcrRepository(chart, "images", { ...config, ...patch, grants: "grants" in patch ? [] : config.grants });
    const policy = Testing.synth(chart).find(r => r.kind === "RepositoryPolicy");
    assert.deepEqual(JSON.parse(policy.spec.forProvider.policy).Statement.map((s: any) => s.Sid), expected);
  }
  const chart = Testing.chart();
  new EcrRepository(chart, "images", { ...config, exclusivePush: true, grants: [
    { roleName: "first", access: "push" }, { roleName: "reader", access: "pull" }, { roleName: "second", access: "push" },
  ] });
  const policy = Testing.synth(chart).find(r => r.kind === "RepositoryPolicy");
  assert.deepEqual(JSON.parse(policy.spec.forProvider.policy).Statement[0].Condition.ArnNotEquals["aws:PrincipalArn"],
    ["arn:aws:iam::123456789012:role/first", "arn:aws:iam::123456789012:role/second"]);
});
