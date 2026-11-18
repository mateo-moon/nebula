import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { renderDiff, renderEnvironment } from "nebula-cdk8s/tools/render";

function output(directory: string, name: string, entries: Record<string, { status?: string; yaml: string }>): string {
  const out = path.join(directory, name);
  fs.mkdirSync(path.join(out, "renders"), { recursive: true });
  const index: Record<string, unknown> = {};
  for (const [key, { status = "ok", yaml }] of Object.entries(entries)) {
    const file = `${key.replace(/[/#]/g, "__")}.yaml`;
    index[key] = { path: key, entry: "index.ts", apps: [], status, file };
    fs.writeFileSync(path.join(out, "renders", file), yaml);
    fs.writeFileSync(path.join(out, "renders", file.replace(/\.yaml$/, ".log")), status === "ok" ? "" : "boom\n");
  }
  fs.writeFileSync(path.join(out, "index.json"), JSON.stringify(index));
  return out;
}
const configMap = (name: string, data: Record<string, string>) =>
  `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n${Object.entries(data).map(([k, v]) => `  ${k}: "${v}"`).join("\n")}\n`;

test("differences are reported per object, formatting alone is not a difference, volatile fields are masked", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-render-diff-"));
  try {
    const base = output(directory, "base", {
      "apps/one": { yaml: configMap("a", { x: "1" }) },
      "apps/two": { yaml: configMap("b", { x: "1" }) },
      "apps/three": { yaml: configMap("c", { token: "old", x: "1" }) },
    });
    const head = output(directory, "head", {
      "apps/one": { yaml: configMap("a", { x: "2" }) },
      "apps/two": { yaml: `# comment\n${configMap("b", { x: "1" })}` },
      "apps/three": { yaml: configMap("c", { token: "new", x: "1" }) },
    });
    const volatile = path.join(directory, "volatile.txt");
    fs.writeFileSync(volatile, "apps/three v1 ConfigMap default/c /data/token\n");
    const { pass, report } = renderDiff({ base, head, volatile });
    assert.equal(pass, true);
    assert.match(report, /== differences \(2\)/);
    assert.match(report, /~ apps\/one v1 ConfigMap default\/a/);
    assert.match(report, /! apps\/two \(same objects, YAML formatting differs\)/);
    assert.doesNotMatch(report, /apps\/three v1 ConfigMap default\/c\n/);
    assert.match(report, /\[2 masked\]/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("a failed render fails the comparison unless it already failed at base and is listed", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-render-diff-"));
  try {
    const good = { yaml: configMap("a", { x: "1" }) }, bad = { status: "exit 1", yaml: "" };
    const unrendered = path.join(directory, "unrendered.txt"); fs.writeFileSync(unrendered, "apps/one\n");
    const failing = renderDiff({ base: output(directory, "b1", { "apps/one": good }), head: output(directory, "h1", { "apps/one": bad }) });
    assert.equal(failing.pass, false);
    assert.match(failing.report, /apps\/one: head render exit 1/);
    assert.equal(renderDiff({ base: output(directory, "b2", { "apps/one": bad }), head: output(directory, "h2", { "apps/one": bad }), unrendered }).pass, true);
    assert.equal(renderDiff({ base: output(directory, "b3", { "apps/one": good }), head: output(directory, "h3", { "apps/one": good }), unrendered }).pass, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("goldens use the original stream even when a volatile rule masks the difference", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-render-golden-"));
  try {
    const baseYaml = configMap("a", { token: "base" });
    const headYaml = configMap("a", { token: "head" });
    const base = output(directory, "base", { one: { yaml: baseYaml } });
    const head = output(directory, "head", { one: { yaml: headYaml } });
    const volatile = path.join(directory, "volatile");
    fs.writeFileSync(volatile, "one v1 ConfigMap default/a /data/token\n");
    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    const want = { stream_sha256: sha(headYaml), canonical_sha256: sha(JSON.stringify([
      { apiVersion: "v1", data: { token: "head" }, kind: "ConfigMap", metadata: { name: "a", namespace: "default" } },
    ])) };
    const goldens = path.join(directory, "goldens.json");
    fs.writeFileSync(goldens, JSON.stringify({ one: want }));
    const result = renderDiff({ base, head, volatile, goldens });
    assert.equal(result.pass, true);
    assert.match(result.report, /base one: .* != golden/);
    assert.match(result.report, /head one: .* == golden/);
    assert.match(result.report, /2 masked/);
    fs.writeFileSync(goldens, JSON.stringify({ one: { ...want, stream_sha256: sha(baseYaml) } }));
    assert.equal(renderDiff({ base, head, volatile, goldens }).pass, false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("the render environment carries tool locations and stated extras, not the caller's credentials", () => {
  const env = renderEnvironment({ PATH: "/usr/bin", HOME: "/home/r", AWS_SECRET_ACCESS_KEY: "leak", KUBECONFIG: "/k" },
    { bin: "/opt/bin", env: ["FIXTURE=a=b"] });
  assert.deepEqual(env, { PATH: "/opt/bin:/usr/bin", HOME: "/home/r", ARGOCD_EXEC_TIMEOUT: "10m", FIXTURE: "a=b" });
  assert.throws(() => renderEnvironment({ PATH: "/usr/bin" }, { env: ["novalue"] }), /NAME=VALUE/);
});

test("the library entry point runs when invoked through its node_modules link", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-render-entry-"));
  try {
    const entries = { "apps/one": { yaml: configMap("a", { x: "1" }) } };
    const base = output(directory, "base", entries);
    const head = output(directory, "head", { "apps/one": { yaml: configMap("a", { x: "2" }) } });
    const tool = path.join(__dirname, "..", "node_modules", "nebula-cdk8s", "src", "tools", "render.ts");
    const report = execFileSync(process.execPath, ["--import", "tsx", tool, "diff", "--base", base, "--head", head], {
      encoding: "utf8", env: { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory },
    });
    assert.match(report, /== differences \(1\)/);
    assert.deepEqual(fs.readdirSync(directory).filter(name => name.startsWith("render-diff-")), []);
    assert.match(report, /PASS/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
