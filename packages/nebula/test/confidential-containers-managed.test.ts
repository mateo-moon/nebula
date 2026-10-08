import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mock, test } from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { ConfidentialContainers, createAwsCocoEnrollment, awsCocoProfileId, RuntimeClasses,
  type AwsCocoRelease, type AwsCocoProfile } from "../src";
import { validateAwsCocoRelease } from "../src/modules/k8s/confidential-containers/aws-coco-release";

const require = createRequire(import.meta.url);
const { _child_process } = require("cdk8s/lib/_child_process");
const archive = fileURLToPath(new URL("./confidential-containers-fixtures/confidential-containers-0.23.0.tgz", import.meta.url));
mock.method(_child_process, "spawnSync", (command: string, args: string[], options: any) => {
  if (command !== "helm") return spawnSync(command, args, options);
  const local = args.filter((arg, index) => arg !== "--version" && args[index - 1] !== "--version");
  local[local.length - 1] = archive;
  return spawnSync(command, local, options);
});

/** Synthetic release metadata. No live image/measurement is approved here. */
function fixture(): AwsCocoRelease {
  const profile = (role: "authority" | "runtime", hex: string): AwsCocoProfile => {
    const value = { role, pcr4: hex.repeat(96), pcr12: "c".repeat(96), minimumTcb: { bootloader: 10, tee: 0, snp: 27, microcode: 160 } };
    return { ...value, release: awsCocoProfileId(value) };
  };
  const authority = profile("authority", "a"), runtime = profile("runtime", "b");
  const artifact = { url: "https://github.com/example/fixture/releases/download/test/image.raw.gz", sha256: "a".repeat(64),
    compressedSize: 100, rawSha256: "b".repeat(64), rawSize: 1024 };
  return { version: 1, id: createHash("sha256").update(`${authority.release}\n${runtime.release}\n`).digest("hex"),
    authority: { profile: authority, artifact }, runtime: { profile: runtime, artifact },
    controllerImage: "ghcr.io/example/controller@sha256:" + "c".repeat(64),
    caaImage: "quay.io/confidential-containers/cloud-api-adaptor@sha256:" + "d".repeat(64),
    cleanupImage: "quay.io/confidential-containers/peerpod-ctrl@sha256:" + "e".repeat(64),
    clients: { "linux-x64": { url: "https://github.com/example/fixture/releases/download/test/client", sha256: "f".repeat(64), size: 100 } } };
}

test("managed mode owns provisioning and credential bridges without synthesizing image keys or external infrastructure handles", async () => {
  const release = fixture();
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
  const enrollment = await createAwsCocoEnrollment({ release, nonce: "1".repeat(64), owners: { keys: [publicKey], threshold: 1 },
    signers: [{ publicKey, sign: async bytes => sign(null, bytes, keys.privateKey) }] });
  const chart = new Chart(new App(), "managed");
  new ConfidentialContainers(chart, "coco", { namespace: "coco-system", nodeSelector: { "example.com/workers": "true" },
    shims: { snp: false }, awsNitroTpm: { mode: "managed", release, enrollment,
      placement: { vpcId: "vpc-0123456789abcdef0", workerSecurityGroupIds: ["sg-0123456789abcdef0"] } } });
  const objects = Testing.synth(chart);
  const runtime = objects.find(value => value.kind === "AwsConfidentialRuntime")!;
  assert.equal(runtime.spec.region, "eu-west-1");
  assert.deepEqual(Object.keys(runtime.spec).sort(), ["deployment", "genesis", "placement", "region", "release"]);
  assert.equal(objects.filter(value => value.kind === "AccessKey").length, 3);
  assert.ok(!objects.some(value => value.kind === "Secret"));
  assert.ok(!objects.some(value => value.metadata.annotations?.["helm.sh/hook"] === "post-delete"), "cleanup must finish before the module namespace is deleted");
  assert.ok(!objects.some(value => value.metadata.annotations?.["helm.sh/resource-policy"] === "keep"), "normal pruning must own all installer resources");
  const installer = objects.find(value => value.kind === "DaemonSet" && value.metadata.name === "kata-as-coco-runtime")!;
  assert.equal(installer.metadata.annotations["argocd.argoproj.io/sync-options"], "PrunePropagationPolicy=foreground");
  for (const [kind, suffix] of [["ServiceAccount", "sa"], ["ClusterRole", "role"], ["ClusterRoleBinding", "rb"]]) {
    const resource = objects.find(value => value.kind === kind && value.metadata.name === `kata-as-coco-runtime-${suffix}`)!;
    assert.equal(resource.metadata.annotations["argocd.argoproj.io/sync-wave"], "-4", "installer permissions must outlive its Pods and precede namespace deletion");
  }
  assert.ok(!objects.some(value => value.apiVersion.startsWith("cert-manager.io/")), "managed admission must not require an external certificate controller");
  assert.ok(objects.some(value => value.kind === "CustomResourceDefinition" && value.metadata.name === "peerpods.confidentialcontainers.org" &&
    value.metadata.annotations["argocd.argoproj.io/sync-wave"] === "-10"), "cleanup controller must receive its CRD before starting");
  assert.ok(objects.filter(value => value.apiVersion === "iam.aws.upbound.io/v1beta1").every(value => value.spec.providerConfigRef.name === "default"));
  assert.ok(objects.filter(value => ["Role", "Policy", "User", "InstanceProfile"].includes(value.kind) && value.apiVersion.startsWith("iam.")).every(value =>
    value.metadata.annotations["crossplane.io/external-name"] && !value.spec.forProvider.name));
  const guestPolicy = objects.find(value => value.kind === "Policy" && value.metadata.name.endsWith("guest-boot"))!;
  assert.deepEqual(JSON.parse(guestPolicy.spec.forProvider.policy).Statement[0].Action, ["s3:GetObject"]);
  const controllerPolicy = objects.find(value => value.kind === "Policy" && value.metadata.name.endsWith("controller-policy"))!;
  const bucketPolicy = JSON.parse(controllerPolicy.spec.forProvider.policy).Statement.find((statement: any) => statement.Action.includes("s3:CreateBucket"));
  assert.ok(bucketPolicy.Action.includes("s3:PutBucketOwnershipControls"), "AWS requires ownership permission with BucketOwnerEnforced creation");
  const cm = objects.find(value => value.kind === "ConfigMap" && value.metadata.name === "peer-pods-cm")!;
  for (const key of ["AWS_SUBNET_ID", "AWS_SG_IDS", "PODVM_AMI_ID", "PODVM_LAUNCHTEMPLATE_NAME"]) {
    assert.ok(!Object.hasOwn(cm.data, key), `${key} must remain controller-owned across GitOps syncs`);
  }
  assert.equal(cm.data.AWS_REGION, "eu-west-1");
  assert.equal(cm.data.PODVM_INSTANCE_TYPE, "c6a.large");
  assert.match(cm.data.TAGS, /NebulaCocoDeployment=[a-f0-9]{64},NebulaCocoComponent=runtime/);
  const caa = objects.find(value => value.kind === "DaemonSet" && value.metadata.name === "cloud-api-adaptor-daemonset")!;
  const env = caa.spec.template.spec.containers[0].env;
  assert.ok(env.some((item: any) => item.name === "AWS_ACCESS_KEY_ID" && item.valueFrom.secretKeyRef.key === "username"));
  assert.ok(!env.some((item: any) => item.name === "AWS_ROLE_ARN"));
  assert.ok(caa.spec.template.spec.initContainers.some((item: any) => item.name === "managed-image-ready"));
  const cleanup = objects.find(value => value.kind === "Deployment" && value.metadata?.labels?.["app.kubernetes.io/created-by"] === "peerpodctrl")!;
  const wave = (resource: any) => Number(resource.metadata.annotations?.["argocd.argoproj.io/sync-wave"] ?? 0);
  assert.ok(wave(cleanup) < wave(runtime), "reverse pruning must keep the cleanup controller alive until the runtime finishes");
  for (const dependency of objects.filter(value => value.metadata.name.startsWith("peerpodctrl-") && value !== cleanup)) {
    assert.ok(wave(dependency) < wave(cleanup), "cleanup permissions/services must outlive its controller");
  }
  assert.ok(wave(cm) < wave(cleanup), "static region configuration must exist before cleanup starts and survive its deletion");
  assert.ok(wave(caa) > wave(runtime), "image-dependent CAA startup must not block runtime provisioning");
  const managedRole = objects.find(value => value.kind === "ClusterRole" && value.metadata.name === runtime.metadata.name)!;
  assert.deepEqual(managedRole.rules.find((rule: any) => rule.resources.includes("peerpods")), {
    apiGroups: ["confidentialcontainers.org"], resources: ["peerpods"], verbs: ["get", "list", "delete"],
  }, "the module requests normal peer-pod deletion without permission to strip finalizers");
  for (const resource of [caa, cleanup]) assert.deepEqual(resource.spec.template.spec.nodeSelector,
    { "example.com/workers": "true", "kubernetes.io/arch": "amd64" });
  assert.equal(caa.spec.template.metadata.annotations?.["coco.nebula.io/config"], undefined);
  assert.equal(cleanup.spec.template.metadata.annotations?.["coco.nebula.io/credentials"], undefined);
  const admission = objects.find(value => value.kind === "Deployment" && value.metadata?.labels?.["app.kubernetes.io/created-by"] === "peerpods-webhook")!;
  const webhook = objects.find(value => value.kind === "MutatingWebhookConfiguration")!;
  const service = objects.find(value => value.kind === "Service" && value.metadata.name === "peer-pods-webhook-webhook-service")!;
  assert.equal(admission.metadata.namespace, "coco-system");
  assert.equal(admission.spec.template.spec.volumes.find((value: any) => value.name === "cert").secret.secretName, runtime.metadata.name + "-admission");
  assert.ok(admission.spec.template.spec.containers[0].env.some((value: any) => value.name === "TARGET_RUNTIMECLASS" && value.value === RuntimeClasses.AWS_NITRO_TPM));
  assert.deepEqual(service.spec.selector, admission.spec.selector.matchLabels);
  assert.notDeepEqual(admission.spec.selector.matchLabels, cleanup.spec.selector.matchLabels, "same-namespace controllers need distinct selectors");
  assert.equal(webhook.webhooks[0].failurePolicy, "Fail");
  assert.deepEqual(webhook.webhooks[0].matchConditions, [{ name: "aws-confidential-runtime", expression:
    `has(object.spec.runtimeClassName) && object.spec.runtimeClassName == ${JSON.stringify(RuntimeClasses.AWS_NITRO_TPM)}` }]);
  assert.equal(webhook.webhooks[0].namespaceSelector, undefined, "the installation canary uses the module namespace");
  assert.equal(webhook.webhooks[0].clientConfig.caBundle, undefined, "CA rotation remains controller-owned");
  assert.ok(objects.some(value => value.kind === "RuntimeClass" && value.metadata.name === RuntimeClasses.AWS_NITRO_TPM));
  const controller = objects.find(value => value.kind === "Deployment" && value.metadata.name.startsWith("nebula-coco-"))!;
  assert.equal(controller.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(controller.spec.template.spec.serviceAccountName, runtime.metadata.name);
  assert.ok(Number(runtime.metadata.annotations["argocd.argoproj.io/sync-wave"]) > Number(controller.metadata.annotations["argocd.argoproj.io/sync-wave"]));
  assert.ok(Number(runtime.metadata.annotations["argocd.argoproj.io/sync-wave"]) < 0, "declaration must precede waiting CAA pods");
  assert.throws(() => new ConfidentialContainers(chart, "missing-class", { createRuntimeClasses: false,
    nodeSelector: { "example.com/workers": "true" }, awsNitroTpm: { mode: "managed", release, enrollment,
      placement: { vpcId: "vpc-0123456789abcdef0", workerSecurityGroupIds: ["sg-0123456789abcdef0"] } } }),
    /requires its runtime class/);
});

test("release measurements, firmware floors, raw disk and client artifacts are committed before use", () => {
  validateAwsCocoRelease(fixture());
  for (const mutate of [
    (release: any) => release.authority.profile.pcr4 = "d".repeat(96),
    (release: any) => release.authority.profile.minimumTcb.snp--,
    (release: any) => release.runtime.artifact.url = "http://example.com/live.raw",
    (release: any) => release.controllerImage = "ghcr.io/example/controller:latest",
    (release: any) => release.clients["linux-x64"].size = Number.MAX_SAFE_INTEGER,
  ]) {
    const release = structuredClone(fixture()); mutate(release);
    assert.throws(() => validateAwsCocoRelease(release));
  }
});

test("the UKI reset PCR12 is pinned while an unmeasured boot image is refused", () => {
  const updateCommitments = (release: AwsCocoRelease): AwsCocoRelease => {
    const authority = { ...release.authority, profile: { ...release.authority.profile, release: awsCocoProfileId(release.authority.profile) } };
    const runtime = { ...release.runtime, profile: { ...release.runtime.profile, release: awsCocoProfileId(release.runtime.profile) } };
    return { ...release, authority, runtime, id: createHash("sha256").update(`${authority.profile.release}\n${runtime.profile.release}\n`).digest("hex") };
  };
  const base = fixture();
  const release = updateCommitments({ ...base,
    authority: { ...base.authority, profile: { ...base.authority.profile, pcr12: "0".repeat(96) } },
    runtime: { ...base.runtime, profile: { ...base.runtime.profile, pcr12: "0".repeat(96) } } });
  validateAwsCocoRelease(release);
  const unmeasured = updateCommitments({ ...release,
    authority: { ...release.authority, profile: { ...release.authority.profile, pcr4: "0".repeat(96) } } });
  assert.throws(() => validateAwsCocoRelease(unmeasured), /profile commitment/);
});
