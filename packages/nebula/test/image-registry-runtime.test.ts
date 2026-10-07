import assert from "node:assert/strict";
import test, { before, after, type TestContext } from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { registryConfig, registryCode } from "./support/image-registry-config";
const REGISTRY_TOOLS_IMAGE = registryConfig.images.tools;

const code = mkdtempSync(join(tmpdir(), "registry-generated-code-"));
for (const [name, content] of Object.entries(registryCode())) writeFileSync(join(code, name), content);
after(() => rmSync(code, { recursive: true, force: true }));
const registry = "123456789012.dkr.ecr.eu-central-1.amazonaws.com";
const token = Buffer.from("AWS:synthetic-sensitive-password").toString("base64");
const source = { auth: "synthetic-sensitive-gcr", username: "_json_key" };
const response = (changes: object = {}) => ({ authorizationData: [{ authorizationToken: token,
  proxyEndpoint: `https://${registry}`, expiresAt: Math.floor(Date.now() / 1000) + 43200, ...changes }] });
const docker = ["run", `--platform=linux/${process.arch === "arm64" ? "arm64" : "amd64"}`, "--network=none", "--read-only", "--cap-drop=ALL",
  "--security-opt=no-new-privileges", "--user", `${process.getuid!()}:${process.getgid!()}`];

before(() => {
  // Exercise the exact published runtime, including its shell, jq and kubectl.
  execFileSync("docker", [...docker, "--rm", "--entrypoint=/bin/sh", REGISTRY_TOOLS_IMAGE,
    "-ec", "jq --version; kubectl version --client -o json"], { stdio: "pipe", timeout: 180000 });
});

function fixture(t: TestContext, ecr: any = response(), base: any = { auths: { "gcr.io": source } }) {
  const root = mkdtempSync(join(tmpdir(), "registry-shell-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ["work", "gcr", "mock"]) mkdirSync(join(root, name));
  const write = (name: string, value: unknown) => writeFileSync(join(root, name), JSON.stringify(value), { mode: 0o600 });
  const read = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));
  write("work/ecr.json", ecr); write("gcr/.dockerconfigjson", base);
  copyFileSync(fileURLToPath(new URL("./support/registry-kubectl-fixture.sh", import.meta.url)), join(root, "mock/kubectl"));
  chmodSync(join(root, "mock/kubectl"), 0o700);
  const run = (operation = "refresh", scenario = "") => {
    const name = `registry-shell-${randomUUID()}`;
    const command = (args: string[], input?: Buffer) => execFileSync("docker", args, { input, stdio: "pipe", timeout: 45000 });
    try {
      // Stream over the Docker API: CI's nested daemon cannot bind paths from the
      // job container. Fixtures are synthetic and every container is disposable.
      command([...docker, "-d", "--name", name,
        ...["code", "work", "gcr", "mock"].flatMap(path => ["--tmpfs",
          `/${path}:exec,uid=${process.getuid!()},gid=${process.getgid!()},mode=0700,size=4m`]),
        "--tmpfs", `/var/run/secrets/kubernetes.io/serviceaccount:uid=${process.getuid!()},gid=${process.getgid!()},mode=0700,size=4m`,
        "-e", "PATH=/mock:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "-e", `REGISTRY=${registry}`, "-e", "SECRET_NAMESPACE=test", "-e", "DOCKER_CONFIG=/work/docker",
        "-e", "KUBERNETES_SERVICE_HOST=127.0.0.1", "-e", "KUBERNETES_SERVICE_PORT=1",
        "-e", `SCENARIO=${scenario}`, "--entrypoint=/bin/sh", REGISTRY_TOOLS_IMAGE, "-c", "sleep 120"]);
      for (const path of ["code", "work", "gcr", "mock"]) {
        const archive = execFileSync("tar", ["-cf", "-", "-C", path === "code" ? code : join(root, path),
          ...(path === "code" ? ["registry.sh", "credentials.jq"] : ["."])],
          { env: { ...process.env, COPYFILE_DISABLE: "1" } });
        command(["exec", "-i", name, "tar", "-xf", "-", "-C", `/${path}`], archive);
      }
      if (scenario === "in-cluster") command(["exec", name, "/bin/sh", "-ec",
        "cd /var/run/secrets/kubernetes.io/serviceaccount; printf '%s' synthetic-token > token; "
        + "printf '%s' test > namespace; cp /etc/ssl/certs/ca-certificates.crt ca.crt"]);
      const result = spawnSync("docker", ["exec", name, "/bin/sh", "/code/registry.sh", operation],
        { encoding: "utf8", timeout: 45000 });
      assert.ifError(result.error);
      const archive = command(["exec", name, "tar", "-cf", "-", "-C", "/work", "."]);
      execFileSync("tar", ["-xf", "-", "--no-same-owner", "-C", join(root, "work")], { input: archive });
      for (const secret of [token, source.auth, "synthetic-sensitive-password", "synthetic-sensitive-error"]) {
        assert.ok(!(result.stdout + result.stderr).includes(secret), "credential or API error leaked");
      }
      assert.ok(!readdirSync(join(root, "work")).some(path => path.startsWith("registry.")), "temporary credentials left behind");
      return result;
    } finally {
      command(["rm", "-f", name]);
    }
  };
  const calls = () => existsSync(join(root, "work/calls")) ? readFileSync(join(root, "work/calls"), "utf8").trim().split("\n") : [];
  return { root, write, read, run, calls };
}

const previous = () => ({ apiVersion: "v1", kind: "Secret", type: "kubernetes.io/dockerconfigjson",
  metadata: { name: "workload-pull-credentials", namespace: "test", resourceVersion: "1",
    labels: { owner: "keep" }, annotations: { unrelated: "keep" } }, data: { ".dockerconfigjson": "old-value" } });

test("first refresh creates runtime and workload configured aliases and preserves the GCR source", t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), ["get", "create"]);
  const secret = f.read("work/secret.json");
  const config = JSON.parse(Buffer.from(secret.data[".dockerconfigjson"], "base64").toString());
  assert.deepEqual(config.auths["gcr.io"], source);
  assert.deepEqual(config.auths["gcr.io/example-project/runtime"], source);
  assert.deepEqual(config.auths["gcr.io/example-project/second"], source);
  assert.deepEqual(config.auths[registry], { username: "AWS", password: "synthetic-sensitive-password", auth: token });
  assert.deepEqual(config.auths[`${registry}/images/runtime`], config.auths[registry]);
  assert.deepEqual(config.auths[`${registry}/images/workload`], config.auths[registry]);
  assert.equal(Object.keys(config.auths).length, 6);
  assert.deepEqual(f.read("gcr/.dockerconfigjson"), { auths: { "gcr.io": source } });
  assert.match(secret.metadata.annotations["registry.nebula.sh/ecr-expires-at"], /^\d{4}-.*Z$/);
  assert.match(result.stdout, /^Registry pull credentials refreshed; valid until /);
});

test("ISO expiry and mirror permissions are valid; an existing config is never reused", t => {
  const expiry = new Date(Date.now() + 43200000).toISOString().replace("Z", "+00:00");
  const f = fixture(t, response({ expiresAt: expiry })), result = f.run("mirror");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.calls(), []);
  const config = f.read("work/docker/config.json");
  assert.deepEqual(config.auths["gcr.io"], source);
  assert.equal(config.auths[registry].auth, token);
  assert.equal(statSync(join(f.root, "work/docker")).mode & 0o777, 0o700);
  assert.equal(statSync(join(f.root, "work/docker/config.json")).mode & 0o777, 0o600);
  assert.notEqual(f.run("mirror").status, 0);
  assert.deepEqual(f.read("work/docker/config.json"), config);
});

test("refresh uses resourceVersion and retains unrelated metadata", t => {
  const f = fixture(t); f.write("work/secret.json", previous());
  assert.equal(f.run().status, 0);
  assert.deepEqual(f.calls(), ["get", "replace"]);
  const submitted = f.read("work/submitted.json");
  assert.equal(submitted.metadata.resourceVersion, "1");
  assert.deepEqual(submitted.metadata.labels, { owner: "keep" });
  assert.equal(submitted.metadata.annotations.unrelated, "keep");
});

test("a concurrent first create re-reads and replaces the new resource version", t => {
  const f = fixture(t);
  assert.equal(f.run("refresh", "create-race").status, 0);
  assert.deepEqual(f.calls(), ["get", "create", "get", "replace"]);
  assert.equal(f.read("work/submitted.json").metadata.resourceVersion, "2");
  assert.equal(f.read("work/secret.json").metadata.annotations.competitor, "keep");
});

for (const scenario of ["forbidden", "conflict"]) test(`${scenario} leaves the previous Secret intact and bounds retries`, t => {
  const f = fixture(t), old = previous(); f.write("work/secret.json", old);
  const result = f.run("refresh", scenario);
  assert.notEqual(result.status, 0);
  assert.equal(result.stderr.trim(), `Registry credential operation failed (${scenario === "forbidden" ? "secret-read" : "secret-write"})`);
  assert.deepEqual(f.read("work/secret.json"), old);
  assert.deepEqual(f.calls(), scenario === "forbidden" ? ["get"] : ["get", "replace", "get", "replace", "get", "replace"]);
});

test("real kubectl discovers the service account when the script bounds its execution time", t => {
  const f = fixture(t), result = f.run("refresh", "in-cluster");
  assert.notEqual(result.status, 0, "the synthetic API port is deliberately closed");
  const error = readFileSync(join(f.root, "work/client-error"), "utf8");
  assert.match(error, /127\.0\.0\.1:1/);
  assert.doesNotMatch(error, /localhost:8080/, "a request-timeout override disables in-cluster discovery in this kubectl");
  assert.equal(result.stderr.trim(), "Registry credential operation failed (secret-read)");
});

test("an unresponsive Kubernetes client is stopped without writing credentials", { timeout: 40000 }, t => {
  const f = fixture(t), old = previous(); f.write("work/secret.json", old);
  const result = f.run("refresh", "hang");
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.calls(), ["get"]);
  assert.deepEqual(f.read("work/secret.json"), old);
  assert.equal(result.stderr.trim(), "Registry credential operation failed (secret-read)");
});

test("expired, wrong-registry and malformed credentials never reach Kubernetes", async t => {
  const invalid = [response({ expiresAt: Date.now() / 1000 + 60 }), response({ expiresAt: "not-a-time" }),
    response({ proxyEndpoint: "https://unrelated.example.test" }), response({ authorizationToken: "invalid" }),
    response({ authorizationToken: Buffer.from("wrong:user").toString("base64") }),
    response({ authorizationToken: Buffer.from("AWS:").toString("base64") }),
    response({ authorizationToken: token + "!" }), { authorizationData: [] },
    { authorizationData: [...response().authorizationData, ...response().authorizationData] }];
  for (const [index, value] of invalid.entries()) await t.test(`invalid input ${index + 1}`, child => {
    const f = fixture(child, value), old = previous(); f.write("work/secret.json", old);
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(f.calls(), []);
    assert.deepEqual(f.read("work/secret.json"), old);
  });
  for (const base of [{ auths: {} }, { auths: { "gcr.io": { auth: "" } } },
    { auths: { "gcr.io": source, "extra.example.test": source } }]) await t.test("invalid GCR source", child => {
    const f = fixture(child, response(), base);
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(f.calls(), []);
  });
});
