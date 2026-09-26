// The example synthesizes to a committed golden file. Any change to what the
// constructs render shows up as a diff of that file in review; regenerate it
// with UPDATE_GOLDEN=1 after checking the change is intended.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { App, Chart } from "cdk8s";
import type { ConfidentialGuestStack } from "../src/modules/k8s/confidential-guests";
import { confidentialGuestsExample } from "../example/confidential-guests";

const here = dirname(fileURLToPath(import.meta.url));
const golden = join(here, "confidential-guests-golden", "example.k8s.yaml");
const repoRoot = join(here, "..", "..", "..");

const synth = () => {
  const app = new App();
  const chart = new Chart(app, "confidential-guests-example");
  const stack: ConfidentialGuestStack = confidentialGuestsExample(chart);
  return { yaml: app.synthYaml(), objects: chart.toJson() as any[], stack };
};

test("the example renders its golden manifests", () => {
  const { yaml } = synth();
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(golden, yaml);
  assert.equal(yaml, readFileSync(golden, "utf8"), "the example render changed; review it and rerun with UPDATE_GOLDEN=1");
});

test("every object has an explicit, prop-derived name, in the example's namespace unless cluster-scoped", () => {
  const { objects } = synth();
  assert.ok(objects.length > 40);
  for (const object of objects) {
    assert.match(object.metadata.name, /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/);
    // cdk8s appends an 8-hex hash to names it generates.
    assert.doesNotMatch(object.metadata.name, /-[0-9a-f]{8}$/, object.metadata.name);
    const clusterScoped = object.kind === "PersistentVolume" || object.kind.startsWith("ValidatingAdmissionPolicy");
    assert.equal(object.metadata.namespace, clusterScoped ? undefined : "guests", `${object.kind}/${object.metadata.name}`);
  }
});

test("one stack wires the broker, disks and injector to its guests", () => {
  const { objects, stack } = synth();
  const order = objects.map(o => `${o.kind}/${o.metadata.name}`);
  const at = (entry: string) => {
    const i = order.indexOf(entry);
    assert.ok(i >= 0, entry);
    return i;
  };
  const sequence = ["Deployment/pull-broker", "ConfigMap/signed-release-5eed5eed5eed5eed", "Service/guest-primary", "Deployment/primary-disk",
    "Deployment/key-injector", "PersistentVolumeClaim/guest-operator-v1", "Deployment/log-retention", "ValidatingAdmissionPolicy/guests-creator",
    "Deployment/operator-lifecycle"].map(at);
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), order.join("\n"));
  const policy = objects.find(o => o.kind === "ConfigMap" && o.metadata.name === "pull-broker-configuration").data["resource-policy.rego"];
  assert.ok(policy.includes(`ev.init_data in ${JSON.stringify(stack.context.initDataSha256)}`), "the broker admits exactly the declared releases");
  const claims = objects.filter(o => o.kind === "PersistentVolumeClaim").map(o => o.metadata.name);
  for (const role of stack.context.roles) {
    for (const claim of [role.claim, ...(role.stage ? [role.stage.claim] : [])]) assert.ok(claims.includes(claim), claim);
  }
  const injector = objects.find(o => o.kind === "Deployment" && o.metadata.name === "key-injector").spec.template.spec.containers[0].args as string[];
  const bound = injector.filter((_, i) => injector[i - 1] === "--binding").map(b => b.split("=")[0]);
  assert.deepEqual([...new Set(bound)], stack.context.guestPods);
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
  assert.deepEqual([...new Set(domains)].sort(), ["argocd.argoproj.io", "guests.example.com", "kubernetes.io"]);
});

test("the publication guard finds nothing in the example's rendered output, and sees this input", () => {
  const { yaml } = synth();
  const guard = (input: string) => spawnSync(process.execPath, [join(repoRoot, "scripts", "publication-guard.mjs"), "--stdin", "--label", "example-synth", "--json"],
    { input, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY_OWNER: "" } });
  const clean = guard(yaml);
  assert.equal(clean.stderr, "");
  assert.deepEqual(JSON.parse(clean.stdout).findings, []);
  assert.equal(clean.status, 0);
  // A private address seeded into the output must be found (assembled here so
  // that this file itself holds no address literal).
  const seeded = guard(yaml.replace("tee-node-1", [10, 0, 0, 8].join(".")));
  assert.equal(seeded.status, 1);
  assert.ok(JSON.parse(seeded.stdout).findings.length > 0);
});
