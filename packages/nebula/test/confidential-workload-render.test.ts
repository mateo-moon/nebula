import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { INIT_DATA_ANNOTATION, initDataSha256 } from "../src/modules/k8s/confidential-guests/measured";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";
import { renderConfidentialWorkload } from "../src/modules/k8s/confidential-workloads/render";
import type { ConfidentialWorkloadResource } from "../src/modules/k8s/confidential-workloads/types";

const kbs = "ghcr.io/confidential-containers/staged-images/kbs@sha256:ebbb0b34c748ce59a6afcaf05c1cc6f6c66ee6aa2c70222fd160700a296edd68";
const tng = "ghcr.io/inclavare-containers/tng@sha256:233528659b406ffc67e6b2bd542f58825a3e85c7a25559a5adc74a16e582d416";
const native = process.env.TRUSTEE_GENPOLICY;

function fixture(): ConfidentialWorkloadResource {
  const publicKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({
    format: "pem", type: "spki",
  }).toString();
  return { apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialWorkload",
    metadata: { name: "qualification", namespace: "qualified" }, spec: {
      profile: "qualification", ownerPublicKeyPem: publicKey,
      guest: { measurement: "a".repeat(96), chipId: "b".repeat(128),
        minimumReportedTcb: { bootloader: 3, tee: 1, snp: 12, microcode: 72 } },
      nodeSelector: { "kubernetes.io/hostname": "qualification-node" },
      network: { ipv4AddressPattern: "^192[.]0[.]2[.][0-9]+$", ipv6AddressPattern: "^2001:db8::[0-9a-f:]+$" },
      trustee: { chart: TRUSTEE_CHART, kbsImage: kbs, tngImage: tng, gatewayImage: kbs },
      storageImage: kbs,
      containers: [{ name: "app", image: kbs, command: ["/bin/true"], uid: 11000, gid: 11000 }],
      resources: [["default", "image", "app"]],
    } };
}

test("native renderer binds the final Pod and keeps repeated measurements stable", {
  skip: !native, timeout: 600_000,
}, () => {
  const declaration = fixture();
  const options = { genpolicy: { executable: native, cacheDirectory: process.env.TRUSTEE_GENPOLICY_CACHE } };
  const first = renderConfidentialWorkload(declaration, [], options);
  const second = renderConfidentialWorkload(declaration, [], options);
  assert.deepEqual(second, first);
  const pod = first.pod;
  assert.equal(first.identity.initDataSha256, initDataSha256(pod.metadata!.annotations![INIT_DATA_ANNOTATION]));
  assert.deepEqual(pod.spec!.containers!.map(c => c.name), ["app"]);
  assert.ok(pod.spec!.initContainers!.some(c => c.name === "nebula-guard"));
  assert.ok(pod.spec!.initContainers!.some(c => c.name === "nebula-owner"));
  assert.ok(pod.spec!.initContainers!.some(c => c.name === "nebula-resource-broker") === false);
  assert.deepEqual(pod.spec!.containers![0].command, ["/run/nebula-runtime/nebula-confidential-storage"]);
  assert.ok(!pod.spec!.volumes!.some(v => "secret" in v || "hostPath" in v));
  const reserved = structuredClone(declaration);
  reserved.spec.containers[0].name = "nebula-bypass";
  assert.throws(() => renderConfidentialWorkload(reserved, [], options), /non-reserved/);
});

test("native policy binds a claimed guest to the published image digest", {
  skip: !native, timeout: 600_000,
}, () => {
  const declaration = fixture();
  delete declaration.spec.ownerPublicKeyPem;
  declaration.spec.ownerClaimSha256 = "a".repeat(64);
  const tag = "ghcr.io/confidential-containers/staged-images/kbs:owner-release";
  declaration.spec.containers[0].image = tag;
  declaration.spec.containers[0].imageKeyResource = ["default", "image", "app"];
  const result = renderConfidentialWorkload(declaration, [], {
    genpolicy: { executable: native, cacheDirectory: process.env.TRUSTEE_GENPOLICY_CACHE },
    publishedImageDigests: { [tag]: kbs.slice(kbs.indexOf("@") + 1) },
  });
  assert.equal(result.pod.spec!.containers![0].image, kbs);
  const gateway = result.pod.spec!.initContainers!.find(container => container.name === "nebula-owner")!;
  assert.match(gateway.args!.join(" "), /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
  assert.match(result.identity.initDataSha256, /^[a-f0-9]{64}$/);
});
