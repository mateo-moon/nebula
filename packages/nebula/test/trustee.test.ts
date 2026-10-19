import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart } from "cdk8s";
import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { Trustee } from "../src/modules/k8s/trustee";
import { trusteeSettings } from "../src/modules/k8s/trustee/settings";
import { trusteeConfig } from "./support/trustee";

test("explicit and named P-256 parameters produce the same measured owner key", () => {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1", paramEncoding: "explicit" });
  const named = createPublicKey({ key: publicKey.export({ format: "jwk" }), format: "jwk" });
  const explicitPem = publicKey.export({ format: "pem", type: "spki" }).toString();
  const namedPem = named.export({ format: "pem", type: "spki" }).toString();
  assert.notEqual(explicitPem, namedPem, "fixture must exercise explicit curve parameters");
  const config = trusteeConfig();
  assert.deepEqual(trusteeSettings({ ...config, ownerPublicKeyPem: explicitPem }),
    trusteeSettings({ ...config, ownerPublicKeyPem: namedPem }));
});

test("private keys, mutable images, unsafe namespaces and missing identities fail before Helm", () => {
  const config = trusteeConfig();
  const key = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  for (const change of [
    { ownerPublicKeyPem: key }, { ownerPublicKeyPem: config.ownerPublicKeyPem + "extra" },
    { kbsImage: "example.test/kbs:latest" }, { tngImage: "example.test/tng:latest" },
    { namespace: "default" }, { nodeSelector: {} }, { clients: [] },
    { guest: { ...config.guest, measurement: "" } },
    { network: { ...config.network, ipv4AddressPattern: ".*" } },
  ]) assert.throws(() => trusteeSettings({ ...config, ...change }));
});

test("host secret references are rejected before BaseConstruct resolution", () => {
  const key = "NEBULA_TRUSTEE_PUBLIC_KEY_TEST";
  const previous = process.env[key];
  process.env[key] = trusteeConfig().ownerPublicKeyPem;
  try {
    const chart = new Chart(new App(), "invalid");
    assert.throws(() => new Trustee(chart, "trustee", { ...trusteeConfig(), ownerPublicKeyPem: `ref+env://${key}` }), /host-side ref\+ resolution is forbidden/);
    assert.deepEqual(chart.toJson(), []);
  } finally {
    if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
  }
});
