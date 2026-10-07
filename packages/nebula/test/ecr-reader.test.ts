import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { readerConfig, readerResources } from "./support/ecr-reader/config";
import { registryReaderRunnerConfig, ECR_READER_AWS_CLI_IMAGE, ECR_READER_TOOLS_IMAGE } from "../src/modules/infra/aws/ecr-scaled-job-reader";

test("one existing bounded job receives isolated credentials with unchanged scheduling and resource limits", () => {
  const resources = readerResources();
  assert.deepEqual(resources.map(resource => resource.kind).sort(), ["ConfigMap", "ScaledJob", "ServiceAccount"]);
  const job = resources.find(resource => resource.kind === "ScaledJob")!;
  const pod = job.spec.jobTargetRef.template.spec;
  const code = resources.find(resource => resource.kind === "ConfigMap")!.data;
  assert.deepEqual(job.spec.rollout, { strategy: "gradual" });
  assert.equal(job.spec.jobTargetRef.activeDeadlineSeconds, 10800);
  assert.equal(pod.serviceAccountName, readerConfig.serviceAccount);
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(resources.find(resource => resource.kind === "ServiceAccount")!.automountServiceAccountToken, false);
  assert.deepEqual(pod.initContainers.map((container: any) => container.image), [ECR_READER_AWS_CLI_IMAGE, ECR_READER_TOOLS_IMAGE]);
  assert.deepEqual(pod.initContainers.map((container: any) => container.resources), [
    { requests: { cpu: "50m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
    { requests: { cpu: "20m", memory: "32Mi" }, limits: { cpu: "200m", memory: "96Mi" } },
  ]);
  for (const container of pod.initContainers) {
    assert.equal(container.securityContext.runAsUser, 1000);
    assert.equal(container.securityContext.allowPrivilegeEscalation, false);
    assert.equal(container.securityContext.readOnlyRootFilesystem, true);
    assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
  }
  assert.deepEqual(pod.volumes.filter((volume: any) => volume.emptyDir?.medium === "Memory").map((volume: any) => volume.emptyDir),
    [{ medium: "Memory", sizeLimit: "2Mi" }, { medium: "Memory", sizeLimit: "2Mi" }]);
  assert.deepEqual(pod.volumes.find((volume: any) => volume.name === "registry-identity").projected.sources,
    [{ serviceAccountToken: { audience: "sts.amazonaws.com", expirationSeconds: 3600, path: "token" } }]);
  for (const container of [pod.initContainers[1], ...pod.containers])
    assert.ok(!container.volumeMounts.some((mount: any) => mount.name === "registry-identity"));
  assert.deepEqual(pod.containers[0].volumeMounts, [
    { name: "docker", mountPath: "/docker" }, { name: "registry-credentials", mountPath: "/run/registry", readOnly: true },
  ]);
  assert.equal(job.spec.jobTargetRef.template.metadata.annotations["checksum/registry-reader"],
    createHash("sha256").update(code["credentials.jq"]).update(code["token.sh"]).digest("hex"));
  assert.equal(job.spec.jobTargetRef.template.metadata.annotations["keep.example.test/value"], "unchanged");
  assert.match(code["token.sh"], /--role-session-name runner-registry-reader/);
  assert.match(code["credentials.jq"], /\$expires - \$now\) >= 14400/);
  const runner = parse(registryReaderRunnerConfig({ credentialsPath: "/run/registry", environmentVariable: "REGISTRY_READER_CONFIG" }));
  assert.deepEqual(runner.runner.envs, { REGISTRY_READER_CONFIG: "/run/registry" });
  assert.equal(runner.container.options, "--volume=/run/registry:/run/registry:ro");
});

test("ambiguous jobs, credential lifetimes and injected labels fail before reader resources are added", () => {
  for (const patch of [
    { roleSessionName: "unsafe;execute" }, { errorLabel: "bad'quoted" }, { credentialsPath: "/run/../secret" },
    { images: { awsCli: "example.test/aws:latest", tools: ECR_READER_TOOLS_IMAGE } },
    { minimumCredentialLifetimeSeconds: 12000 }, { minimumCredentialLifetimeSeconds: 43201 },
  ]) assert.throws(() => readerResources({ ...readerConfig, ...patch }));
  for (const change of [
    (resource: any) => { resource.spec.jobTargetRef.activeDeadlineSeconds = undefined; },
    (resource: any) => { resource.spec.jobTargetRef.template.spec.securityContext.fsGroup = 2000; },
    (resource: any) => { resource.spec.jobTargetRef.template.spec.initContainers = [{ name: "already-there" }]; },
    (resource: any) => { resource.spec.jobTargetRef.template.spec.volumes.push({ name: "registry-code" }); },
  ]) assert.throws(() => readerResources(readerConfig, change));
  assert.throws(() => registryReaderRunnerConfig({ credentialsPath: "/run/registry", environmentVariable: "BAD\nKEY" }));
});
