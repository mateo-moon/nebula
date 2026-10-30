import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { confidentialCrds } from "nebula-cdk8s/confidential-workloads";
import { renderRequest } from "../src/render";

test("renderer validates storage and rejects unknown operations", () => {
  assert.deepEqual(renderRequest({ operation: "validate-storage", storage: {
    apiVersion: "confidential.nebula.dev/v1alpha1", kind: "ConfidentialStorage",
    metadata: { name: "memory", namespace: "qualified" }, spec: { type: "Memory", sizeLimit: "32Mi" },
  } }), {});
  assert.throws(() => renderRequest({ operation: "execute", command: "untrusted" }));
  assert.throws(() => renderRequest({ operation: "validate-storage", storage: { spec: { type: "EncryptedBlock" } } }));
});
test("standalone CRDs preserve the exact shared structural schemas and CEL rules", () => {
  for (const crd of confidentialCrds()) {
    assert.deepEqual(JSON.parse(readFileSync(`config/crd/bases/${crd.metadata.name}.json`, "utf8")), crd);
  }
});
