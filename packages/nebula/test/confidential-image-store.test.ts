import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { parse } from "smol-toml";
import { ConfidentialOperator } from "../src/modules/k8s/confidential-workloads/constructs";
import { imageStoreImage, imageStorePrefix, imageStoreRegistry, validateImageStore } from "../src/modules/k8s/confidential-workloads/image-store";
import { ConfidentialPublicationPending, imageProcess, resolvePublishedImage } from "../src/modules/k8s/confidential-workloads/published-image";
import { validateWorkload } from "../src/modules/k8s/confidential-workloads/validation";
import { workloadSpecSchema } from "../src/modules/k8s/confidential-workloads/schema";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";
import type { ConfidentialImageStore, ConfidentialWorkloadResource } from "../src/modules/k8s/confidential-workloads/types";
import { nativeImageStoreRegistryArgs } from "../src/modules/k8s/trustee/genpolicy";

const store: ConfidentialImageStore = { endpoint: "http://operator-images.qualified.svc:8084", writeEndpoint: "http://operator-images.qualified.svc:8085", repository: "qualified/workload" };
const key = ["default", "image", "app"] as const;
const pinned = `example.invalid/runtime@sha256:${"a".repeat(64)}`;
const declaration = (): ConfidentialWorkloadResource => ({ apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload",
  metadata: { namespace: "qualified", name: "workload" }, spec: { profile: "workload", ownerClaimSha256: "a".repeat(64),
    guest: { measurement: "b".repeat(96), chipId: "c".repeat(128), minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } },
    nodeSelector: { "kubernetes.io/hostname": "snp-node" }, network: { ipv4AddressPattern: "^10[.][0-9.]+$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" },
    trustee: { chart: TRUSTEE_CHART, kbsImage: pinned, tngImage: pinned, gatewayImage: pinned }, storageImage: pinned,
    imageStore: store, containers: [{ name: "app", image: imageStoreImage(store), imageKeyResource: key, command: ["/app/server"], uid: 11000, gid: 11000 }], resources: [key] } });

test("image store routing is one canonical public service and exact namespace/workload", () => {
  assert.doesNotThrow(() => validateImageStore(store, "qualified/workload"));
  assert.equal(imageStoreImage(store), "operator-images.qualified.svc:8084/qualified/workload:release");
  assert.deepEqual(imageStoreRegistry(store), { prefix: imageStorePrefix(store), location: imageStorePrefix(store), insecure: true });
  for (const endpoint of ["https://operator-images.qualified.svc:8084", "http://127.0.0.1:8084", "http://operator-images.qualified.svc:8085",
    "http://operator-images.qualified.svc.cluster.local:8084", store.endpoint + "/", store.endpoint + "/a/../", store.endpoint + "?token=fake", store.endpoint + "#fake", (() => { const url = new URL(store.endpoint); url.username = "example"; url.password = "example"; return url.href; })()]) {
    assert.throws(() => validateImageStore({ ...store, endpoint }));
  }
  for (const changed of [{ ...store, writeEndpoint: "http://different.qualified.svc:8085" }, { ...store, repository: "qualified/../other" },
    { ...store, repository: "qualified/workload/child" }, { ...store, credentials: "synthetic-never-allowed" }, { ...store, writeEndpoint: store.writeEndpoint + "/" }]) {
    assert.throws(() => validateImageStore(changed));
  }
  assert.throws(() => validateImageStore(store, "qualified/other"));
});

test("native genpolicy HTTP transport fences every image at the store authority to one digest repository", () => {
  const app = `${imageStorePrefix(store)}@sha256:${"b".repeat(64)}`;
  assert.deepEqual(nativeImageStoreRegistryArgs([pinned, app], store), ["--insecure-registry", "operator-images.qualified.svc:8084"]);
  assert.deepEqual(nativeImageStoreRegistryArgs([pinned]), [], "Legacy and other registries get no transport flag");
  for (const image of [`operator-images.qualified.svc:8084/qualified/other@sha256:${"c".repeat(64)}`, `${imageStorePrefix(store)}/child@sha256:${"c".repeat(64)}`, imageStoreImage(store),
    `OPERATOR-IMAGES.qualified.svc:8084/qualified/other@sha256:${"c".repeat(64)}`, `operator-images.qualified.svc.:8084/qualified/other@sha256:${"c".repeat(64)}`, `operator-images.qualified.svc:08084/qualified/other@sha256:${"c".repeat(64)}`]) {
    assert.throws(() => nativeImageStoreRegistryArgs([pinned, app, image], store));
  }
  assert.throws(() => nativeImageStoreRegistryArgs([pinned], store));
  assert.throws(() => nativeImageStoreRegistryArgs([app], { ...store, endpoint: "http://169.254.169.254:8084" }));
});

test("workload image store binding rejects downgrade, another repository, another owner and mirror overrides", () => {
  assert.doesNotThrow(() => validateWorkload(declaration(), []));
  for (const mutate of [
    (x: any) => { x.metadata.name = "other"; }, (x: any) => { x.metadata.namespace = "other"; },
    (x: any) => { x.spec.containers[0].image = imageStoreImage(store).replace(":release", ":other"); },
    (x: any) => { x.spec.containers[0].image = pinned; }, (x: any) => { delete x.spec.containers[0].imageKeyResource; },
    (x: any) => { x.spec.containers.push({ ...x.spec.containers[0], name: "second", uid: 11001, gid: 11001 }); },
    (x: any) => { x.spec.registryMirrors = [{ prefix: new URL(store.endpoint).host, location: "other.invalid/elsewhere", insecure: true }]; },
    (x: any) => { x.spec.registryMirrors = [{ prefix: "OPERATOR-IMAGES.qualified.svc:8084/qualified/workload", location: "other.invalid/elsewhere", insecure: true }]; },
    (x: any) => { x.spec.registryMirrors = [{ prefix: "registry.example/library", location: imageStorePrefix(store) + "/sibling", insecure: true }]; },
  ]) { const x = declaration(); mutate(x); assert.throws(() => validateWorkload(x, [])); }
  const composed = declaration(); composed.spec.registryMirrors = [{ prefix: "registry.example/library", location: "mirror.example/example", insecure: false }];
  assert.doesNotThrow(() => validateWorkload(composed, []));
  const legacy = declaration(); delete legacy.spec.imageStore; legacy.spec.containers[0].image = "registry.example/app:release";
  assert.doesNotThrow(() => validateWorkload(legacy, []));
  const schema: any = workloadSpecSchema;
  assert.ok(!schema.required.includes("imageStore"));
  assert.deepEqual(schema.properties.imageStore.required, ["endpoint", "writeEndpoint", "repository"]);
  assert.ok(schema["x-kubernetes-validations"].some((x: any) => x.rule.includes(":release")));
});

const operator = (imageStore?: any) => {
  const chart = new Chart(new App(), "image-store");
  new ConfidentialOperator(chart, "operator", { name: "operator", namespace: "operators", image: pinned,
    watchNamespaces: ["qualified"], installCrds: false, ...(imageStore === undefined ? {} : { imageStore }) });
  return Testing.synth(chart);
};
const options = { claimName: "ciphertext-v1", repository: "qualified/workload", preparationPodSelector: { "confidential.nebula.dev/browser": "preparation" } };

test("ordinary operator owns the only store PVC and exposes separately restricted reader/writer ports", () => {
  const resources = operator(options), deploy = resources.find(x => x.kind === "Deployment")!;
  assert.equal(deploy.spec.replicas, 1); assert.deepEqual(deploy.spec.strategy, { type: "Recreate" });
  assert.equal(deploy.spec.template.spec.runtimeClassName, undefined);
  assert.deepEqual(deploy.spec.template.spec.securityContext, { fsGroup: 10001, fsGroupChangePolicy: "OnRootMismatch" });
  assert.equal(deploy.spec.template.spec.containers.length, 1);
  const container = deploy.spec.template.spec.containers[0];
  assert.deepEqual(container.volumeMounts.find((x: any) => x.name === "image-store"), { name: "image-store", mountPath: "/var/lib/nebula-images" });
  assert.deepEqual(deploy.spec.template.spec.volumes.find((x: any) => x.name === "image-store"), { name: "image-store", persistentVolumeClaim: { claimName: "ciphertext-v1" } });
  assert.deepEqual(container.env.filter((x: any) => x.name.startsWith("IMAGE_STORE_")), [
    { name: "IMAGE_STORE_DIRECTORY", value: "/var/lib/nebula-images" }, { name: "IMAGE_STORE_REPOSITORY", value: "qualified/workload" },
    { name: "IMAGE_STORE_MAX_BYTES", value: String(8 * 1024 ** 3) },
  ]);
  assert.ok(!resources.some(x => ["Secret", "PersistentVolume", "PersistentVolumeClaim", "Pod"].includes(x.kind)), "The module consumes an existing PVC and does not create another guest or key resource");
  const service = resources.find(x => x.kind === "Service")!;
  assert.deepEqual(service.spec.ports, [{ name: "read", port: 8084, targetPort: "image-read" }, { name: "write", port: 8085, targetPort: "image-write" }]);
  const policy = resources.find(x => x.kind === "NetworkPolicy")!.spec;
  const read = policy.ingress.find((x: any) => x.ports.some((p: any) => p.port === 8084));
  const write = policy.ingress.find((x: any) => x.ports.some((p: any) => p.port === 8085));
  const prep = { namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "qualified" } }, podSelector: { matchLabels: options.preparationPodSelector } };
  assert.deepEqual(write.from, [prep]); assert.ok(read.from.some((x: any) => JSON.stringify(x) === JSON.stringify(prep)));
  assert.ok(read.from.some((x: any) => x.podSelector.matchLabels["confidential.nebula.dev/workload"] === "workload"));
  const closed = operator({ claimName: "ciphertext-v1", repository: "qualified/workload" }).find(x => x.kind === "NetworkPolicy")!;
  assert.ok(!closed.spec.ingress.some((x: any) => x.ports.some((p: any) => p.port === 8085)), "No selector means deny writes, never wildcard ingress");
});

test("omitted store configuration retains the original operator resources and rejects unsafe opt-ins", () => {
  const resources = operator(), deploy = resources.find(x => x.kind === "Deployment")!;
  assert.deepEqual(operator(undefined), resources);
  assert.ok(!resources.some(x => ["Service", "NetworkPolicy"].includes(x.kind)));
  assert.deepEqual(deploy.spec.template.spec.volumes, [{ name: "tmp", emptyDir: { sizeLimit: "2Gi" } }]);
  assert.equal(deploy.spec.template.spec.securityContext, undefined);
  assert.deepEqual(deploy.spec.template.spec.containers[0].volumeMounts, [{ name: "tmp", mountPath: "/tmp" }]);
  assert.ok(!deploy.spec.template.spec.containers[0].env.some((x: any) => x.name.startsWith("IMAGE_STORE_")));
  for (const changed of [{ ...options, maxBytes: 0 }, { ...options, maxBytes: 64 * 1024 ** 3 + 1 }, { ...options, repository: "other/workload" },
    { ...options, claimName: "../disk" }, { ...options, credentials: "synthetic" }, { ...options, preparationPodSelector: {} },
    { ...options, preparationPodSelector: { app: "preparation" } }, { ...options, preparationPodSelector: { "confidential.nebula.dev/browser": "bad value" } }]) {
    assert.throws(() => operator(changed));
  }
});

test("operator omission retains qualified 350ad29 resources byte for byte", () => {
  const configs = [{ namespace: "operators", watchNamespaces: ["qualified"], image: pinned, installCrds: false },
    { name: "custom", namespace: "operators", watchNamespaces: ["first", "second"], image: pinned, installCrds: false,
      accessLinkSecrets: [{ namespace: "first", name: "bootstrap-link" }] }];
  const resources = configs.map(config => { const chart = new Chart(new App(), "parity"); new ConfidentialOperator(chart, "operator", config); return Testing.synth(chart); });
  // Captured by executing the original construct from qualified source350ad29.
  // Shared CRDs are excluded because their optional API extension is intentional.
  assert.equal(createHash("sha256").update(JSON.stringify(resources)).digest("hex"), "66ba1f4f42b14b2aa2fbef4a225b1b844e50e16c94bc5ac81c52473e330ae99f");
});

test("Skopeo HTTP is scoped to the exact store repository with an isolated empty authfile", () => {
  const directory = mkdtempSync(join(tmpdir(), "nebula-store-skopeo-test-")), calls = join(directory, "calls.jsonl");
  const raw = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/app/server"], Cmd: [], Env: ["PUBLIC_VALUE=true"] } }));
  const digest = (x: Buffer) => `sha256:${createHash("sha256").update(x).digest("hex")}`;
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: digest(raw), size: raw.length }, layers: [{
    mediaType: "application/vnd.oci.image.layer.v1.tar+encrypted", annotations: { "org.opencontainers.image.enc.keys.provider.attestation-agent": Buffer.from(JSON.stringify({ kid: "kbs:///default/image/app" })).toString("base64") },
  }] }));
  writeFileSync(join(directory, "config"), raw); writeFileSync(join(directory, "manifest"), manifest);
  const script = `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const reg=args.indexOf('--registries-conf'),auth=args.indexOf('--authfile');fs.appendFileSync(process.env.STORE_TEST_CALLS,JSON.stringify({args,registry:reg<0?null:fs.readFileSync(args[reg+1],'utf8'),auth:auth<0?null:fs.readFileSync(args[auth+1],'utf8')})+'\\n');if(process.env.STORE_TEST_FAIL){process.stderr.write('synthetic-private-tool-error');process.exit(1)}process.stdout.write(fs.readFileSync(process.env.STORE_TEST_DIRECTORY+'/'+(args.includes('--config')?'config':'manifest')));\n`;
  writeFileSync(join(directory, "skopeo"), script, { mode: 0o700 });
  const saved = { PATH: process.env.PATH, STORE_TEST_CALLS: process.env.STORE_TEST_CALLS, STORE_TEST_DIRECTORY: process.env.STORE_TEST_DIRECTORY, STORE_TEST_FAIL: process.env.STORE_TEST_FAIL };
  Object.assign(process.env, { PATH: `${directory}:${process.env.PATH}`, STORE_TEST_CALLS: calls, STORE_TEST_DIRECTORY: directory });
  try {
    assert.equal(resolvePublishedImage(imageStoreImage(store), key, undefined, store), `${imageStorePrefix(store)}@${digest(manifest)}`);
    const processConfig = imageProcess(`${imageStorePrefix(store)}@${digest(manifest)}`, undefined, true, store);
    assert.deepEqual(processConfig.command, ["/app/server"]);
    assert.deepEqual({ ...processConfig.env }, { PUBLIC_VALUE: "true" });
    let recorded = readFileSync(calls, "utf8").trim().split("\n").map(x => JSON.parse(x));
    assert.equal(recorded.length, 3);
    for (const call of recorded) {
      assert.deepEqual((parse(call.registry) as any).registry.map((value: any) => ({ ...value })), [imageStoreRegistry(store)]);
      assert.deepEqual(JSON.parse(call.auth), { auths: {} });
      assert.ok(!call.args.some((x: string) => x.includes("tls-verify")));
      assert.equal(existsSync(call.args[call.args.indexOf("--registries-conf") + 1]), false, "Public temporary scope is removed after inspection");
    }
    assert.throws(() => resolvePublishedImage("other.qualified.svc:8084/qualified/workload:release", key, digest(manifest), store));
    assert.throws(() => imageProcess(`elsewhere.invalid/app@${digest(manifest)}`, { manifest, config: raw }, true, store));
    assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 3, "Invalid target never reaches Skopeo, including digest fast paths");
    resolvePublishedImage("registry.example/app:release", key);
    recorded = readFileSync(calls, "utf8").trim().split("\n").map(x => JSON.parse(x));
    assert.deepEqual(recorded.at(-1).args, ["--insecure-policy", "inspect", "--raw", "docker://registry.example/app:release"]);
    process.env.STORE_TEST_FAIL = "1";
    assert.throws(() => resolvePublishedImage(imageStoreImage(store), key, undefined, store), error => error instanceof ConfidentialPublicationPending && !error.message.includes("synthetic-private"));
  } finally {
    for (const [name, value] of Object.entries(saved)) value === undefined ? delete process.env[name] : process.env[name] = value;
    rmSync(directory, { recursive: true, force: true });
  }
});
