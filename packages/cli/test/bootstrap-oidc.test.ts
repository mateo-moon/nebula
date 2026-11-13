import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { Testing } from "cdk8s";
import { parse, stringify } from "yaml";
import { AwsK0sCluster, type KubernetesOidcIdentityConfig } from "nebula-cdk8s";
import { assertManagementOidc, prepareOidcHandoff, writeOidcHandoff } from "../src/commands/bootstrap/oidc";

const identity = (): KubernetesOidcIdentityConfig => ({
  cluster: "mgmt", hostname: "api.management.example.test",
  workforce: {
    url: "https://identity.example.test", jwksUrl: "https://identity.example.test/keys", audience: "desktop-client",
    emailDomain: "example.test", groups: ["oidc:operators"],
    login: { grantType: "authcode", extraScopes: ["email"], clientAuthentication: "none" },
  },
});

function fixture(run: (f: ReturnType<typeof create>) => void): void {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-bootstrap-oidc-"));
  try { run(create(directory)); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function create(directory: string) {
  const state = path.join(directory, "state"); fs.mkdirSync(state, { mode: 0o700 });
  const config = path.join(directory, "identity.json");
  fs.writeFileSync(config, JSON.stringify(identity()));
  const admin = path.join(state, "kubeconfig"), adminBytes = "existing-bootstrap-credential-must-survive\n";
  fs.writeFileSync(admin, adminBytes, { mode: 0o600 });
  const options = { oidcConfig: config };
  return { directory, state, config, admin, adminBytes, options };
}

test("the local operator profile uses OIDC and never changes existing bootstrap credentials", () => fixture(f => {
  const handoff = prepareOidcHandoff("mgmt", f.state, f.options)!;
  assert.equal(handoff.output, path.join(f.state, "kubeconfig-oidc"));
  const profile = parse(handoff.kubeconfig);
  assert.equal(profile.clusters[0].cluster.server, "https://api.management.example.test");
  assert.deepEqual(Object.keys(profile.users[0].user), ["exec"]);
  assert.equal(profile.users[0].user.exec.command, "kubectl");
  assert.deepEqual(profile.users[0].user.exec.args.slice(0, 2), ["oidc-login", "get-token"]);
  assert.ok(profile.users[0].user.exec.args.includes("--token-cache-storage=keyring"));
  assert.ok(!/client-certificate|client-key|bearerToken|existing-bootstrap/.test(handoff.kubeconfig));
  assert.equal(writeOidcHandoff(handoff), handoff.output);
  assert.equal(writeOidcHandoff(handoff), handoff.output);
  assert.equal(fs.statSync(handoff.output).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.admin, "utf8"), f.adminBytes);
}));

test("native registration is validated locally and referenced without copying its app value", () => fixture(f => {
  const config = identity(); config.workforce.login!.clientAuthentication = "client-secret";
  fs.writeFileSync(f.config, JSON.stringify(config));
  const registration = path.join(f.directory, "desktop.json");
  const data = { issuer: config.workforce.url, client_id: config.workforce.audience, client_secret: "synthetic-desktop-app-value" };
  fs.writeFileSync(registration, JSON.stringify(data), { mode: 0o600 });
  const handoff = prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcClientConfig: registration })!;
  const exec = parse(handoff.kubeconfig).users[0].user.exec;
  assert.equal(exec.command, "nebula-oidc-login");
  assert.ok(exec.args.includes(`--oidc-client-secret-file=${registration}`));
  assert.ok(!handoff.kubeconfig.includes(data.client_secret));
  for (const invalid of [{ ...data, client_id: "another-client" }, { ...data, issuer: "https://other.example.test" },
    { ...data, refresh_token: "synthetic-user-token" }, { ...data, client_secret: "" }]) {
    fs.writeFileSync(registration, JSON.stringify(invalid));
    assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcClientConfig: registration }), /Native OIDC/);
  }
  fs.writeFileSync(registration, JSON.stringify(data));
  for (const mode of [0o644, 0o700]) {
    fs.chmodSync(registration, mode);
    assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcClientConfig: registration }), /owner-only/);
  }
  fs.chmodSync(registration, 0o400);
  assert.doesNotThrow(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcClientConfig: registration }));
  fs.chmodSync(registration, 0o600); const alias = path.join(f.directory, "alias.json"); fs.symlinkSync(registration, alias);
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcClientConfig: alias }), /owner-only/);
  fs.writeFileSync(registration, JSON.stringify({ ...data, client_secret: "a".repeat(16 * 1024) }));
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcClientConfig: registration }), /at most 16 KiB/);
}));

test("invalid or mismatched input cannot create or overwrite profiles", () => fixture(f => {
  assert.equal(prepareOidcHandoff("mgmt", f.state, {}), undefined);
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { oidcKubeconfig: f.admin }), /require --oidc-config/);
  assert.throws(() => prepareOidcHandoff("different", f.state, f.options), /name the management cluster/);
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcKubeconfig: f.admin }), /must not replace/);
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcKubeconfig: f.config }), /must not replace/);
  const output = path.join(f.directory, "existing.yaml"); fs.writeFileSync(output, "another profile", { mode: 0o600 });
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcKubeconfig: output }), /Refusing to replace/);
  const alias = path.join(f.directory, "alias.yaml"); fs.symlinkSync(f.admin, alias);
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcKubeconfig: alias }), /Refusing to replace/);
  fs.writeFileSync(f.config, "malformed JSON");
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, f.options), /Cannot read valid local OIDC JSON/);
  assert.equal(fs.existsSync(path.join(f.state, "kubeconfig-oidc")), false);
  assert.equal(fs.readFileSync(f.admin, "utf8"), f.adminBytes);
}));

test("the handoff matches the native rendered authenticator and preserves CAPI pause metadata", () => fixture(f => {
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
  const handoff = prepareOidcHandoff("mgmt", f.state, f.options)!;
  assert.doesNotThrow(() => assertManagementOidc(manifests, "mgmt", handoff));
  assert.throws(() => assertManagementOidc(manifests, "mgmt"), /requires --oidc-config/);
  const other = identity(); other.workforce.audience = "other-client"; fs.writeFileSync(f.config, JSON.stringify(other));
  assert.throws(() => assertManagementOidc(manifests, "mgmt", prepareOidcHandoff("mgmt", f.state, f.options)), /does not match/);
  assert.equal(fs.readFileSync(file, "utf8"), bytes);
  assert.equal(fs.readFileSync(f.admin, "utf8"), f.adminBytes);
  const cp = objects.find(object => object.kind === "K0sControlPlane")!;
  delete cp.spec.k0sConfigSpec.k0s.spec.api.extraArgs["authentication-config"];
  fs.writeFileSync(file, objects.map(object => stringify(object)).join("---\n"));
  assert.throws(() => assertManagementOidc(manifests, "mgmt", handoff), /does not match/);
  assert.doesNotThrow(() => assertManagementOidc(manifests, "mgmt"));
}));

test("a private API endpoint can use a local public CA without enabling insecure TLS", () => fixture(f => {
  const ca = path.join(f.directory, "ca.pem"), key = path.join(f.directory, "fixture.key");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1",
    "-subj", "/CN=bootstrap-fixture", "-keyout", key, "-out", ca], { stdio: "ignore" });
  const handoff = prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcCaFile: ca })!;
  const cluster = parse(handoff.kubeconfig).clusters[0].cluster;
  assert.equal(Buffer.from(cluster["certificate-authority-data"], "base64").toString(), fs.readFileSync(ca, "utf8"));
  assert.equal(cluster["insecure-skip-tls-verify"], undefined);
  assert.throws(() => prepareOidcHandoff("mgmt", f.state, { ...f.options, oidcCaFile: key }), /only PEM certificates/);
}));
