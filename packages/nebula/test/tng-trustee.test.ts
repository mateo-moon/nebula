import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync } from "node:crypto";
import { App, Chart } from "cdk8s";
import { parse } from "smol-toml";
import { TngTrustee, tngTrusteePlan, tngTrusteeInitData, tngTrusteeClientPlan, type TngTrusteeConfig } from "../src";
import { denyPolicy, identity } from "./support/trustee";

const keys = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pair = keys();
const config = (): TngTrusteeConfig => ({ name: "trustee", namespace: "trustee-test",
  kbsImage: `example.test/kbs@sha256:${"a".repeat(64)}`, tngImage: `example.test/tng@sha256:${"b".repeat(64)}`,
  ownerPublicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
  nodeSelector: { "example.test/tee": "sev-snp" }, clients: [{ namespace: "owner", podLabels: { app: "client" } }] });

test("server boots independently with native owner authorization and guest-only storage", () => {
  const plan = tngTrusteePlan(config());
  const parsed = parse(plan.kbsConfig) as any;
  assert.deepEqual(parsed.http_server.sockets, ["127.0.0.1:8080"]);
  assert.equal(parsed.admin.authorization_mode, "AuthenticatedAuthorization");
  assert.equal(parsed.admin.authentication.bearer_jwt.identity_providers[0].issuer, "nebula-owner");
  assert.equal(parsed.admin.authentication.bearer_jwt.identity_providers[0].audience, "trustee");
  assert.equal(parsed.attestation_token.insecure_header_jwk, false);
  assert.equal(plan.pod.spec.runtimeClassName, "kata-qemu-snp");
  assert.equal(plan.pod.spec.automountServiceAccountToken, false);
  assert.ok(plan.pod.spec.volumes.every((volume: any) => volume.emptyDir?.medium === "Memory"));
  assert.equal(plan.pod.spec.containers.length, 2);
  const script = Buffer.from(plan.pod.spec.containers[0].args.join(""), "base64").toString();
  assert.doesNotMatch(script, /curl|cdh\/resource|BEGIN PRIVATE KEY/);
  assert.match(script, /openssl ecparam/);
});

test("private/extra key material, mutable images and default namespaces are rejected", () => {
  for (const update of [
    { ownerPublicKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString() },
    { ownerPublicKeyPem: config().ownerPublicKeyPem + "ignored trailing data" },
    { tngImage: "example.test/tng:latest" }, { kbsImage: "example.test/kbs:latest" },
    { namespace: "default" }, { nodeSelector: {} }, { clients: [] },
  ]) assert.throws(() => tngTrusteePlan({ ...config(), ...update }));
});

test("an altered owner identity or startup command cannot reuse an approved artifact", () => {
  const c = config(), plan = tngTrusteePlan(c);
  const artifact = tngTrusteeInitData(c, { canonicalPodSha256: plan.canonicalPodSha256, policyRego: denyPolicy });
  const changed = { ...c, ownerPublicKeyPem: keys().publicKey.export({ format: "pem", type: "spki" }).toString() };
  assert.throws(() => new TngTrustee(new Chart(new App(), "bad"), "trustee", { ...changed, policy: artifact }));
  assert.throws(() => tngTrusteeInitData(c, { canonicalPodSha256: "0".repeat(64), policyRego: denyPolicy }));
  const chart = new Chart(new App(), "good"); new TngTrustee(chart, "trustee", { ...c, policy: artifact });
  const service = chart.toJson().find((resource: any) => resource.kind === "Service");
  assert.deepEqual(service.spec.ports.map((port: any) => port.port), [8443]);
});

test("host exec, stream access and mutable guest policy are rejected before deployment", () => {
  const c = config(), plan = tngTrusteePlan(c);
  for (const rpc of ["ExecProcessRequest", "ReadStreamRequest", "SetPolicyRequest"]) {
    assert.throws(() => tngTrusteeInitData(c, { canonicalPodSha256: plan.canonicalPodSha256,
      policyRego: denyPolicy + `\n${rpc} if { true }\n` }));
  }
});

test("client uses local mainline verification with exact VM/workload approval and no trust bypass", () => {
  const plan = tngTrusteeClientPlan(identity(), { host: "127.0.0.1", port: 18443 });
  assert.match(plan.policy, /ev\.init_data == identity\.initDataSha256/);
  assert.match(plan.policy, /ev\.snp\.measurement == identity\.measurement/);
  assert.match(plan.policy, /ev\.snp\.policy_debug_allowed == false/);
  assert.deepEqual(plan.tngConfig.add_ingress[0].verify.policy_ids, ["approved"]);
  assert.equal(plan.tngConfig.add_ingress[0].verify.as_addr, "http://127.0.0.1:18082");
  assert.deepEqual(plan.tngConfig.add_ingress[0].verify.trusted_certs_paths, ["/state/ca.pem"]);
  assert.doesNotMatch(JSON.stringify(plan), /skip_as_token_cert_verify|trust_all|hardware_only/);
  assert.throws(() => tngTrusteeClientPlan({ ...identity(), initDataSha256: "" }, { host: "localhost", port: 8443 }));
  assert.equal(tngTrusteeClientPlan(identity(), { host: "trustee.example.test", port: 443 }).tngConfig.add_ingress[0].mapping.out.port, 443);
  assert.throws(() => tngTrusteeClientPlan(identity(), { host: "localhost", port: 8443 }, 443));
});
