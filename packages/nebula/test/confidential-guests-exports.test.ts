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
// The guest lifecycle constructs and helpers.
const LIFECYCLE_EXPORTS = [
  "ConfidentialGuestStack",
  "GuestAdmissionFence",
  "GuestLifecycle",
  "GuestLogRetention",
  "GuestServices",
  "INIT_DATA_ANNOTATION",
  "LIFECYCLE_CLAIM_PLACEHOLDER",
  "LIFECYCLE_CONTROLLER_COMMAND",
  "LIFECYCLE_DATA_VOLUME",
  "LIFECYCLE_SPEC_VERSIONS",
  "LOG_RETENTION_COMMAND",
  "SignedReleases",
  "guestClaimPrefix",
  "guestLifecycleSpec",
  "initDataSha256",
  "lifecycleIgnoreDifferences",
  "lifecycleLabelKey",
  "lifecycleNames",
  "measuredGuest",
];
RUNTIME_EXPORTS.push(...LIFECYCLE_EXPORTS);
RUNTIME_EXPORTS.sort();

test("the package root re-exports the confidential-guests module unchanged", () => {
  assert.deepEqual(Object.keys(cg).sort(), RUNTIME_EXPORTS);
  const exported = root as Record<string, unknown>;
  for (const name of RUNTIME_EXPORTS) {
    assert.equal(exported[name], (cg as Record<string, unknown>)[name], name);
  }
});
