import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { INIT_DATA_ANNOTATION, initDataSha256 } from "../src/modules/k8s/confidential-guests/measured";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";
import { renderConfidentialWorkload } from "../src/modules/k8s/confidential-workloads/render";
import type { ConfidentialStorageResource, ConfidentialWorkloadResource } from "../src/modules/k8s/confidential-workloads/types";

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
  assert.equal(pod.spec!.restartPolicy, "Always", "Application startup failures must retry within the existing Pod");
  assert.equal(first.identity.initDataSha256, initDataSha256(pod.metadata!.annotations![INIT_DATA_ANNOTATION]));
  assert.deepEqual(pod.spec!.containers!.map(c => c.name), ["app"]);
  assert.ok(pod.spec!.initContainers!.some(c => c.name === "nebula-guard"));
  assert.ok(pod.spec!.initContainers!.some(c => c.name === "nebula-owner"));
  assert.ok(pod.spec!.initContainers!.some(c => c.name === "nebula-resource-broker") === false);
  for (const name of ["kbs", "nebula-owner", "nebula-tng"]) {
    assert.equal(pod.spec!.initContainers!.find(container => container.name === name)!.restartPolicy, "Always");
  }
  const legacyKbs = pod.spec!.initContainers!.find(container => container.name === "kbs")!;
  assert.match(Buffer.from(legacyKbs.args!.join(""), "base64").toString(), /kbs\.toml >\/dev\/null 2>&1/);
  assert.ok(!pod.spec!.initContainers!.some(container => container.volumeMounts?.some(mount => mount.mountPath === "/run/kbs-diagnostics")));
  assert.ok(!pod.spec!.volumes!.some(volume => volume.name === "public-kds"));
  for (const name of ["nebula-guard", "nebula-await-owner", "nebula-install-storage"]) {
    assert.equal(pod.spec!.initContainers!.find(container => container.name === name)!.restartPolicy, undefined,
      `${name} must remain a finite init stage`);
  }
  assert.deepEqual(pod.spec!.containers![0].command, ["/run/nebula-runtime/nebula-confidential-storage"]);
  assert.ok(!pod.spec!.volumes!.some(v => "secret" in v || "hostPath" in v));
  const timeoutAnnotation = "io.katacontainers.config.runtime.create_container_timeout";
  assert.equal(pod.metadata!.annotations![timeoutAnnotation], undefined);
  declaration.spec.runtime = { createContainerTimeoutSeconds: 600 };
  const larger = renderConfidentialWorkload(declaration, [], options);
  assert.equal(larger.pod.metadata!.annotations![timeoutAnnotation], "600");
  assert.deepEqual(larger.pod.spec, first.pod.spec, "Changing the native timeout must not alter container privileges or layout");
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

test("one measured agent replaces the guest daemons and owns isolated multi-volume modules", {
  skip: !native, timeout: 600_000,
}, () => {
  const declaration = fixture();
  declaration.spec.agentImage = kbs;
  delete declaration.spec.storageImage;
  delete declaration.spec.trustee.gatewayImage;
  declaration.spec.containers[0].imageKeyResource = ["default", "image", "app"];
  declaration.spec.containers[0].applicationResources = [["default", "config", "app"]];
  declaration.spec.containers[0].mounts = [{ storage: "data", path: "/data" }, { storage: "scratch", path: "/scratch" }];
  declaration.spec.storage = [{ name: "data", resource: "data" }, { name: "scratch", resource: "scratch" }];
  declaration.spec.resources = [["default", "image", "app"], ["default", "volume", "data"],
    ["default", "volume", "scratch"], ["default", "config", "app"]];
  const storages: ConfidentialStorageResource[] = ["data", "scratch"].map(name => ({
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage",
    metadata: { name, namespace: declaration.metadata.namespace }, spec: { type: "EncryptedBlock", claimName: `${name}-v1`,
      sizeBytes: 67108864, keyResource: ["default", "volume", name], initialization: "Never", retention: "Retain" },
  }));
  const options = { genpolicy: { executable: native, cacheDirectory: process.env.TRUSTEE_GENPOLICY_CACHE } };
  const first = renderConfidentialWorkload(declaration, storages, options);
  assert.deepEqual(renderConfidentialWorkload(declaration, storages, options), first);
  const components = first.pod.spec!.initContainers!;
  assert.equal(first.pod.spec!.restartPolicy, "Always");
  assert.deepEqual(components.map(container => container.name), ["nebula-agent", "kbs", "nebula-tng", "nebula-await-owner"]);
  assert.ok(components.slice(0, 3).every(container => container.restartPolicy === "Always"),
    "Persistent trusted helpers must remain restartable sidecars");
  assert.equal(components[2].startupProbe, undefined, "Waiting for an owner must not kill the attestation sidecar");
  assert.equal(components[0].startupProbe, undefined, "The agent must not block KBS and TNG from starting");
  const gate = components[3];
  assert.equal(gate.restartPolicy, undefined, "The owner gate is a finite init stage, not another daemon");
  assert.deepEqual(gate.command, ["node", "--disable-sigusr1", "/app/dist/main.mjs"]);
  assert.deepEqual(JSON.parse(gate.args![0]), { version: 1, role: "owner-gate" });
  assert.equal(gate.securityContext!.runAsUser, 10001);
  assert.deepEqual(gate.securityContext!.capabilities, { drop: ["ALL"] });
  assert.deepEqual(gate.volumeMounts, [{ name: "owner-ready", mountPath: "/run/nebula-owner-ready", readOnly: true }]);
  const agent = components[0], config = JSON.parse(agent.args![0]);
  const trustee = components[1];
  assert.match(Buffer.from(trustee.args!.join(""), "base64").toString(), /kbs\.toml >\/tmp\/kbs\.log 2>&1/);
  assert.equal(trustee.env!.find(entry => entry.name === "RUST_LOG")!.value, "warn");
  assert.deepEqual(agent.volumeMounts!.find(mount => mount.mountPath === "/run/kbs-diagnostics"),
    { name: "kbs-tmp", mountPath: "/run/kbs-diagnostics", readOnly: true });
  assert.ok(!first.pod.spec!.containers!.some(container => container.volumeMounts?.some(mount => mount.name === "kbs-tmp")),
    "Application containers must never receive the private KBS log volume");
  assert.deepEqual(agent.volumeMounts!.find(mount => mount.name === "public-kds"),
    { name: "public-kds", mountPath: "/run/nebula-public-kds" });
  assert.deepEqual(trustee.volumeMounts!.find(mount => mount.name === "public-kds"),
    { name: "public-kds", mountPath: "/run/trustee/public-kds", readOnly: true });
  assert.deepEqual(first.pod.spec!.volumes!.find(volume => volume.name === "public-kds"),
    { name: "public-kds", emptyDir: { medium: "Memory", sizeLimit: "1Mi" } });
  assert.ok(!first.pod.spec!.containers!.some(container => container.volumeMounts?.some(mount => mount.name === "public-kds")));
  assert.equal(config.role, "workload");
  assert.deepEqual(config.storage.volumes.map((volume: any) => volume.name), ["data", "scratch"]);
  assert.deepEqual(agent.volumeDevices!.map(device => device.devicePath), ["/dev/nebula-volumes/data", "/dev/nebula-volumes/scratch"]);
  assert.deepEqual(config.storage.clients[0].resources, ["default/config/app"]);
  assert.deepEqual(config.storage.deniedResources, ["default/image/app", "default/volume/data", "default/volume/scratch"]);
  assert.deepEqual(agent.command, ["node", "--disable-sigusr1", "/app/dist/main.mjs"]);
  assert.equal(agent.terminationMessagePolicy, "FallbackToLogsOnError");
  assert.deepEqual(components.slice(1, 3).map(container => container.command![0]), ["/bin/sh", "/bin/sh"],
    "KBS and TNG output must remain private");
  assert.equal(agent.securityContext!.allowPrivilegeEscalation, false);
  assert.equal(agent.securityContext!.readOnlyRootFilesystem, true);
  assert.ok(!first.pod.spec!.volumes!.some(volume => "secret" in volume || "hostPath" in volume));
  assert.deepEqual(first.pod.spec!.containers![0].command, ["/run/nebula-runtime/nebula-confidential-storage"]);
});
