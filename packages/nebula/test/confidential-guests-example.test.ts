// The example synthesizes to a committed golden file. Any change to what the
// constructs render shows up as a diff of that file in review; regenerate it
// with UPDATE_GOLDEN=1 after checking the change is intended.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { App } from "cdk8s";
import { ConfidentialGuestsExample } from "../example/confidential-guests";

const here = dirname(fileURLToPath(import.meta.url));
const golden = join(here, "confidential-guests-golden", "example.k8s.yaml");
const repoRoot = join(here, "..", "..", "..");

const synth = () => {
  const app = new App();
  const chart = new ConfidentialGuestsExample(app, "confidential-guests-example");
  return { yaml: app.synthYaml(), objects: chart.toJson() as any[] };
};

test("the example renders its golden manifests", () => {
  const { yaml } = synth();
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, yaml);
  assert.equal(yaml, readFileSync(golden, "utf8"), "the example render changed; review it and rerun with UPDATE_GOLDEN=1");
});

test("every object has an explicit, prop-derived name in the example's namespace", () => {
  const { objects } = synth();
  assert.ok(objects.length > 10);
  for (const object of objects) {
    assert.match(object.metadata.name, /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    // cdk8s appends an 8-hex hash to names it generates.
    assert.doesNotMatch(object.metadata.name, /-[0-9a-f]{8}$/, object.metadata.name);
    if (object.kind !== "PersistentVolume") assert.equal(object.metadata.namespace, "confidential-guests", object.metadata.name);
  }
});

test("no annotation or label key uses a domain the caller did not pass", () => {
  const { objects } = synth();
  const keys = new Set<string>();
  const collect = (value: any) => {
    if (!value || typeof value !== "object") return;
    for (const field of ["labels", "annotations", "matchLabels"]) {
      if (value[field] && typeof value[field] === "object") Object.keys(value[field]).forEach(k => keys.add(k));
    }
    Object.values(value).forEach(collect);
  };
  objects.forEach(collect);
  const domains = [...keys].filter(k => k.includes("/")).map(k => k.slice(0, k.indexOf("/")));
  assert.deepEqual([...new Set(domains)].sort(), ["argocd.argoproj.io", "guests.example.com"]);
});

test("the publication guard finds nothing in the example's rendered output", () => {
  const { yaml } = synth();
  const run = spawnSync(process.execPath, [join(repoRoot, "scripts", "publication-guard.mjs"), "--stdin", "--label", "example-synth", "--json"],
    { input: yaml, encoding: "utf8" });
  assert.equal(run.stderr, "");
  const report = JSON.parse(run.stdout);
  assert.deepEqual(report.findings, []);
  assert.equal(run.status, 0);
  // The guard is not blind to this input: a private address in it is found
  // (assembled here so that this file itself holds no address literal).
  const seeded = spawnSync(process.execPath, [join(repoRoot, "scripts", "publication-guard.mjs"), "--stdin", "--label", "example-synth", "--json"],
    { input: yaml.replace("guest-host-1", [10, 0, 0, 8].join(".")), encoding: "utf8" });
  assert.equal(seeded.status, 1);
  assert.ok(JSON.parse(seeded.stdout).findings.length > 0);
});
