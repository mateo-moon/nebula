import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  NEUTRAL_WIRE,
  confidentialGuestAssetUrl,
  readConfidentialGuestAsset,
  wireProfileEnv,
} from "../src/modules/k8s/confidential-guests";
import { importTimeViolations, probeImport, type ImportScope } from "./support/import-io";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = join(pkgDir, "src", "modules", "k8s", "confidential-guests");
// The module may load the installed dependencies and the package's core
// helpers (core/argocd.ts); loading them is module loading, not file I/O. Any
// other package source it reached would be judged like its own code.
const scope: ImportScope = { root: moduleDir, dependencyRoots: [join(pkgDir, "node_modules"), join(pkgDir, "src", "core")] };

// Import-time I/O as defined in support/import-io.ts (controlled by
// io-probe.test.ts): reads, listings, stats and writes by module code, of
// module files or outside the dependencies, eager non-code imports, spawns.
test("the module does no file I/O when imported, and reads an asset only when asked", t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "cg-assets-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const result = probeImport({
    cwd: pkgDir,
    entryDir: work,
    specifier: join(moduleDir, "index.ts"),
    call: "readConfidentialGuestAsset",
    args: ["wire-profile.schema.json"],
  });
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const shown = (events: { kind: string; path: string }[]) => events.map(e => `${e.kind} ${relative(real(moduleDir), real(e.path))}`);
  assert.ok(result.events.some(e => e.kind === "load" && e.path.endsWith("assets.ts")), "the probe must see the module being loaded");
  assert.deepEqual(shown(importTimeViolations(result.events, scope)), [], "importing the module did file I/O");
  assert.deepEqual(shown(importTimeViolations(result.after, scope)), ["read assets/wire-profile.schema.json"], "the probe must see the lazy read");
});

test("the default provisioning template is read only when a script is rendered", t => {
  const work = realpathSync(mkdtempSync(join(tmpdir(), "cg-assets-")));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const result = probeImport({
    cwd: pkgDir,
    entryDir: work,
    specifier: join(moduleDir, "index.ts"),
    call: "provisionScript",
    args: [{ stateDir: "/var/lib/guests", file: "data-v1.img", loop: 200, sizeBytes: 1073741824, sizeLabel: "1Gi" }],
  });
  const shown = (events: { kind: string; path: string }[]) => events.map(e => `${e.kind} ${relative(realpathSync(moduleDir), realpathSync(e.path))}`);
  assert.deepEqual(shown(importTimeViolations(result.events, scope)), [], "importing the module did file I/O");
  assert.deepEqual(shown(importTimeViolations(result.after, scope)), ["read assets/provision.sh"], "the probe must see the lazy read");
});

test("asset names are a closed set and resolve inside the module", () => {
  for (const name of ["wire-profile.schema.json", "provision.sh"] as const) {
    const url = confidentialGuestAssetUrl(name);
    assert.equal(url.protocol, "file:");
    assert.equal(fileURLToPath(url), join(moduleDir, "assets", name));
  }
  for (const name of ["../index.ts", "../../../../package.json", "assets/wire-profile.schema.json", "missing.json", ""]) {
    assert.throws(() => confidentialGuestAssetUrl(name as never), TypeError, name);
  }
});

// The schema documents the GUEST_WIRE_PROFILE value for readers in other
// languages; it must list exactly the identifiers wireProfileEnv emits.
test("the wire-profile schema matches the emitted profile", () => {
  const schema = JSON.parse(readConfidentialGuestAsset("wire-profile.schema.json"));
  const value = JSON.parse(wireProfileEnv(NEUTRAL_WIRE).value);
  assert.deepEqual(schema.required.slice().sort(), Object.keys(value).sort());
  assert.equal(schema.additionalProperties, false);
  for (const group of Object.keys(value) as (keyof typeof NEUTRAL_WIRE)[]) {
    const node = schema.properties[group];
    assert.equal(node.additionalProperties, false, group);
    assert.deepEqual(node.required.slice().sort(), Object.keys(NEUTRAL_WIRE[group]).sort(), group);
    assert.deepEqual(Object.keys(node.properties).sort(), Object.keys(NEUTRAL_WIRE[group]).sort(), group);
  }
  const identifier = schema.$defs.identifier;
  const item = new RegExp(identifier.items.pattern);
  for (const group of Object.values(value) as Record<string, string[]>[]) {
    for (const list of Object.values(group)) {
      assert.ok(list.length >= identifier.minItems);
      assert.ok(list.every(s => item.test(s)));
    }
  }
  assert.ok(!item.test("A B") && !item.test("A\nB") && !item.test("é") && !item.test(""));
  for (const group of ["payloadTypes", "domains"]) {
    assert.match(schema.properties[group].description, /at most one identifier/, `${group} must state the one-identifier rule`);
  }
});
