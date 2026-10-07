import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Testing } from "cdk8s";
import {
  AwsKubernetesOidcPublication, AwsKubernetesOidcPublicationSetup,
  KUBERNETES_OIDC_PUBLICATION_TEMPLATE,
} from "../src/modules/infra/aws/kubernetes-oidc-publication";

const dir = mkdtempSync(join(tmpdir(), "oidc-template-"));
const binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, "."], {
  cwd: fileURLToPath(new URL("./support/oidc-template", import.meta.url)),
  env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-oidc-go-cache"), GOTOOLCHAIN: "local" }, timeout: 120000,
});
after(() => rmSync(dir, { recursive: true, force: true }));
const chart = Testing.chart();
new AwsKubernetesOidcPublicationSetup(chart, "setup");
const config = {
  name: "test-oidc", bucketName: "example-retained-oidc", region: "eu-central-1", accountId: "123456789012",
  issuerUrl: "https://example-retained-oidc.s3.eu-central-1.amazonaws.com",
  sourceSecretName: "child-kubeconfig", sourceSecretNamespace: "clusters",
};
new AwsKubernetesOidcPublication(chart, "publication", config);
const manifests = Testing.synth(chart);
const xr = manifests.find(r => r.kind === "XAwsKubernetesOidcPublication")!;
const healthy = { conditions: [{ type: "Ready", status: "True" }, { type: "Synced", status: "True" }] };
const encode = (s: string) => Buffer.from(s).toString("base64");
const ca = encode("-----BEGIN CERTIFICATE-----\nfixture-ca\n-----END CERTIFICATE-----");
const cert = encode("-----BEGIN CERTIFICATE-----\nfixture-cert\n-----END CERTIFICATE-----");
const key = encode("-----BEGIN PRIVATE KEY-----\nfixture-private\n-----END PRIVATE KEY-----");
// Put the active context second to catch accidental index-0 credential selection.
const kubeconfig = {
  "current-context": "active",
  contexts: [{ name: "other", context: { cluster: "other", user: "other" } }, { name: "active", context: { cluster: "child", user: "admin" } }],
  clusters: [{ name: "other", cluster: { server: "https://wrong.example.test" } },
    { name: "child", cluster: { server: "https://child.example.test:6443", "certificate-authority-data": ca } }],
  users: [{ name: "other", user: {} }, { name: "admin", user: { "client-certificate-data": cert, "client-key-data": key } }],
};
const publicKey = (kid: string) => ({
  ...generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "jwk" }), kid, alg: "RS256", use: "sig",
});
const first = publicKey("initial-key");
const second = publicKey("rotated-key");
function observations(jwks: unknown = { keys: [first] }): Record<string, any> {
  return {
    kubeconfig: { resource: { status: { ...healthy, atProvider: { manifest: {
      apiVersion: "v1", kind: "Secret", metadata: { name: config.sourceSecretName, namespace: config.sourceSecretNamespace },
      data: { value: encode(JSON.stringify(kubeconfig)) },
    } } } } },
    jwks: { resource: { status: { ...healthy, response: { statusCode: 200, body: JSON.stringify(jwks) },
      requestDetails: { method: "GET", url: "https://child.example.test:6443/openid/v1/jwks" } } } },
    bucket: { resource: { status: healthy } },
    "public-access": { resource: { status: healthy } },
    versioning: { resource: { spec: { forProvider: { bucket: config.bucketName, expectedBucketOwner: config.accountId } },
      status: { ...healthy, atProvider: { versioningConfiguration: [{ status: "Enabled" }] } } } },
    policy: { resource: { status: healthy } },
  };
}
function render(resources: Record<string, any>, composite = xr): any[] {
  const out = execFileSync(binary, [], { input: JSON.stringify({ template: KUBERNETES_OIDC_PUBLICATION_TEMPLATE,
    data: { observed: { composite: { resource: composite }, resources } } }), encoding: "utf8" });
  return out.split(/^---$/m).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
}
const objects = (resources: any[]) => resources.filter(r => r.kind === "Object" && r.apiVersion.startsWith("s3."));
const named = (resources: any[], name: string) => resources.find(r => r.metadata?.annotations?.["gotemplating.fn.crossplane.io/composition-resource-name"] === name)!;
const publicationReady = (resources: any[]) => resources.find(r => r.kind === "XAwsKubernetesOidcPublication")?.status.publicationReady;

test("setup installs the actual tested template and immutable issuer identity", () => {
  const composition = manifests.find(r => r.kind === "Composition")!;
  assert.equal(composition.spec.pipeline[0].input.inline.template, KUBERNETES_OIDC_PUBLICATION_TEMPLATE);
  const schema = manifests.find(r => r.kind === "CompositeResourceDefinition")!.spec.versions[0].schema.openAPIV3Schema;
  assert.equal(schema.properties.spec["x-kubernetes-validations"].length, 6);
  for (const override of [{ issuerUrl: "http://issuer.test" }, { issuerUrl: `${config.issuerUrl}/` }, { accountId: "wrong" }, { apiServerUrl: "https://user:password@api.test" }]) {
    assert.throws(() => new AwsKubernetesOidcPublication(Testing.chart(), "bad", { ...config, ...override }));
  }
});

test("initial missing observation is unready and cannot publish or recreate a retained bucket", () => {
  const result = render({});
  assert.equal(objects(result).length, 0);
  assert.equal(publicationReady(result), false);
  assert.equal(named(result, "kubeconfig").metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
  assert.deepEqual(named(result, "bucket").spec.managementPolicies, ["Observe"]);
  assert.equal(named(result, "public-access"), undefined);
  assert.equal(named(result, "policy"), undefined);
  for (const r of result.filter(r => r.apiVersion.startsWith("s3."))) {
    assert.equal(r.spec.deletionPolicy, "Orphan");
    assert.ok(!r.spec.managementPolicies.includes("Delete"));
  }
});

test("fresh bucket creation requires an explicit declaration and never enables deletion", () => {
  const fresh = structuredClone(xr);
  fresh.spec.createBucket = true;
  const bucket = named(render({}, fresh), "bucket");
  assert.ok(bucket.spec.managementPolicies.includes("Create"));
  assert.ok(!bucket.spec.managementPolicies.includes("Delete"));
  assert.equal(bucket.spec.deletionPolicy, "Orphan");
  assert.equal(bucket.spec.forProvider.forceDestroy, false);
});

test("selected kubeconfig context becomes an mTLS secret; requests are GET only with verified TLS", () => {
  const result = render(observations());
  assert.deepEqual(named(result, "api-tls").data, { "ca.crt": ca, "tls.crt": cert, "tls.key": key });
  const request = named(result, "jwks");
  assert.equal(request.spec.forProvider.payload.baseUrl, "https://child.example.test:6443/openid/v1/jwks");
  assert.deepEqual(request.spec.managementPolicies, ["Observe", "Create"]);
  assert.ok(request.spec.forProvider.mappings.every((m: any) => m.method === "GET"));
  assert.deepEqual(Object.keys(request.spec.forProvider.tlsConfig).sort(), ["caCertSecretRef", "clientCertSecretRef", "clientKeySecretRef"]);
  assert.ok(!JSON.stringify(request).includes(key));
  assert.ok(!JSON.stringify(objects(result)).includes(key));
});

test("insecure, missing, or mismatched kubeconfig credentials cannot publish", () => {
  for (const mutate of [
    (c: any) => { c["current-context"] = "absent"; },
    (c: any) => { c.clusters[1].cluster["insecure-skip-tls-verify"] = true; },
    (c: any) => { delete c.users[1].user["client-key-data"]; },
    (c: any) => { c.clusters[1].cluster.server = "http://child.example.test"; },
    (c: any) => { c.clusters[1].cluster["certificate-authority-data"] = encode("invalid"); },
  ]) {
    const source = structuredClone(kubeconfig); mutate(source);
    const observed = observations();
    observed.kubeconfig.resource.status.atProvider.manifest.data.value = encode(JSON.stringify(source));
    const result = render(observed);
    assert.equal(named(result, "api-tls"), undefined);
    assert.equal(named(result, "jwks"), undefined);
    assert.equal(objects(result).length, 0);
  }
  const observed = observations();
  observed.kubeconfig.resource.status.atProvider.manifest.metadata.name = "wrong-cluster";
  assert.equal(objects(render(observed)).length, 0);
});

test("certificate rotation refreshes secret data without embedding it in request specs", () => {
  const original = render(observations());
  const source = structuredClone(kubeconfig);
  const rotated = encode("-----BEGIN CERTIFICATE-----\nrotated-client\n-----END CERTIFICATE-----");
  source.users[1].user["client-certificate-data"] = rotated;
  const observed = observations();
  observed.kubeconfig.resource.status.atProvider.manifest.data.value = encode(JSON.stringify(source));
  const updated = render(observed);
  assert.equal(named(updated, "api-tls").data["tls.crt"], rotated);
  assert.deepEqual(named(updated, "api-tls").metadata, named(original, "api-tls").metadata);
  assert.deepEqual(named(updated, "jwks"), named(original, "jwks"));
});

test("valid public JWKS publishes the exact issuer and narrowly scoped HTTPS policy", () => {
  const result = render(observations());
  assert.equal(publicationReady(result), true);
  assert.equal(objects(result).length, 2);
  assert.deepEqual(JSON.parse(named(result, "keys").spec.forProvider.content), { keys: [first] });
  assert.deepEqual(JSON.parse(named(result, "discovery").spec.forProvider.content), {
    issuer: config.issuerUrl, jwks_uri: `${config.issuerUrl}/keys.json`, response_types_supported: ["id_token"],
    subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
  });
  assert.deepEqual(JSON.parse(named(result, "policy").spec.forProvider.policy), {
    Version: "2012-10-17", Statement: [{ Sid: "PublicOidcDiscovery", Effect: "Allow", Principal: "*", Action: "s3:GetObject",
      Resource: [`arn:aws:s3:::${config.bucketName}/.well-known/openid-configuration`, `arn:aws:s3:::${config.bucketName}/keys.json`],
      Condition: { Bool: { "aws:SecureTransport": "true" } } }],
  });
  for (const r of objects(result)) {
    assert.equal(r.spec.forProvider.contentType, "application/json");
    assert.equal(r.spec.forProvider.cacheControl, "max-age=300");
    assert.equal(r.spec.deletionPolicy, "Orphan");
    assert.ok(!r.spec.managementPolicies.includes("Delete"));
  }
});

test("rotation updates stable object identities and supports overlap then old-key removal", () => {
  const initial = render(observations());
  for (const keys of [[first, second], [second]]) {
    const rotated = render(observations({ keys }));
    assert.deepEqual(named(rotated, "keys").metadata, named(initial, "keys").metadata);
    assert.deepEqual(JSON.parse(named(rotated, "keys").spec.forProvider.content), { keys });
    assert.notEqual(named(rotated, "keys").spec.forProvider.sourceHash, named(initial, "keys").spec.forProvider.sourceHash);
    assert.deepEqual(named(rotated, "discovery"), named(initial, "discovery"));
  }
});

test("non-public, malformed, oversized, duplicate and weak JWKS fail closed", () => {
  const invalid = [null, [], {}, { keys: [] }, { keys: [first], extra: true }, { keys: [first, first] },
    { keys: Array.from({ length: 9 }, (_, i) => ({ ...first, kid: `key${i}` })) },
    ...[{ d: "private" }, { k: "symmetric-secret" }, { x5c: ["certificate"] }, { alg: "none" }, { use: "enc" },
      { kid: "invalid kid" }, { kty: "EC" }, { n: "AQAB" }, { e: "AQAB=" }, { n: `${first.n}=` },
      { n: encode("\0".repeat(256)).replace(/=+$/, "") }, { e: 65537 }].map(patch => ({ keys: [{ ...first, ...patch }] })),
    { keys: ["string"] }, { keys: [{ ...first, n: "A".repeat(17000) }] },
  ];
  for (const jwks of invalid) {
    const result = render(observations(jwks));
    assert.equal(objects(result).length, 0);
    assert.equal(publicationReady(result), false);
  }
  const badJson = observations();
  badJson.jwks.resource.status.response.body = "{broken";
  assert.equal(objects(render(badJson)).length, 0);
});

test("RSA modulus bounds and canonical odd public exponents are enforced", () => {
  const modulus = (bytes: number, head: number) => {
    const value = Buffer.alloc(bytes, 0x35); value[0] = head;
    return value.toString("base64url");
  };
  for (const n of [modulus(256, 128), modulus(384, 128), modulus(1024, 128)])
    assert.equal(objects(render(observations({ keys: [{ ...first, n, e: "Aw" }] }))).length, 2);
  for (const n of [modulus(255, 255), modulus(256, 127), modulus(1025, 128), modulus(257, 0)])
    assert.equal(objects(render(observations({ keys: [{ ...first, n }] }))).length, 0);
  for (const e of ["AQ", "Ag", "BA", "AAMB", "gAAAAQ"])
    assert.equal(objects(render(observations({ keys: [{ ...first, e }] }))).length, 0);
});

test("unhealthy HTTP, wrong endpoint and missing bucket safeguards cannot publish", () => {
  for (const mutate of [
    (r: any) => { r.jwks.resource.status.conditions[1].status = "False"; },
    (r: any) => { r.jwks.resource.status.response.statusCode = 403; },
    (r: any) => { r.jwks.resource.status.requestDetails.url = "https://other.example.test/openid/v1/jwks"; },
    (r: any) => { r.versioning.resource.status.atProvider.versioningConfiguration[0].status = "Suspended"; },
    (r: any) => { r.versioning.resource.spec.forProvider.expectedBucketOwner = "999999999999"; },
    (r: any) => { r.kubeconfig.resource.status.conditions[1].status = "False"; },
    ...["bucket", "public-access", "versioning", "policy", "kubeconfig", "jwks"].map(key => (r: any) => { delete r[key]; }),
  ]) {
    const observed = structuredClone(observations()); mutate(observed);
    const result = render(observed);
    assert.equal(objects(result).length, 0);
    assert.equal(publicationReady(result), false);
  }
});

test("transient failures preserve both last valid documents while remaining unready", () => {
  const previous = render(observations());
  const retained = Object.fromEntries(previous.filter(r => r.metadata).map(r => [r.metadata.annotations["gotemplating.fn.crossplane.io/composition-resource-name"], { resource: r }]));
  const result = render(retained);
  assert.deepEqual(objects(result), objects(previous));
  assert.deepEqual(named(result, "api-tls"), named(previous, "api-tls"));
  assert.equal(publicationReady(result), false);
  const invalid = { ...retained, ...observations({ keys: [{ ...first, d: "private" }] }) };
  assert.deepEqual(objects(render(invalid)), objects(previous));
});
