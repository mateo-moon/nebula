import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Testing } from "cdk8s";
import { parse, stringify } from "yaml";
import { AwsK0sCluster, K0sOidcAuthentication, type KubernetesOidcIdentityConfig } from "nebula-cdk8s";
import { assertRenderedAuthenticator, buildOidcProfile, writeOidcProfile, type OidcKubeconfigOptions } from "../src/commands/oidc-kubeconfig";

const identity = (): KubernetesOidcIdentityConfig => ({
  cluster: "mgmt", hostname: "api.management.example.test",
  workforce: {
    url: "https://identity.example.test", jwksUrl: "https://identity.example.test/keys", audience: "desktop-client",
    emailDomain: "example.test", groups: ["oidc:operators"],
    login: { grantType: "authcode", extraScopes: ["email"], clientAuthentication: "none" },
  },
});

function fixture(run: (f: ReturnType<typeof create>) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-oidc-kubeconfig-"));
  try { run(create(directory)); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function create(directory: string) {
  const state = path.join(directory, "state"); fs.mkdirSync(path.join(state, "mgmt"), { recursive: true, mode: 0o700 });
  const config = path.join(directory, "identity.json");
  fs.writeFileSync(config, JSON.stringify(identity()));
  const admin = path.join(state, "mgmt", "kubeconfig"), adminBytes = "existing-bootstrap-credential-must-survive\n";
  fs.writeFileSync(admin, adminBytes, { mode: 0o600 });
  const options: OidcKubeconfigOptions = { config };
  const build = (extra: Partial<OidcKubeconfigOptions> = {}) => buildOidcProfile({ ...options, ...extra }, state);
  return { directory, state, config, admin, adminBytes, options, build };
}

test("the profile uses OIDC sign-in and never changes an existing administrator kubeconfig", () => fixture(f => {
  const handoff = f.build()!;
  assert.equal(handoff.output, path.join(f.state, "mgmt", "kubeconfig-oidc"));
  const profile = parse(handoff.kubeconfig);
  assert.equal(profile.clusters[0].cluster.server, "https://api.management.example.test");
  assert.deepEqual(Object.keys(profile.users[0].user), ["exec"]);
  assert.equal(profile.users[0].user.exec.command, "kubectl");
  assert.deepEqual(profile.users[0].user.exec.args.slice(0, 2), ["oidc-login", "get-token"]);
  assert.ok(profile.users[0].user.exec.args.includes("--token-cache-storage=keyring"));
  assert.ok(!/client-certificate|client-key|bearerToken|existing-bootstrap/.test(handoff.kubeconfig));
  assert.equal(writeOidcProfile(handoff), handoff.output);
  assert.equal(writeOidcProfile(handoff), handoff.output);
  assert.equal(fs.statSync(handoff.output).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.admin, "utf8"), f.adminBytes);
}));

test("native registration is validated locally and referenced without copying its app value", () => fixture(f => {
  const config = identity(); config.workforce.login!.clientAuthentication = "client-secret";
  fs.writeFileSync(f.config, JSON.stringify(config));
  const registration = path.join(f.directory, "desktop.json");
  const data = { issuer: config.workforce.url, client_id: config.workforce.audience, client_secret: "synthetic-desktop-app-value" };
  fs.writeFileSync(registration, JSON.stringify(data), { mode: 0o600 });
  const handoff = f.build({ clientConfig: registration })!;
  const exec = parse(handoff.kubeconfig).users[0].user.exec;
  assert.equal(exec.command, "nebula-oidc-login");
  assert.ok(exec.args.includes(`--oidc-client-secret-file=${registration}`));
  assert.ok(!handoff.kubeconfig.includes(data.client_secret));
  for (const invalid of [{ ...data, client_id: "another-client" }, { ...data, issuer: "https://other.example.test" },
    { ...data, refresh_token: "synthetic-user-token" }, { ...data, client_secret: "" }]) {
    fs.writeFileSync(registration, JSON.stringify(invalid));
    assert.throws(() => f.build({ clientConfig: registration }), /Native OIDC/);
  }
  fs.writeFileSync(registration, JSON.stringify(data));
  for (const mode of [0o644, 0o700]) {
    fs.chmodSync(registration, mode);
    assert.throws(() => f.build({ clientConfig: registration }), /owner-only/);
  }
  fs.chmodSync(registration, 0o400);
  assert.doesNotThrow(() => f.build({ clientConfig: registration }));
  fs.chmodSync(registration, 0o600); const alias = path.join(f.directory, "alias.json"); fs.symlinkSync(registration, alias);
  assert.throws(() => f.build({ clientConfig: alias }), /owner-only/);
  fs.writeFileSync(registration, JSON.stringify({ ...data, client_secret: "a".repeat(16 * 1024) }));
  assert.throws(() => f.build({ clientConfig: registration }), /at most 16 KiB/);
}));

test("invalid or mismatched input cannot create or overwrite profiles", () => fixture(f => {
  assert.throws(() => f.build({ output: f.admin }), /Refusing to replace/);
  assert.throws(() => f.build({ output: f.config }), /must not replace/);
  const output = path.join(f.directory, "existing.yaml"); fs.writeFileSync(output, "another profile", { mode: 0o600 });
  assert.throws(() => f.build({ output }), /Refusing to replace/);
  const alias = path.join(f.directory, "alias.yaml"); fs.symlinkSync(f.admin, alias);
  assert.throws(() => f.build({ output: alias }), /Refusing to replace/);
  fs.writeFileSync(f.config, "malformed JSON");
  assert.throws(() => f.build(), /Cannot read valid local OIDC JSON/);
  assert.equal(fs.existsSync(path.join(f.state, "mgmt", "kubeconfig-oidc")), false);
  assert.equal(fs.readFileSync(f.admin, "utf8"), f.adminBytes);
}));

test("the identity is checked against the rendered control-plane authenticator without touching the render", () => fixture(f => {
  const chart = Testing.chart();
  new AwsK0sCluster(chart, "management", { name: "mgmt", region: "eu-central-1", k8sVersion: "v1.35.7",
    controlPlane: { replicas: 3, authentication: { identity: identity() } } });
  const objects = Testing.synth(chart);
  for (const resource of objects.filter(object => ["Cluster", "K0sControlPlane"].includes(object.kind))) {
    resource.metadata.annotations = { "cluster.x-k8s.io/paused": "true" };
    if (resource.kind === "Cluster") resource.spec.paused = true;
  }
  const manifests = path.join(f.directory, "manifests"); fs.mkdirSync(manifests);
  const file = path.join(manifests, "management.k8s.yaml"), bytes = objects.map(object => stringify(object)).join("---\n");
  fs.writeFileSync(file, bytes);
  const handoff = f.build()!;
  assert.doesNotThrow(() => assertRenderedAuthenticator(manifests, handoff));
  const other = identity(); other.workforce.audience = "other-client"; fs.writeFileSync(f.config, JSON.stringify(other));
  assert.throws(() => assertRenderedAuthenticator(manifests, f.build()), /does not match/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.readFileSync(f.admin, "utf8"), f.adminBytes);
  const cp = objects.find(object => object.kind === "K0sControlPlane")!;
  delete cp.spec.k0sConfigSpec.k0s.spec.api.extraArgs["authentication-config"];
  fs.writeFileSync(file, objects.map(object => stringify(object)).join("---\n"));
  assert.throws(() => assertRenderedAuthenticator(manifests, handoff), /does not match/);
}));

test("a private API endpoint can use a local public CA without enabling insecure TLS", () => fixture(f => {
  const ca = path.join(f.directory, "ca.pem"), key = path.join(f.directory, "fixture.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-subj", "/CN=profile-fixture", "-keyout", key, "-out", ca], { stdio: "ignore" });
  const handoff = f.build({ caFile: ca })!;
  const cluster = parse(handoff.kubeconfig).clusters[0].cluster;
  assert.equal(Buffer.from(cluster["certificate-authority-data"], "base64").toString(), fs.readFileSync(ca, "utf8"));
  assert.equal(cluster["insecure-skip-tls-verify"], undefined);
  assert.throws(() => f.build({ caFile: key }), /only PEM certificates/);
}));

test("the command reads the identity from standard input and writes only the profile", () => fixture(f => {
  const output = path.join(f.directory, "profile.yaml");
  const cli = path.join(__dirname, "..", "src", "cli.ts");
  const run = (input: string) => execFileSync(process.execPath, ["--import", "tsx", cli, "oidc-kubeconfig", "--config", "-", "--output", output],
    { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const stdout = run(JSON.stringify(identity()));
  assert.match(stdout, /kubectl oidc-login plugin/);
  assert.equal(parse(fs.readFileSync(output, "utf8")).clusters[0].cluster.server, "https://api.management.example.test");
  assert.equal(fs.statSync(output).mode & 0o777, 0o600);
  assert.doesNotThrow(() => run(JSON.stringify(identity())));
  const other = identity(); other.hostname = "api.other.example.test";
  assert.throws(() => run(JSON.stringify(other)), /Refusing to replace/);
  assert.throws(() => run("not json"), /standard input/);
}));

test("a hosted control plane's authenticator is read from its mounted ConfigMap", () => fixture(f => {
  const chart = Testing.chart();
  const authentication = new K0sOidcAuthentication(chart, "oidc", { identity: identity(), namespace: "hosting" });
  const hosted = authentication.hosted(), api = authentication.api();
  const objects = [
    ...Testing.synth(chart),
    { apiVersion: "cluster.x-k8s.io/v1beta2", kind: "Cluster", metadata: { name: "mgmt", namespace: "hosting" },
      spec: { controlPlaneRef: { apiGroup: "controlplane.cluster.x-k8s.io", kind: "K0smotronControlPlane", name: "mgmt-cp" } } },
    { apiVersion: "controlplane.cluster.x-k8s.io/v1beta2", kind: "K0smotronControlPlane", metadata: { name: "mgmt-cp", namespace: "hosting" },
      spec: { mounts: hosted.mounts, k0sConfig: { apiVersion: "k0s.k0sproject.io/v1beta1", kind: "ClusterConfig", spec: { api } } } },
  ];
  const manifests = path.join(f.directory, "hosted"); fs.mkdirSync(manifests);
  const write = (items: any[]) => fs.writeFileSync(path.join(manifests, "hosted.k8s.yaml"), items.map(object => stringify(object)).join("---\n"));
  write(objects);
  const profile = f.build();
  assert.doesNotThrow(() => assertRenderedAuthenticator(manifests, profile));
  const other = identity(); other.workforce.audience = "other-client"; fs.writeFileSync(f.config, JSON.stringify(other));
  assert.throws(() => assertRenderedAuthenticator(manifests, f.build()), /does not match/);
  // The ConfigMap of another namespace, or a control plane without the mount, is not this cluster's authenticator.
  write(objects.map(object => object.kind === "ConfigMap" ? { ...object, metadata: { ...object.metadata, namespace: "elsewhere" } } : object));
  assert.throws(() => assertRenderedAuthenticator(manifests, profile), /does not match/);
  write(objects.map(object => object.kind === "K0smotronControlPlane" ? { ...object, spec: { ...object.spec, mounts: [] } } : object));
  assert.throws(() => assertRenderedAuthenticator(manifests, profile), /does not match/);
}));
