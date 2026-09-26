// The image-mode controller contract: what GuestLifecycle and
// GuestLogRetention render for a controller image (its entry point,
// environment, permissions and the spec it reads) is pinned in
// confidential-guests-lifecycle-contract/. The files are nebula's own output
// for the example stack; a controller image that runs in image mode vendors
// them, and its tests read them. Regenerate them with
// UPDATE_LIFECYCLE_CONTRACT=1 after checking the change is intended; the
// manifest pin below then fails until it is updated in the same change.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Chart, Testing } from "cdk8s";
import {
  LIFECYCLE_CONTROLLER_COMMAND,
  LIFECYCLE_SPEC_VERSIONS,
  LOG_RETENTION_COMMAND,
  canonicalJson,
  lifecycleNames,
} from "../src/modules/k8s/confidential-guests";
import { confidentialGuestsExample } from "../example/confidential-guests";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "confidential-guests-lifecycle-contract");
// A fixture changes only together with this pin, in a reviewed change.
const MANIFEST_SHA256 = "6eb9f89bcbdce57e3674e04f85fb9ee4b6be0eab3a8e2e77e4391b15d125d84c";
const ROLES = ["operator", "primary"];
const FILES = ["controllers.json", ...ROLES.map(role => `lifecycle-spec.${role}.json`)];
// Every key of a version 2 spec: version 1's and the placement an image-mode controller takes from Git.
const SPEC_V2_KEYS = [
  "budget", "claims", "containers", "current", "generation", "grace_seconds", "holder_name", "initializers", "label_domains", "live",
  "node_name", "previous", "ready", "releases", "role", "rollout", "rollout_id", "runtime_class_name", "stage_name", "startup_seconds", "version",
];
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/** The example's image-mode contract files, as rendered: one canonical JSON line and a newline each. */
function rendered(): Record<string, string> {
  const app = Testing.app();
  confidentialGuestsExample(new Chart(app, "example"));
  const objects = app.charts.flatMap(chart => chart.toJson()) as any[];
  const find = (kind: string, name: string) => objects.find(o => o.kind === kind && o.metadata.name === name) ?? assert.fail(`${kind}/${name}`);
  const pod = (deployment: string) => {
    const spec = find("Deployment", deployment).spec.template.spec;
    assert.equal(spec.containers.length, 1, deployment);
    const [{ command, env, securityContext, volumeMounts }] = spec.containers;
    return { command, env, securityContext, ...(volumeMounts ? { volumeMounts } : {}),
      serviceAccountName: spec.serviceAccountName, rules: find("Role", spec.serviceAccountName).rules };
  };
  const files: Record<string, string> = {};
  const lifecycle: Record<string, unknown> = {};
  for (const role of ROLES) {
    const names = lifecycleNames(role);
    const file = `lifecycle-spec.${role}.json`;
    files[file] = `${find("ConfigMap", names.spec).data["spec.json"]}\n`;
    lifecycle[role] = { ...pod(names.controller), spec: { configMap: names.spec, key: "spec.json", file }, ledger: { configMap: names.ledger, key: "state" } };
  }
  files["controllers.json"] = `${canonicalJson({ lifecycle, logRetention: pod("log-retention") })}\n`;
  return files;
}

test("the contract files are the example's render, byte for byte, under a pinned manifest", () => {
  const files = rendered();
  if (process.env.UPDATE_LIFECYCLE_CONTRACT === "1") {
    for (const name of FILES) writeFileSync(join(FIXTURES, name), files[name]);
    writeFileSync(join(FIXTURES, "MANIFEST.sha256"), FILES.map(name => `${sha256(files[name])}  ${name}\n`).join(""));
  }
  const manifest = readFileSync(join(FIXTURES, "MANIFEST.sha256"), "utf8");
  assert.equal(sha256(manifest), MANIFEST_SHA256, "MANIFEST.sha256 changed: review the contract files and update the pin");
  const entries = manifest.trimEnd().split("\n").map(line => /^([0-9a-f]{64}) {2}(\S+)$/.exec(line) ?? assert.fail(`manifest line ${line}`));
  assert.deepEqual(entries.map(entry => entry[2]), FILES);
  for (const [, hash, name] of entries) {
    const text = readFileSync(join(FIXTURES, name), "utf8");
    assert.equal(sha256(text), hash, name);
    assert.equal(text, files[name], `${name} is no longer what the example renders`);
    assert.ok(text.endsWith("\n") && !text.slice(0, -1).includes("\n"), `${name} is one line`);
    assert.equal(canonicalJson(JSON.parse(text)), text.slice(0, -1), `${name} is canonical JSON`);
  }
  assert.deepEqual(readdirSync(FIXTURES).sort(), ["MANIFEST.sha256", "README.md", ...FILES].sort());
});

test("an image-mode controller gets its role and namespace only, and reads everything else from a version 2 spec", () => {
  const controllers = JSON.parse(readFileSync(join(FIXTURES, "controllers.json"), "utf8"));
  assert.deepEqual(Object.keys(controllers.lifecycle), ROLES);
  for (const role of ROLES) {
    const controller = controllers.lifecycle[role];
    assert.deepEqual(controller.command, LIFECYCLE_CONTROLLER_COMMAND);
    assert.deepEqual(controller.env, [{ name: "LIFECYCLE_ROLE", value: role }, { name: "LIFECYCLE_NAMESPACE", value: "guests" }]);
    assert.deepEqual(controller.securityContext, {
      allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] }, readOnlyRootFilesystem: true,
      runAsGroup: 65532, runAsNonRoot: true, runAsUser: 65532, seccompProfile: { type: "RuntimeDefault" },
    });
    const spec = JSON.parse(readFileSync(join(FIXTURES, controller.spec.file), "utf8"));
    assert.deepEqual(Object.keys(spec).sort(), SPEC_V2_KEYS, role);
    assert.equal(spec.version, LIFECYCLE_SPEC_VERSIONS.image);
    assert.equal(spec.role, role);
    assert.deepEqual([spec.node_name, spec.runtime_class_name, spec.label_domains], ["tee-node-1", "kata-qemu-snp", ["guests.example.com"]]);
  }
  // One role with a stage boot and one without, so a controller's tests see both.
  const specs = ROLES.map(role => JSON.parse(readFileSync(join(FIXTURES, `lifecycle-spec.${role}.json`), "utf8")));
  assert.deepEqual(specs.map(spec => spec.stage_name === null), [true, false]);
  assert.deepEqual(controllers.logRetention.command, LOG_RETENTION_COMMAND);
  assert.deepEqual(controllers.logRetention.env.map((entry: { name: string }) => entry.name), ["LOG_NAMESPACE", "LOG_SCOPE"]);
});
