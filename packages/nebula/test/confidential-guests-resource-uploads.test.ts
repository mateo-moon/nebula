import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import { parse } from "smol-toml";
import { AttestedPullBroker, type AttestedPullBrokerProps } from "../src/modules/k8s/confidential-guests";
import { synthOf } from "./support/cdk8s-render";
import { initData, measurement, snpAdmission } from "./support/snp-broker";

const authority = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKeyPem = authority.publicKey.export({ type: "spki", format: "pem" }).toString();
const props: AttestedPullBrokerProps = {
  namespace: "guests", name: "kbs", configMapName: "kbs-config",
  networkPolicyNames: { ingressBoundary: "deny", fromGuests: "guest" },
  podLabels: { app: "kbs" }, guestSelector: { app: "guest" }, nodeName: "host",
  brokerImage: `example.test/kbs@sha256:${"a".repeat(64)}`, issuer: "ephemeral",
  configToml: `[storage_backend]\nstorage_type="LocalFs"\n[storage_backend.backends.local_fs]\ndir_path="/state"\n[attestation_service]\ntype="coco_as_builtin"\n[attestation_service.attestation_token_broker.signer]\nkey_path="/state/issuer/key.pem"\ncert_path="/state/issuer/cert.pem"\n[attestation_token]\ninsecure_header_jwk=false\ntrusted_certs_paths=["/state/issuer/cert.pem"]\n[admin]\nauthorization_mode="DenyAll"\n`,
  resourcePath: ["default", "key", "fixture"], additionalResources: [{ resourcePath: ["default", "tls", "key"], secretKey: "key.pem" }],
  initData, measurement, snpAdmission, pullSecret: { name: "resources", exposeAsResource: true }, labelDomain: "guests.test",
  resourceUploads: { claimName: "uploaded-keys", paths: [["default", "key", "image.v1"]], publicKeyPem, issuer: "owner", audience: "dev-kbs" },
};
const render = (p = props) => synthOf(chart => new AttestedPullBroker(chart, "kbs", p)).objects;

test("uploads use exact native JWT ACLs and persistent keys; measured policies and sealed TLS remain immutable", () => {
  const resources = render();
  const cm = resources.find(r => r.kind === "ConfigMap")!;
  const config: any = JSON.parse(JSON.stringify(parse(cm.data["config.toml"])));
  assert.equal(config.admin.authorization_mode, "AuthenticatedAuthorization");
  const rule = config.admin.authorization.regex_acl.acls[0];
  assert.deepEqual(rule, { role: "image-uploader", allowed_endpoints: '^/kbs/v0/resource/(default/key/image\\.v1)$' });
  const re = new RegExp(rule.allowed_endpoints);
  assert.ok(re.test("/kbs/v0/resource/default/key/image.v1"));
  for (const path of ["/kbs/v0/resource-policy", "/kbs/v0/attestation-policy", "/kbs/v0/resource/default/tls/key",
    "/kbs/v0/resource/default/key/fixture", "/kbs/v0/resource/default/key/imageXv1", "/kbs/v0/resource/default/key/image.v1?x=1"]) assert.ok(!re.test(path));
  assert.deepEqual(config.admin.authentication.bearer_jwt.identity_providers, [{ issuer: "owner", audience: "dev-kbs", public_key_uri: "/configuration/upload-public.pem" }]);
  const pod = resources.find(r => r.kind === "Deployment")!.spec.template.spec;
  assert.deepEqual(pod.volumes.find((v: any) => v.name === "uploaded-resources"), { name: "uploaded-resources", persistentVolumeClaim: { claimName: "uploaded-keys" } });
  const mounts = pod.containers[0].volumeMounts;
  assert.ok(mounts.find((m: any) => m.name === "policy").readOnly);
  assert.ok(mounts.find((m: any) => m.subPath === "default_cpu.rego").readOnly);
  assert.ok(mounts.filter((m: any) => m.name === "registry-resource").every((m: any) => m.readOnly && m.subPath));
  assert.ok(cm.data["resource-policy.rego"].includes(measurement.value));
  assert.ok(cm.data["resource-policy.rego"].includes(initData.value));
  assert.ok(cm.data["resource-policy.rego"].includes('["default", "key", "image.v1"]'));
});

test("uploads reject missing SNP protections, collisions, wildcard paths and private authority keys", () => {
  for (const change of [
    { snpAdmission: undefined }, { resourceUploads: { ...props.resourceUploads!, paths: [props.resourcePath] } },
    { resourceUploads: { ...props.resourceUploads!, paths: [["default", "key", "*"]] } },
    { resourceUploads: { ...props.resourceUploads!, paths: [] } },
    { resourceUploads: { ...props.resourceUploads!, publicKeyPem: authority.privateKey.export({ type: "pkcs8", format: "pem" }).toString() } },
    { configToml: props.configToml.replace("DenyAll", "InsecureAllowAll") },
  ]) assert.throws(() => render({ ...props, ...change } as AttestedPullBrokerProps));
});
