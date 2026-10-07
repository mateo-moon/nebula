import assert from "node:assert/strict";
import test from "node:test";
import { registryConfig, registryResources } from "./support/image-registry-config";

test("registry uses exact deployment identities while preserving retained repositories and scoped trust", () => {
  const config = structuredClone(registryConfig);
  config.awsProviderConfigName = "identity-account";
  const resources = registryResources(config);
  assert.equal(resources.length, 38);
  const repositories = resources.filter(resource => resource.kind === "Repository");
  assert.equal(repositories.length, 3);
  for (const repository of repositories) {
    assert.equal(repository.spec.deletionPolicy, "Orphan");
    assert.equal(repository.spec.forProvider.forceDelete, false);
    assert.equal(repository.spec.forProvider.imageTagMutability, "IMMUTABLE");
  }
  for (const resource of resources.filter(resource => /aws\.upbound\.io/.test(resource.apiVersion)))
    assert.deepEqual(resource.spec.providerConfigRef, { name: "identity-account" });
  const boundary = resources.find(resource => resource.kind === "RepositoryPolicy")!;
  const statements = JSON.parse(boundary.spec.forProvider.policy).Statement;
  assert.deepEqual(statements[0].Condition.ArnNotEquals["aws:PrincipalArn"], ["arn:aws:iam::123456789012:role/registry-publisher"]);
  assert.deepEqual(statements[1].Action, ["ecr:BatchDeleteImage", "ecr:DeleteRepository", "ecr:PutLifecyclePolicy"]);
  const publisher = resources.find(resource => resource.kind === "Role" && resource.metadata.name === "registry-publisher")!;
  const trust = JSON.parse(publisher.spec.forProvider.assumeRolePolicy).Statement[0].Condition.StringEquals;
  assert.equal(trust["token.actions.githubusercontent.com:repository_id"], "456");
  assert.equal(trust["token.actions.githubusercontent.com:repository_owner_id"], "123");
  assert.equal(trust["token.actions.githubusercontent.com:job_workflow_ref"], config.github.publisher.workflow);
  assert.equal(trust["token.actions.githubusercontent.com:sub"], config.github.publisher.subject);
  const controller = resources.find(resource => resource.kind === "Policy" && resource.metadata.name === "registry-controller")!;
  const permissions = JSON.parse(controller.spec.forProvider.policy).Statement;
  assert.deepEqual(permissions[0].Resource, ["images/runtime", "mirror", "images/workload"].map(name =>
    `arn:aws:ecr:eu-central-1:123456789012:repository/${name}`));
  assert.ok(permissions.every((statement: { Action: string[] }) => statement.Action.every(action => !/Delete|PutImage$/.test(action))));
});

test("credential delivery retains destination objects and propagates data and expiry through one owner", () => {
  const resources = registryResources();
  const objects = resources.filter(resource => resource.kind === "Object");
  assert.equal(objects.length, 4);
  for (const resource of objects) {
    assert.equal(resource.spec.deletionPolicy, "Orphan");
    assert.equal(resource.spec.providerConfigRef.name, "workload-registry");
  }
  const target = objects.find(resource => resource.metadata.name === "first-app-pull-secret")!;
  assert.equal(target.spec.forProvider.manifest.metadata.name, "registry-auth");
  assert.deepEqual(target.spec.references.slice(1).map((reference: any) => [reference.patchesFrom.name, reference.toFieldPath]),
    [["workload-pull-credentials", "data"], ["workload-pull-credentials", "metadata.annotations"]]);
  const template = resources.find(resource => resource.kind === "CronJob")!.spec.jobTemplate.spec.template;
  assert.equal(template.spec.initContainers[0].env.find((env: any) => env.name === "AWS_EC2_METADATA_DISABLED").value, "true");
  assert.equal(template.spec.initContainers[0].env.find((env: any) => env.name === "AWS_WEB_IDENTITY_TOKEN_FILE").value, "/aws/token");
  assert.equal(template.spec.securityContext.runAsNonRoot, true);
  assert.equal(resources.find(resource => resource.kind === "Role" && resource.apiVersion.startsWith("rbac"))!.rules[0].resourceNames[0],
    "workload-pull-credentials");
});

test("registry assets accept configured aliases and names without changing unconfigured scripts", () => {
  const before = registryResources();
  const config = structuredClone(registryConfig);
  config.refresh = { credentialsSecretName: "custom-credentials", expiryAnnotation: "registry.example.test/expires-at" };
  const after = registryResources(config);
  const code = after.find(resource => resource.kind === "ConfigMap")!.data;
  assert.match(code["registry.sh"], /get secret custom-credentials --ignore-not-found/);
  assert.match(code["registry.sh"], /"registry.example.test\/expires-at"/);
  assert.ok(!JSON.stringify(code).includes("__"));
  assert.match(code["credentials.jq"], /"gcr.io\/example-project\/second":/);
  const mirrorName = (resources: any[]) => resources.find(resource => resource.kind === "Job" && !resource.metadata.annotations["argocd.argoproj.io/hook"])!.metadata.name;
  assert.notEqual(mirrorName(before), mirrorName(after), "content changes require a new immutable mirror Job");
  assert.equal(mirrorName(before), mirrorName(registryResources()), "same config keeps the Job identity");
});

test("registry rejects shell injection, mutable identities, duplicate destinations and source digests", () => {
  for (const mutate of [
    (config: typeof registryConfig) => { config.refresh = { credentialsSecretName: "name;exec" }; },
    (config: typeof registryConfig) => { config.refresh = { expiryAnnotation: "unsafe'annotation" }; },
    (config: typeof registryConfig) => { config.github.publisher.workflow = "example/runtime/.github/workflows/publish.yml@main"; },
    (config: typeof registryConfig) => { config.github.readerSubjects = ["repo:example/*"]; },
    (config: typeof registryConfig) => { config.images.tools = "example/tools:latest"; },
    (config: typeof registryConfig) => { config.distribution.targets.push(config.distribution.targets[0]); },
    (config: typeof registryConfig) => { config.gcr.mirroredImages.push(config.gcr.mirroredImages[0]); },
    (config: typeof registryConfig) => { config.roles.mirror = config.roles.puller; },
  ]) {
    const config = structuredClone(registryConfig);
    mutate(config);
    assert.throws(() => registryResources(config));
  }
});
