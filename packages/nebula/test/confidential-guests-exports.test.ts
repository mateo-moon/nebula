import assert from "node:assert/strict";
import test from "node:test";
import * as root from "../src";
import * as cg from "../src/modules/k8s/confidential-guests";

const RUNTIME_EXPORTS = [
  "AttestedPullBroker",
  "NEUTRAL_WIRE",
  "NriKeyInjector",
  "SealedDisks",
  "WIRE_PROFILE_ENV",
  "canonicalJson",
  "confidentialGuestAssetUrl",
  "defaultProvisionTemplate",
  "digestImage",
  "isDigestImage",
  "provisionScript",
  "pullBrokerPolicy",
  "readConfidentialGuestAsset",
  "sealedDisksPlan",
  "sha256Hex",
  "validateDiskTable",
  "wireProfileEnv",
];

test("the package root re-exports the confidential-guests module unchanged", () => {
  assert.deepEqual(Object.keys(cg).sort(), RUNTIME_EXPORTS);
  const exported = root as Record<string, unknown>;
  for (const name of RUNTIME_EXPORTS) {
    assert.equal(exported[name], (cg as Record<string, unknown>)[name], name);
  }
});
