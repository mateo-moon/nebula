import assert from "node:assert/strict";
import test from "node:test";
import {
  AttestedPullBroker, pullBrokerAppraisalPolicy, pullBrokerPolicy, sha256Hex,
  type AttestedPullBrokerProps, type SnpBrokerAdmission,
} from "../src/modules/k8s/confidential-guests";
import { synthOf } from "./support/cdk8s-render";
import { configToml, initData, measurement, resourcePath, snpAdmission, snpBrokerProps } from "./support/snp-broker";

const render = (change: Partial<AttestedPullBrokerProps> = {}) =>
  synthOf(chart => new AttestedPullBroker(chart, "broker", snpBrokerProps(change))).objects;

test("strict SNP admission mounts both policies read-only and rolls on every acceptance input", () => {
  const objects = render();
  const config = objects.find(o => o.kind === "ConfigMap");
  const deployment = objects.find(o => o.kind === "Deployment");
  const pod = deployment.spec.template.spec;
  assert.equal(config.data["default_cpu.rego"], pullBrokerAppraisalPolicy(initData, measurement, snpAdmission));
  assert.equal(config.data["resource-policy.rego"], pullBrokerPolicy(resourcePath, initData, measurement, snpAdmission));
  assert.equal(deployment.spec.template.metadata.annotations["guests.example.com/config-sha256"],
    sha256Hex(config.data["resource-policy.rego"] + configToml + config.data["default_cpu.rego"]));
  assert.ok(pod.containers[0].volumeMounts.some((m: any) => m.name === "configuration" && m.readOnly === true
    && m.mountPath === "/state/attestation_service_policy/default_cpu.rego" && m.subPath === "default_cpu.rego"));
  assert.ok(pod.containers[0].volumeMounts.some((m: any) => m.name === "policy" && m.readOnly === true && m.mountPath === "/state/kbs"));
  assert.deepEqual(pod.initContainers[0].volumeMounts, [{ name: "state", mountPath: "/state" }]);
  for (const component of Object.keys(snpAdmission.minimumReportedTcb)) {
    const changed = render({ snpAdmission: { minimumReportedTcb: {
      ...snpAdmission.minimumReportedTcb, [component]: 255,
    } } });
    const updated = changed.find(o => o.kind === "ConfigMap").data;
    for (const policy of ["resource-policy.rego", "default_cpu.rego"]) assert.notEqual(updated[policy], config.data[policy], component);
    assert.notEqual(changed.at(-1).spec.template.metadata.annotations["guests.example.com/config-sha256"],
      deployment.spec.template.metadata.annotations["guests.example.com/config-sha256"], component);
  }
});

test("omitting strict admission preserves the old mode and does not install an appraisal policy", () => {
  const objects = render({ snpAdmission: undefined });
  const data = objects.find(o => o.kind === "ConfigMap").data;
  assert.deepEqual(Object.keys(data).sort(), ["config.toml", "resource-policy.rego"]);
  assert.equal(data["resource-policy.rego"], pullBrokerPolicy(resourcePath, initData, measurement));
  assert.equal(objects.at(-1).spec.template.metadata.annotations["guests.example.com/config-sha256"],
    sha256Hex(data["resource-policy.rego"] + configToml));
});

test("every TCB floor must be explicitly provided as a byte; no unknown claims or implicit zero", () => {
  for (const component of Object.keys(snpAdmission.minimumReportedTcb)) {
    for (const value of [undefined, null, "1", true, -1, 256, 1.5, NaN, Infinity]) {
      const invalid = { minimumReportedTcb: { ...snpAdmission.minimumReportedTcb, [component]: value } } as SnpBrokerAdmission;
      assert.throws(() => render({ snpAdmission: invalid }), /must be an integer/, `${component} ${value}`);
      assert.throws(() => pullBrokerPolicy(resourcePath, initData, measurement, invalid), /must be an integer/);
      assert.throws(() => pullBrokerAppraisalPolicy(initData, measurement, invalid), /must be an integer/);
    }
    assert.doesNotThrow(() => render({ snpAdmission: { minimumReportedTcb: { ...snpAdmission.minimumReportedTcb, [component]: 0 } } }));
  }
  for (const value of [null, {}, { minimumReportedTcb: null }, { ...snpAdmission, chipId: "unsupported" },
    { minimumReportedTcb: { ...snpAdmission.minimumReportedTcb, fmc: 0 } }]) {
    assert.throws(() => render({ snpAdmission: value as any }), /must be an object|unknown field/);
  }
  assert.throws(() => render({ measurement: undefined }), /requires measurement/);
});

test("strict admission refuses configurations which bypass the installed policy or local issuer", () => {
  const invalid = [
    "not valid toml",
    configToml.replace("coco_as_builtin", "coco_as_grpc"),
    configToml.replace('[attestation_service]\n', '[attestation_service]\nstorage_type = "Memory"\n'),
    configToml.replace('storage_type = "LocalFs"', 'storage_type = "Memory"'),
    configToml.replace('dir_path = "/state"', 'dir_path = "/different"'),
    configToml.replace("insecure_header_jwk = false", "insecure_header_jwk = true"),
    configToml.replace('[attestation_token]\n', '[attestation_token]\ntrusted_jwk_sets = ["https://other.example.com/keys"]\n'),
    configToml.replace('[attestation_token]\n', '[attestation_token]\nextra_teekey_paths = ["/unbound-key"]\n'),
    configToml.replace('trusted_certs_paths = ["/state/issuer/cert.pem"]', 'trusted_certs_paths = ["/state/issuer/cert.pem", "/other.pem"]'),
    configToml.replace('key_path = "/state/issuer/key.pem"', 'key_path = "/other/key.pem"'),
    configToml.replace('cert_path = "/state/issuer/cert.pem"', 'cert_path = "/other/cert.pem"'),
    configToml.replace('[attestation_service.attestation_token_broker.signer]\n',
      '[attestation_service.attestation_token_broker.signer]\ncert_url = "https://other.example.com/cert"\n'),
    configToml.replace('authorization_mode = "DenyAll"', 'authorization_mode = "AllowAll"'),
  ];
  for (const value of invalid) assert.throws(() => render({ configToml: value }), /snpAdmission requires/);
  assert.throws(() => render({ issuer: undefined, initImage: snpBrokerProps().brokerImage, initCommand: ["/bin/true"] }), /requires the ephemeral issuer/);
});
