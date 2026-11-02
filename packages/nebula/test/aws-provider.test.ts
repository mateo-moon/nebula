import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { AwsProvider, type AwsProviderFamily } from "../src/modules/providers/aws";

const deliveryFamilies: AwsProviderFamily[] = ["cloudfront", "acm"];
const secretRef = { name: "aws-creds", namespace: "crossplane-system", key: "creds" };

test("CloudFront and ACM share the pinned AWS family package and secret ProviderConfig", () => {
  const chart = Testing.chart();
  new AwsProvider(chart, "provider", { families: deliveryFamilies, credentials: { type: "secret", secretRef } });
  const resources = Testing.synth(chart);
  assert.deepEqual(resources.filter(r => r.kind === "Provider").map(r => r.spec.package).sort(), [
    "xpkg.upbound.io/upbound/provider-aws-acm:v2.6.2",
    "xpkg.upbound.io/upbound/provider-aws-cloudfront:v2.6.2",
    "xpkg.upbound.io/upbound/provider-family-aws:v2.6.2",
  ]);
  for (const family of deliveryFamilies) {
    const provider = resources.find(r => r.metadata.name === `provider-aws-${family}`)!;
    assert.equal(provider.spec.runtimeConfigRef, undefined);
    assert.equal(provider.metadata.annotations["argocd.argoproj.io/sync-options"], "Delete=false");
  }
  assert.equal(resources.filter(r => r.kind === "ProviderConfig").length, 1);
  assert.deepEqual(resources.find(r => r.kind === "ProviderConfig")!.spec.credentials, { source: "Secret", secretRef });
  assert.equal(resources.some(r => r.kind === "DeploymentRuntimeConfig"), false);
});

test("CloudFront and ACM honor shared version, naming, and projected WebIdentity settings", () => {
  const chart = Testing.chart();
  const roleArn = "arn:aws:iam::123456789012:role/infrastructure-controller";
  new AwsProvider(chart, "provider", {
    families: deliveryFamilies, name: "delivery-aws", version: "v2.6.0", providerConfigName: "infrastructure",
    credentials: { type: "webIdentity", roleArn, region: "eu-west-1", tokenPath: "/var/run/controller-identity/session-token" },
  });
  const resources = Testing.synth(chart);
  assert.ok(resources.filter(r => r.kind === "Provider").every(r => r.spec.package.endsWith(":v2.6.0")));
  assert.equal(resources.filter(r => r.kind === "DeploymentRuntimeConfig").length, 2);
  for (const family of deliveryFamilies) {
    const name = `delivery-aws-${family}`;
    const provider = resources.find(r => r.kind === "Provider" && r.metadata.name === name)!;
    assert.equal(provider.spec.package, `xpkg.upbound.io/upbound/provider-aws-${family}:v2.6.0`);
    assert.deepEqual(provider.spec.runtimeConfigRef, { name: `${name}-irsa` });
    const runtime = resources.find(r => r.kind === "DeploymentRuntimeConfig" && r.metadata.name === `${name}-irsa`)!;
    const pod = runtime.spec.deploymentTemplate.spec.template.spec;
    assert.deepEqual(pod.containers[0].env, [
      { name: "AWS_REGION", value: "eu-west-1" }, { name: "AWS_STS_REGIONAL_ENDPOINTS", value: "regional" },
    ]);
    assert.deepEqual(pod.containers[0].volumeMounts, [{ name: "aws-iam-token", mountPath: "/var/run/controller-identity", readOnly: true }]);
    assert.deepEqual(pod.volumes[0].projected.sources, [{ serviceAccountToken: { audience: "sts.amazonaws.com", expirationSeconds: 86400, path: "session-token" } }]);
  }
  const providerConfig = resources.find(r => r.kind === "ProviderConfig")!;
  assert.equal(providerConfig.metadata.name, "infrastructure");
  assert.deepEqual(providerConfig.spec.credentials, {
    source: "WebIdentity", webIdentity: { roleARN: roleArn, tokenConfig: { source: "Filesystem", fs: { path: "/var/run/controller-identity/session-token" } } },
  });
});

test("AWS provider defaults still install only EC2 and IAM", () => {
  const chart = Testing.chart();
  new AwsProvider(chart, "provider", { credentials: { type: "secret", secretRef } });
  assert.deepEqual(Testing.synth(chart).filter(r => r.kind === "Provider").map(r => r.metadata.name).sort(), [
    "provider-aws-ec2", "provider-aws-iam", "upbound-provider-family-aws",
  ]);
});
