import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mock, test } from "node:test";
import { App, Chart, Testing, Yaml } from "cdk8s";
import { ConfidentialContainers, RuntimeClasses, awsNitroTpmLaunchTemplate,
  awsNitroTpmAssetsUrl,
  type ConfidentialContainersConfig, type AwsNitroTpmRuntimeConfig } from "../src";

const require = createRequire(import.meta.url);
const { _child_process } = require("cdk8s/lib/_child_process");
const archive = fileURLToPath(new URL("./confidential-containers-fixtures/confidential-containers-0.23.0.tgz", import.meta.url));
const calls: { version: string; values: any }[] = [];
// Substitute only the download location; exercise the real pinned chart.
mock.method(_child_process, "spawnSync", (command: string, args: string[], options: any) => {
  if (command !== "helm") return spawnSync(command, args, options);
  assert.equal(args.at(-1), "oci://ghcr.io/confidential-containers/charts/confidential-containers");
  calls.push({ version: args[args.indexOf("--version") + 1],
    values: Yaml.load(args[args.indexOf("-f") + 1])[0] });
  const localArgs = args.filter((arg, index) => arg !== "--version" && args[index - 1] !== "--version");
  localArgs[localArgs.length - 1] = archive;
  return spawnSync(command, localArgs, options);
});

const awsSettings = (): AwsNitroTpmRuntimeConfig => ({
  accountId: "123456789012", region: "eu-west-1", imageId: "ami-0123456789abcdef0", instanceType: "m6a.2xlarge",
  subnetId: "subnet-0123456789abcdef0", securityGroupIds: ["sg-0123456789abcdef0"], launchTemplateName: "coco-guest",
  peerPodsLimitPerNode: 4, caaRoleArn: "arn:aws:iam::123456789012:role/coco-caa",
  cleanupRoleArn: "arn:aws:iam::123456789012:role/coco-cleanup",
  caaImage: `ghcr.io/confidential-containers/cloud-api-adaptor@sha256:${"a".repeat(64)}`,
  cleanupImage: `quay.io/confidential-containers/peerpodctrl@sha256:${"b".repeat(64)}`,
});
const settings = (): ConfidentialContainersConfig => ({
  namespace: "coco-system", nodeSelector: { "example.com/pool": "remote-workers" },
  shims: { snp: false, tdx: false, cocoDev: false }, awsNitroTpm: awsSettings(),
});
function render(config: ConfidentialContainersConfig): any[] {
  const chart = new Chart(new App(), "platform");
  new ConfidentialContainers(chart, "coco", config);
  return Testing.synth(chart);
}

test("the offline chart is the unmodified pinned public release", () => {
  assert.equal(createHash("sha256").update(readFileSync(archive)).digest("hex"),
    "38d2f6e579bc2ca5a3e8afb1cae8e0f6f458b19c4175d4e7ffd42a5d3c1f23d3");
});

test("AWS is selectable through the reusable CoCo module and a distinct RuntimeClass", () => {
  const config = settings();
  const objects = render(config);
  const [runtime] = objects.filter(object => object.kind === "RuntimeClass");
  assert.equal(runtime.metadata.name, RuntimeClasses.AWS_NITRO_TPM);
  assert.equal(runtime.handler, "kata-remote");
  assert.deepEqual(runtime.overhead.podFixed, { memory: "120Mi", cpu: "250m" });
  assert.equal(runtime.scheduling.nodeSelector["kubernetes.io/arch"], "amd64");
  assert.equal(runtime.scheduling.nodeSelector["example.com/pool"], "remote-workers");
  assert.equal(objects.filter(object => object.kind === "DaemonSet").length, 2);
  assert.ok(!objects.some(object => ["Pod", "Secret"].includes(object.kind)));
  const cm = objects.find(object => object.kind === "ConfigMap" && object.metadata.name === "peer-pods-cm");
  for (const [key, value] of Object.entries({ CLOUD_PROVIDER: "aws", DISABLECVM: "false", USE_PUBLIC_IP: "false",
    SSH_KP_NAME: "", PODVM_DEVELOPER_MODE: "false", TLS_SKIP_VERIFY: "false", TLS_MIN_VERSION: "VersionTLS13",
    CLOUD_CONFIG_VERIFY: "true", ROOT_VOLUME_SIZE: "0", USE_PODVM_LAUNCHTEMPLATE: "true",
    PODVM_LAUNCHTEMPLATE_NAME: "coco-guest", PEERPODS_LIMIT_PER_NODE: "4" })) assert.equal(cm.data[key], value, key);
  assert.equal(calls.at(-1)?.version, "0.23.0");
  assert.equal(calls.at(-1)?.values["kata-as-coco-runtime"].defaultShim.amd64, "remote");
  assert.equal(calls.at(-1)?.values["kata-as-coco-runtime"].nodeSelector["kubernetes.io/arch"], "amd64");
  assert.ok(readFileSync(new URL("verifier.py", awsNitroTpmAssetsUrl()), "utf8").includes("class EvidenceVerifier"));
});

test("local SNP and TDX RuntimeClasses can coexist with AWS without changing their rendered definitions", () => {
  const local = { namespace: "coco-system", version: "0.23.0", shims: { snp: true, tdx: true, cocoDev: false },
    nodeSelector: settings().nodeSelector };
  const baseline = render(local);
  const combined = render({ ...local, awsNitroTpm: awsSettings() });
  for (const name of [RuntimeClasses.AMD_SEV_SNP, RuntimeClasses.INTEL_TDX]) {
    const find = (objects: any[]) => objects.find(object => object.kind === "RuntimeClass" && object.metadata.name === name);
    assert.ok(find(combined));
    assert.deepEqual(find(combined), find(baseline));
  }
  assert.ok(combined.some(object => object.metadata.name === RuntimeClasses.AWS_NITRO_TPM));
  assert.equal(calls.at(-1)?.values["kata-as-coco-runtime"].defaultShim.amd64, "qemu-snp");
  assert.ok(!combined.some(object => object.kind === "RuntimeClass" && object.metadata.name === "kata-remote"));
});

test("omitting AWS preserves the existing version, default chart values and absence of CAA", () => {
  const objects = render({});
  const call = calls.at(-1)!;
  assert.equal(call.version, "0.18.0");
  assert.deepEqual(call.values, { "kata-as-coco-runtime": {
    imagePullPolicy: "IfNotPresent", k8sDistribution: "k0s", debug: false, runtimeClasses: { enabled: true },
  } });
  assert.ok(!objects.some(object => object.metadata.name === RuntimeClasses.AWS_NITRO_TPM || object.metadata.name === "cloud-api-adaptor-daemonset"));
});

test("disabling RuntimeClass creation omits all classes without dropping the typed controller configuration", () => {
  const objects = render({ ...settings(), createRuntimeClasses: false });
  assert.ok(!objects.some(object => object.kind === "RuntimeClass"));
  assert.ok(objects.some(object => object.metadata.name === "cloud-api-adaptor-daemonset"));
});

test("CAA and cleanup use pinned images and separate projected web-identity credentials", () => {
  const aws = awsSettings();
  const controllers = render(settings()).filter(object => object.metadata.name === "cloud-api-adaptor-daemonset" ||
    object.kind === "Deployment" && object.metadata.labels?.["app.kubernetes.io/created-by"] === "peerpodctrl");
  assert.equal(controllers.length, 2);
  for (const controller of controllers) {
    const spec = controller.spec.template.spec;
    const env = Object.fromEntries(spec.containers[0].env.map((item: any) => [item.name, item.value]));
    assert.equal(spec.containers[0].image, controller.kind === "DaemonSet" ? aws.caaImage : aws.cleanupImage);
    assert.equal(env.AWS_ROLE_ARN, controller.kind === "DaemonSet" ? aws.caaRoleArn : aws.cleanupRoleArn);
    assert.equal(env.AWS_WEB_IDENTITY_TOKEN_FILE, "/var/run/secrets/aws/token");
    assert.equal(env.AWS_EC2_METADATA_DISABLED, "true");
    assert.ok(!("AWS_ACCESS_KEY_ID" in env) && !("AWS_SECRET_ACCESS_KEY" in env));
    assert.ok(!spec.containers[0].envFrom.some((source: any) => source.secretRef));
    assert.deepEqual(spec.volumes.find((volume: any) => volume.name === "aws-web-identity").projected.sources,
      [{ serviceAccountToken: { audience: "sts.amazonaws.com", expirationSeconds: 3600, path: "token" } }]);
    assert.ok(spec.containers[0].volumeMounts.find((mount: any) => mount.name === "aws-web-identity").readOnly);
  }
});

test("unsafe or unsupported platform inputs fail before adding any resources", () => {
  const mutations: Array<(config: any) => void> = [
    config => config.version = "0.22.0", config => config.debug = true, config => config.nodeSelector = {},
    config => config.nodeSelector["kubernetes.io/arch"] = "arm64",
    config => config.awsNitroTpm.region = "eu-central-1", config => config.awsNitroTpm.instanceType = "m7a.2xlarge",
    config => config.awsNitroTpm.caaRoleArn = config.awsNitroTpm.cleanupRoleArn,
    config => config.awsNitroTpm.caaRoleArn = "arn:aws:iam::000000000000:role/caa",
    config => config.awsNitroTpm.imageId = "ami-*", config => config.awsNitroTpm.securityGroupIds = [],
    config => config.awsNitroTpm.securityGroupIds.push(config.awsNitroTpm.securityGroupIds[0]),
    config => config.awsNitroTpm.caaImage = "ghcr.io/confidential-containers/cloud-api-adaptor:latest",
    config => config.awsNitroTpm.cleanupImage = "quay.io/confidential-containers/peerpodctrl:latest",
    config => config.awsNitroTpm.caaImage = config.awsNitroTpm.caaImage.replace("ghcr.io", "ghcrXio"),
    config => config.awsNitroTpm.peerPodsLimitPerNode = 0, config => config.awsNitroTpm.peerPodsLimitPerNode = 1.5,
    config => config.values = { peerpods: { providerConfigs: { aws: { TLS_SKIP_VERIFY: "true" } } } },
    config => config.values = { "kata-as-coco-runtime": { shims: { remote: { enabled: false } } } },
    config => config.values = { "kata-as-coco-runtime": { env: { multiInstallSuffix: "other" } } },
  ];
  for (const mutate of mutations) {
    const config = settings(); mutate(config);
    const chart = new Chart(new App(), "platform");
    assert.throws(() => new ConfidentialContainers(chart, "coco", config), /ConfidentialContainers awsNitroTpm:/);
    assert.equal(chart.node.children.length, 0);
  }
});

test("the reusable launch template preserves explicit SNP, encrypted root and private placement", () => {
  const config = { ...awsSettings(), providerConfigName: "example-aws", rootDeviceName: "/dev/sda1", rootVolumeSizeGiB: 100,
    volumeKmsKeyArn: "arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-1234-1234-123456789012" };
  const chart = new Chart(new App(), "infrastructure");
  awsNitroTpmLaunchTemplate(chart, "template", config);
  const [object]: any[] = Testing.synth(chart);
  assert.equal(object.kind, "LaunchTemplate");
  assert.equal(object.spec.providerConfigRef.name, "example-aws");
  const template = object.spec.forProvider;
  assert.deepEqual(template.cpuOptions, [{ amdSevSnp: "enabled" }]);
  assert.equal(template.networkInterfaces[0].associatePublicIpAddress, "false");
  assert.equal(template.blockDeviceMappings[0].ebs[0].encrypted, "true");
  assert.equal(template.blockDeviceMappings[0].ebs[0].kmsKeyId, config.volumeKmsKeyArn);
  assert.equal(template.metadataOptions[0].httpTokens, "required");
  for (const field of ["keyName", "iamInstanceProfile", "userData"]) assert.ok(!(field in template));
  const bad = new Chart(new App(), "invalid");
  assert.throws(() => awsNitroTpmLaunchTemplate(bad, "template", { ...config, volumeKmsKeyArn: "invalid" }));
  assert.equal(bad.node.children.length, 0);
});
