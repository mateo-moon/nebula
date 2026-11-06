import assert from "node:assert/strict";
import { test } from "node:test";
import { encryptedManifestDigest, resolvePublishedImage } from "../src/modules/k8s/confidential-workloads/published-image";
import { validateWorkload } from "../src/modules/k8s/confidential-workloads/validation";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";
import type { ConfidentialWorkloadResource } from "../src/modules/k8s/confidential-workloads/types";

const resource = ["default", "image", "app"] as const;
const key = "kbs:///default/image/app";
const manifest = (kid = key, encrypted = true) => Buffer.from(JSON.stringify({ schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [{
    mediaType: `application/vnd.oci.image.layer.v1.tar+gzip${encrypted ? "+encrypted" : ""}`,
    annotations: { "org.opencontainers.image.enc.keys.provider.attestation-agent":
      Buffer.from(JSON.stringify({ kid })).toString("base64") },
  }],
}));

test("only a fully encrypted manifest for the declared key becomes a measured digest", () => {
  const digest = encryptedManifestDigest(manifest(), resource);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(resolvePublishedImage("ghcr.io/example/app:release", resource, digest),
    `ghcr.io/example/app@${digest}`);
  assert.throws(() => encryptedManifestDigest(manifest("kbs:///default/volume/data"), resource), /another key/);
  assert.throws(() => encryptedManifestDigest(manifest(key, false), resource), /encrypted/);
  assert.throws(() => resolvePublishedImage("ghcr.io/example/app:release", resource, "sha256:bad"), /digest/);
});

function workload(): ConfidentialWorkloadResource {
  const pinned = (n: string) => `ghcr.io/example/helper@sha256:${n.repeat(64)}`;
  return { apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload",
    metadata: { namespace: "private", name: "workload" }, spec: {
      profile: "workload", ownerClaimSha256: "a".repeat(64),
      guest: { measurement: "b".repeat(96), chipId: "c".repeat(128),
        minimumReportedTcb: { bootloader: 10, tee: 0, snp: 24, microcode: 88 } },
      nodeSelector: { "kubernetes.io/hostname": "snp-node" },
      network: { ipv4AddressPattern: "^10[.][0-9.]+$", ipv6AddressPattern: "^fd00::[0-9a-f:]+$" },
      trustee: { chart: TRUSTEE_CHART, kbsImage: pinned("1"), tngImage: pinned("2"), gatewayImage: pinned("3") },
      storageImage: pinned("4"), containers: [{ name: "app", image: "ghcr.io/example/app:release",
        imageKeyResource: resource, command: ["/app/server"], uid: 11000, gid: 11000 }],
      resources: [resource],
    } };
}

test("a publication tag requires an admitted image key and cannot expose it to application code", () => {
  const valid = workload();
  assert.doesNotThrow(() => validateWorkload(valid, []));
  const missing = structuredClone(valid);
  delete missing.spec.containers[0].imageKeyResource;
  assert.throws(() => validateWorkload(missing, []), /publication tag/);
  const delegated = structuredClone(valid);
  delegated.spec.containers[0].applicationResources = [resource];
  assert.throws(() => validateWorkload(delegated, []), /cannot be a volume key or image key/);
});
