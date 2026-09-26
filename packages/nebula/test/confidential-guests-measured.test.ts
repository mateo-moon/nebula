import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { INIT_DATA_ANNOTATION, canonicalJson, initDataSha256, measuredGuest, type MeasuredArtifact } from "../src/modules/k8s/confidential-guests";

const sha = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const POLICY = 'version = "0.1.0"\nalgorithm = "sha384"\n[data]\n"policy.rego" = "package agent_policy\\ndefault AllowRequestsFailingPolicy := false\\n"\n';

function pod() {
  return {
    apiVersion: "v1", kind: "Pod",
    metadata: { name: "guest-a", namespace: "guests", labels: { app: "guests" }, annotations: { "guests.example.com/profile": "a" } },
    spec: { runtimeClassName: "kata-qemu-snp", restartPolicy: "Never", containers: [{ name: "main", image: `ghcr.io/example/app@sha256:${"a".repeat(64)}` }] },
  };
}

function artifact(template = pod(), text = POLICY): MeasuredArtifact {
  return { canonicalPodSha256: sha(canonicalJson(template)), ccInitData: gzipSync(Buffer.from(text)).toString("base64"), initDataSha256: sha(text) };
}

test("the init-data annotation is the upstream Kata one", () => {
  assert.equal(INIT_DATA_ANNOTATION, "io.katacontainers.config.hypervisor.cc_init_data");
});

test("initDataSha256 is the SHA-256 of the decompressed init-data document (HOST_DATA)", () => {
  assert.equal(initDataSha256(artifact().ccInitData), sha(POLICY));
});

test("measuredGuest adds the init-data annotation to an unchanged template and leaves its input alone", () => {
  const template = pod(), before = structuredClone(template), measured = artifact();
  const guest = measuredGuest(template, measured);
  assert.deepEqual(template, before, "the input template is not mutated");
  assert.deepEqual(guest, { ...before, metadata: { ...before.metadata, annotations: { ...before.metadata.annotations, [INIT_DATA_ANNOTATION]: measured.ccInitData } } });
  const bare = { ...pod(), metadata: { name: "guest-a", namespace: "guests" } };
  assert.equal(measuredGuest(bare, artifact(bare)).metadata.annotations?.[INIT_DATA_ANNOTATION], measured.ccInitData, "a template without annotations gains one");
});

test("measuredGuest refuses a template or init-data that no longer matches the generated policy", () => {
  const measured = artifact();
  const changed = pod();
  changed.spec.containers[0].image = `ghcr.io/example/app@sha256:${"b".repeat(64)}`;
  const refusals: [string, () => unknown, RegExp][] = [
    ["changed template", () => measuredGuest(changed, measured), /template changed/],
    ["wrong HOST_DATA", () => measuredGuest(pod(), { ...measured, initDataSha256: sha("other") }), /init-data hash/],
    ["non-canonical base64 (line break)", () => measuredGuest(pod(), { ...measured, ccInitData: `${measured.ccInitData.slice(0, 8)}\n${measured.ccInitData.slice(8)}` }), /canonical base64/],
    ["non-canonical base64 (extra padding)", () => measuredGuest(pod(), { ...measured, ccInitData: `${measured.ccInitData}====` }), /canonical base64/],
    ["not gzip", () => measuredGuest(pod(), { ...measured, ccInitData: Buffer.from(POLICY).toString("base64") }), /gzip/],
    ["over 1 MiB decompressed", () => measuredGuest(pod(), artifact(pod(), "x".repeat(1024 * 1024 + 1))), /gzip/],
    ["uppercase digest", () => measuredGuest(pod(), { ...measured, canonicalPodSha256: measured.canonicalPodSha256.toUpperCase() }), /sha256/],
    ["missing field", () => measuredGuest(pod(), { canonicalPodSha256: measured.canonicalPodSha256, ccInitData: measured.ccInitData } as MeasuredArtifact), /initDataSha256/],
  ];
  for (const [label, run, error] of refusals) assert.throws(run, error, label);
});
