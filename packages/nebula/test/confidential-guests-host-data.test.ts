// HOST_DATA of an init-data annotation, against vectors shared byte for byte
// with a lifecycle controller's host-side reader
// (confidential-guests-host-data/). Both accept exactly the `accept` values,
// with their HOST_DATA, and refuse every `refuse` value.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initDataSha256 } from "../src/modules/k8s/confidential-guests";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "confidential-guests-host-data");
const VECTORS = "host-data-vectors.json";
// A vector changes only together with this pin and the controller's copy, in reviewed changes.
const MANIFEST_SHA256 = "33fad4a6bcabc5b10a242fe28d5b8aa490a89ba1d247d93882015d7aa7f95734";
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

interface Vectors {
  readonly limit: number;
  readonly accept: readonly { readonly name: string; readonly ccInitData: string; readonly hostData: string }[];
  readonly refuse: readonly { readonly name: string; readonly ccInitData: string }[];
}
const vectors = (): Vectors => JSON.parse(readFileSync(join(FIXTURES, VECTORS), "utf8"));

test("the HOST_DATA vectors are the pinned shared files", () => {
  const manifest = readFileSync(join(FIXTURES, "MANIFEST.sha256"));
  assert.equal(sha256(manifest), MANIFEST_SHA256);
  const entries = Object.fromEntries(manifest.toString("utf8").trimEnd().split("\n").map(line => line.split("  ").reverse()));
  assert.deepEqual(Object.keys(entries), [VECTORS]);
  assert.deepEqual(readdirSync(FIXTURES).sort(), ["MANIFEST.sha256", "README.md", VECTORS]);
  assert.equal(sha256(readFileSync(join(FIXTURES, VECTORS))), entries[VECTORS]);
  assert.equal(vectors().limit, 1024 * 1024);
});

test("initDataSha256 accepts every accepted vector with its HOST_DATA", () => {
  const { accept } = vectors();
  assert.deepEqual(accept.map(c => c.name), ["canonical", "empty-document", "gzip-header-file-name", "decompressed-at-limit"]);
  for (const { name, ccInitData, hostData } of accept) assert.equal(initDataSha256(ccInitData), hostData, name);
});

test("initDataSha256 refuses every refused vector", () => {
  const { refuse } = vectors();
  assert.ok(refuse.length >= 16);
  for (const { name, ccInitData } of refuse) assert.throws(() => initDataSha256(ccInitData), /^Error: init-data: /, name);
});
