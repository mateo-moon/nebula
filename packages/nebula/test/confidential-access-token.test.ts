import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { Testing } from "cdk8s";
import { test } from "node:test";
import { ConfidentialWorkload, confidentialAccessTokenHash, validateWorkload,
  type ConfidentialWorkloadResource } from "../src/modules/k8s/confidential-workloads";
import { imageCommand } from "../src/modules/k8s/confidential-workloads/published-image";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";

const image = `example.invalid/app@sha256:${"a".repeat(64)}`;
function spec(): ConfidentialWorkloadResource["spec"] {
  return { profile: "generic", guest: { measurement: "a".repeat(96), chipId: "b".repeat(128),
    minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } },
    nodeSelector: { "kubernetes.io/hostname": "snp" },
    network: { ipv4AddressPattern: "^[0-9.]+$", ipv6AddressPattern: "^[a-f0-9:]+$" },
    trustee: { chart: TRUSTEE_CHART, kbsImage: image, tngImage: image, gatewayImage: image }, storageImage: image,
    containers: [{ name: "app", image, commandFromImage: true, uid: 11000, gid: 11000 }],
    resources: [["default", "image", "app"]] };
}
test("deployment-time token is committed before BaseConstruct and never reaches public synthesis", () => {
  const accessToken = randomBytes(32).toString("hex"), chart = Testing.chart();
  const workload = new ConfidentialWorkload(chart, "guest", { name: "guest", namespace: "test", accessToken, spec: spec() });
  assert.equal(workload.declaration.spec.ownerClaimSha256, confidentialAccessTokenHash(accessToken));
  assert.ok(!JSON.stringify(Testing.synth(chart)).includes(accessToken));
  assert.ok(!JSON.stringify((workload as any).config).includes(accessToken));
  assert.throws(() => new ConfidentialWorkload(Testing.chart(), "other", { name: "guest", namespace: "test", accessToken,
    spec: { ...spec(), ownerClaimSha256: "f".repeat(64) } }), /differs/);
  assert.throws(() => confidentialAccessTokenHash("short-token"), /64 hexadecimal/);
  assert.throws(() => confidentialAccessTokenHash("ref+awssecrets://must-not-resolve"), /64 hexadecimal/);
});

test("image commands are hash-bound to the measured manifest, never trusted registry strings", () => {
  const config = Buffer.from(JSON.stringify({ architecture: "amd64", os: "linux", config: { Entrypoint: ["/app/server"], Cmd: ["--port", "9080"] } }));
  const manifest = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${createHash("sha256").update(config).digest("hex")}`, size: config.length } }));
  const reference = `example.invalid/app@sha256:${createHash("sha256").update(manifest).digest("hex")}`;
  assert.deepEqual(imageCommand(reference, { manifest, config }), ["/app/server", "--port", "9080"]);
  assert.throws(() => imageCommand(reference, { manifest, config: Buffer.from("tampered") }), /differs/);
  assert.throws(() => imageCommand(image, { manifest, config }), /manifest differs/);
  const workload: ConfidentialWorkloadResource = { apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload",
    metadata: { name: "guest", namespace: "test" }, spec: { ...spec(), ownerClaimSha256: "b".repeat(64) } };
  assert.doesNotThrow(() => validateWorkload(workload, []));
  workload.spec.containers[0].command = ["/bin/sh"];
  assert.throws(() => validateWorkload(workload, []), /explicit command or commandFromImage/);
});

test("generated access links remain deterministic declarations and cannot mix owner modes", () => {
  const config = { ...spec(), accessLink: { url: "https://stack.example/", secretName: "workload-access", ownerPort: 8443 } };
  const first = new ConfidentialWorkload(Testing.chart(), "guest", { name: "guest", namespace: "test", spec: config });
  const second = new ConfidentialWorkload(Testing.chart(), "guest", { name: "guest", namespace: "test", spec: config });
  assert.deepEqual(first.declaration, second.declaration);
  assert.equal(first.declaration.spec.ownerClaimSha256, undefined, "Random credentials belong to runtime reconciliation, not synthesis");
  assert.throws(() => validateWorkload({ ...first.declaration, spec: { ...config, ownerClaimSha256: "f".repeat(64) } }, []), /generated access link/);
  assert.throws(() => validateWorkload({ ...first.declaration, spec: { ...config, accessLink: { ...config.accessLink, url: "http://stack.example/" } } }, []), /HTTPS/);
  assert.throws(() => validateWorkload({ ...first.declaration, spec: { ...config, accessLink: { ...config.accessLink, url: "https://stack.example/#secret" } } }, []), /HTTPS/);
});
