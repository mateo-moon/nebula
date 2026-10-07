import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsServiceAccountRegistryIdentity, type AwsServiceAccountRegistryIdentityConfig } from "../src/modules/infra/aws/service-account-registry-identity";

const config: AwsServiceAccountRegistryIdentityConfig = {
  accountId: "123456789012", region: "eu-central-1", issuerUrl: "https://issuer.example.test",
  oidcProviderName: "cluster-oidc", repositoryName: "images/runtime", readerRole: "ci-image-reader",
  namespace: "ci", serviceAccount: "runner",
};
function synth(overrides: Partial<AwsServiceAccountRegistryIdentityConfig> = {}) {
  const chart = Testing.chart();
  new AwsServiceAccountRegistryIdentity(chart, "identity", { ...config, ...overrides });
  return Testing.synth(chart);
}

test("registry identity retains the issuer and grants only the exact service account repository reads", () => {
  const resources = synth();
  assert.equal(resources.length, 4);
  const providerArn = "arn:aws:iam::123456789012:oidc-provider/issuer.example.test";
  const issuer = resources.find(resource => resource.kind === "OpenIDConnectProvider")!;
  assert.deepEqual(issuer.metadata, {
    name: "cluster-oidc", annotations: { "crossplane.io/external-name": providerArn },
  });
  assert.deepEqual(issuer.spec, {
    deletionPolicy: "Orphan", providerConfigRef: { name: "default" },
    forProvider: { url: config.issuerUrl, clientIdList: ["sts.amazonaws.com"] },
  });
  const role = resources.find(resource => resource.kind === "Role")!;
  assert.equal(role.metadata.name, "ci-image-reader");
  assert.equal(role.metadata.annotations["crossplane.io/external-name"], "ci-image-reader");
  assert.equal(role.spec.forProvider.maxSessionDuration, 3600);
  assert.deepEqual(JSON.parse(role.spec.forProvider.assumeRolePolicy), {
    Version: "2012-10-17", Statement: [{
      Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity", Principal: { Federated: providerArn },
      Condition: { StringEquals: {
        "issuer.example.test:aud": "sts.amazonaws.com",
        "issuer.example.test:sub": "system:serviceaccount:ci:runner",
      } },
    }],
  });
  const policy = resources.find(resource => resource.kind === "Policy")!;
  assert.deepEqual(JSON.parse(policy.spec.forProvider.policy), {
    Version: "2012-10-17", Statement: [
      { Effect: "Allow", Action: ["ecr:GetAuthorizationToken"], Resource: "*" },
      { Effect: "Allow", Action: ["ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer", "ecr:BatchGetImage"],
        Resource: "arn:aws:ecr:eu-central-1:123456789012:repository/images/runtime" },
    ],
  });
  const attachment = resources.find(resource => resource.kind === "RolePolicyAttachment")!;
  assert.deepEqual(attachment.spec, { providerConfigRef: { name: "default" },
    forProvider: { role: "ci-image-reader", policyArnRef: { name: "ci-image-reader" } } });
});

test("registry identity routes all IAM objects through the selected provider", () => {
  const resources = synth({ awsProviderConfigName: "shared-identity", region: "ap-southeast-2" });
  for (const resource of resources) assert.deepEqual(resource.spec.providerConfigRef, { name: "shared-identity" });
  assert.ok(resources.find(resource => resource.kind === "Policy")!.spec.forProvider.policy.includes(
    "arn:aws:ecr:ap-southeast-2:123456789012:repository/images/runtime"));
});

test("registry identity rejects broad or malformed issuer and repository identities", () => {
  for (const issuerUrl of ["http://issuer.example.test", "https://user:password@issuer.example.test",
    "https://issuer.example.test/path", "https://issuer.example.test?key=value", "https://issuer.example.test#fragment"])
    assert.throws(() => synth({ issuerUrl }), /HTTPS origin/);
  for (const overrides of [
    { namespace: "*" }, { serviceAccount: "runner*" }, { readerRole: "reader-" },
    { oidcProviderName: "*" }, { repositoryName: "*" }, { repositoryName: "images/*" },
    { accountId: "*" }, { region: "cn-north-1" },
  ]) assert.throws(() => synth(overrides));
});
