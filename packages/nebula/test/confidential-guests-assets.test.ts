import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NEUTRAL_WIRE,
  confidentialGuestAssetUrl,
  readConfidentialGuestAsset,
  wireProfileEnv,
} from "../src/modules/k8s/confidential-guests";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const moduleDir = join(pkgDir, "src", "modules", "k8s", "confidential-guests");

test("assets are read only when asked for, never when the module is imported", t => {
  const work = mkdtempSync(join(tmpdir(), "cg-assets-"));
  t.after(() => rmSync(work, { recursive: true, force: true }));
  const entry = join(work, "entry.mjs");
  writeFileSync(entry, [
    "const probe = globalThis.__ioProbe;",
    "probe.arm();",
    `const mod = await import(${JSON.stringify(pathToFileURL(join(moduleDir, "index.ts")).href)});`,
    "const atImport = probe.disarm();",
    "probe.arm();",
    'mod.readConfidentialGuestAsset("wire-profile.schema.json");',
    "const onCall = probe.disarm();",
    "process.stdout.write(JSON.stringify({ atImport, onCall }));",
  ].join("\n"));
  const out = execFileSync(process.execPath, ["--import", "tsx", "--import", join(pkgDir, "test", "support", "io-probe.mjs"), entry], {
    cwd: pkgDir, encoding: "utf8",
  });
  const { atImport, onCall } = JSON.parse(out) as Record<string, { kind: string; path: string }[]>;
  const inModule = (events: { kind: string; path: string }[]) =>
    events.filter(e => e.kind !== "read" || !/\.(ts|js|mjs|cjs)$/.test(e.path))
      .map(e => relative(realpathSync(moduleDir), realpathSync(e.path)))
      .filter(p => !p.startsWith(".."));
  assert.deepEqual(inModule(atImport), [], "importing the module read an asset");
  assert.deepEqual(inModule(onCall), ["assets/wire-profile.schema.json"], "the probe must see the lazy read");
});

test("asset names are a closed set and resolve inside the module", () => {
  const url = confidentialGuestAssetUrl("wire-profile.schema.json");
  assert.equal(url.protocol, "file:");
  assert.ok(fileURLToPath(url).startsWith(join(moduleDir, "assets") + "/"));
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
});
