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
  assert.ok(objects.filter(value => value.apiVersion === "iam.aws.upbound.io/v1beta1").every(value => value.spec.providerConfigRef.name === "default"));
  assert.ok(objects.filter(value => ["Role", "Policy", "User", "InstanceProfile"].includes(value.kind) && value.apiVersion.startsWith("iam.")).every(value =>
    value.metadata.annotations["crossplane.io/external-name"] && !value.spec.forProvider.name));
  const guestPolicy = objects.find(value => value.kind === "Policy" && value.metadata.name.endsWith("guest-boot"))!;
  assert.deepEqual(JSON.parse(guestPolicy.spec.forProvider.policy).Statement[0].Action, ["s3:GetObject"]);
  const cm = objects.find(value => value.kind === "ConfigMap" && value.metadata.name === "peer-pods-cm")!;
  assert.equal(cm.data.PODVM_AMI_ID, "");
  assert.match(cm.data.TAGS, /NebulaCocoDeployment=[a-f0-9]{64},NebulaCocoComponent=runtime/);
  const caa = objects.find(value => value.kind === "DaemonSet" && value.metadata.name === "cloud-api-adaptor-daemonset")!;
  const env = caa.spec.template.spec.containers[0].env;
  assert.ok(env.some((item: any) => item.name === "AWS_ACCESS_KEY_ID" && item.valueFrom.secretKeyRef.key === "username"));
  assert.ok(!env.some((item: any) => item.name === "AWS_ROLE_ARN"));
  assert.ok(caa.spec.template.spec.initContainers.some((item: any) => item.name === "managed-image-ready"));
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
