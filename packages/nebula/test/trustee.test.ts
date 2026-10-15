import assert from "node:assert/strict";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "smol-toml";
import { Trustee, trusteePlan, trusteeInitData, trusteeBootstrapPolicies, trusteePolicies,
  TRUSTEE_STARTUP_METADATA_POLICY, TRUSTEE_DENIED_AGENT_REQUESTS } from "../src/modules/k8s/trustee";
import { initDataDocument, type MeasuredArtifact } from "../src/modules/k8s/confidential-guests/measured";
import { sha256Hex } from "../src/modules/k8s/confidential-guests/canonical";
import { synthOf } from "./support/cdk8s-render";
import { denyPolicy, identity, testArtifact, trusteeConfig } from "./support/trustee";

test("Trustee composes native KBS/AS in one measured SNP guest without host secrets or storage", () => {
  const config = trusteeConfig();
  const plan = trusteePlan(config);
  const policy = testArtifact(config);
  const { objects, yaml } = synthOf(chart => new Trustee(chart, "trustee", { ...config, policy }));
  assert.deepEqual(objects.map(object => object.kind).sort(), ["Deployment", "Namespace", "NetworkPolicy", "Service"]);
  const deployment = objects.find(object => object.kind === "Deployment");
  assert.equal(deployment.spec.replicas, 1);
  assert.deepEqual(deployment.spec.strategy, { type: "Recreate" });
  assert.equal(deployment.spec.template.metadata.annotations["io.katacontainers.config.hypervisor.cc_init_data"], policy.ccInitData);
  const pod = deployment.spec.template.spec;
  assert.deepEqual(pod, plan.pod.spec);
  assert.equal(pod.runtimeClassName, "kata-qemu-snp");
  assert.equal(pod.automountServiceAccountToken, false);
  assert.equal(pod.enableServiceLinks, false);
  assert.equal(pod.containers.length, 1);
  assert.ok(pod.volumes.every((volume: any) => volume.emptyDir.medium === "Memory"));
  assert.equal(pod.securityContext.runAsNonRoot, true);
  assert.equal(pod.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.doesNotMatch(yaml, /hostPath:|persistentVolumeClaim:|secretKeyRef:|secretName:|privileged:|BEGIN PRIVATE KEY/);
  assert.deepEqual(plan.workload.spec, { ...deployment.spec, template: {
    ...deployment.spec.template, metadata: { ...deployment.spec.template.metadata,
      annotations: plan.pod.metadata!.annotations },
  } });
  const service = objects.find(object => object.kind === "Service");
  assert.equal(service.spec.type, "ClusterIP");
  assert.deepEqual(service.spec.ports, [{ name: "https", port: 8443, targetPort: 8443, protocol: "TCP" }]);
  const network = objects.find(object => object.kind === "NetworkPolicy");
  assert.deepEqual(network.spec.ingress[0].from[0], {
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "workloads" } },
    podSelector: { matchLabels: { app: "confidential-worker" } },
  });
});

test("native configuration disables admin and forged-token paths and uses local AS/RVPS", () => {
  const plan = trusteePlan(trusteeConfig());
  const toml: any = JSON.parse(JSON.stringify(parse(plan.configToml)));
  assert.equal(toml.admin.authorization_mode, "DenyAll");
  assert.equal(toml.http_server.insecure_http, false);
  assert.equal(toml.http_server.tls_profile, "modern");
  assert.equal(toml.attestation_service.type, "coco_as_builtin");
  assert.equal(toml.attestation_service.rvps_config.type, "BuiltIn");
  assert.deepEqual(toml.attestation_service.policy_id_map, {});
  assert.equal(toml.attestation_token.insecure_header_jwk, false);
  assert.deepEqual(toml.attestation_token.trusted_jwk_sets, []);
  assert.equal(toml.attestation_token.trusted_certs_paths[0], toml.attestation_service.attestation_token_broker.signer.cert_path);
  assert.equal(toml.session_storage_type, "Memory");
  assert.equal(toml.storage_backend.backends.local_fs.dir_path, "/run/trustee/current/storage");
  assert.deepEqual(toml.plugins, [{ name: "resource", storage_backend_type: "kvstorage" }]);
});

test("Init-Data binds the exact bootstrap identity and changes with public policy inputs", () => {
  const config = trusteeConfig();
  const policy = testArtifact(config);
  const decoded: any = parse(initDataDocument(policy.ccInitData).toString("utf8"));
  assert.equal(sha256Hex(initDataDocument(policy.ccInitData)), policy.initDataSha256);
  assert.equal(decoded.algorithm, "sha256");
  assert.equal((parse(decoded.data["cdh.toml"]) as any).kbc.kbs_cert, config.bootstrap.certificatePem);
  assert.equal((parse(decoded.data["aa.toml"]) as any).token_configs.kbs.url, config.bootstrap.url);
  assert.equal((parse(decoded.data["aa.toml"]) as any).token_configs.kbs.tee_key_algorithm, "ECDH-ES+A256KW-P256");
  assert.equal((parse(decoded.data["aa.toml"]) as any).log.level, "off");
  assert.equal((parse(decoded.data["cdh.toml"]) as any).log.level, "off");
  const changed = structuredClone(config);
  (changed.resources[0].recipients[0] as any).measurement = "f".repeat(96);
  assert.notEqual(testArtifact(changed).initDataSha256, policy.initDataSha256);
  assert.throws(() => synthOf(chart => new Trustee(chart, "trustee", { ...changed, policy })), /template changed/);
  assert.throws(() => trusteeInitData(changed, { canonicalPodSha256: policy.canonicalPodSha256, policyRego: denyPolicy }), /Pod changed/);
  const edit = (change: (doc: any) => void): MeasuredArtifact => {
    const doc = structuredClone(decoded); change(doc);
    const text = stringify(doc);
    return { ...policy, ccInitData: gzipSync(text).toString("base64"), initDataSha256: sha256Hex(text) };
  };
  for (const altered of [
    edit(doc => { doc.data["cdh.toml"] = doc.data["cdh.toml"].replace("https:", "http:"); }),
    edit(doc => { doc.data["aa.toml"] += "\n[unexpected]\nenabled = true\n"; }),
    edit(doc => { doc.data["extra.toml"] = "extra = true"; }),
  ]) assert.throws(() => synthOf(chart => new Trustee(chart, "trustee", { ...config, policy: altered })), /exact bootstrap/);
});

test("unsafe native configuration is refused during composition", () => {
  const reject = (change: (config: any) => void) => {
    const config = trusteeConfig(); change(config); assert.throws(() => trusteePlan(config), /Trustee:/);
  };
  reject(config => { config.image = "registry.example.test/trustee:latest"; });
  reject(config => { config.namespace = "default"; });
  reject(config => { config.bootstrap.url = "http://bootstrap.example.test"; });
  reject(config => { config.bootstrap.url = "https://user:password@bootstrap.example.test"; });
  reject(config => { config.bootstrap.url = "https://bootstrap.example.test/path"; });
  reject(config => { config.bootstrap.url = "https://trustee.confidential-keys.svc.cluster.local"; });
  reject(config => { config.bootstrap.url = "https://127.0.0.1:8443"; });
  reject(config => { config.bootstrap.certificatePem = "not a certificate"; });
  reject(config => { config.bootstrap.certificatePem += config.bootstrap.certificatePem; });
  reject(config => { config.bootstrap.certificatePem += "\ntrailing data"; });
  reject(config => { config.bootstrap.tlsPrivateKey = ["owner", "tls", "../../key"]; });
  reject(config => { config.resources[0].bootstrapPath = config.bootstrap.tlsPrivateKey; });
  reject(config => { config.resources[0].recipients = []; });
  reject(config => { delete config.resources[0].recipients[0].minimumReportedTcb.snp; });
  reject(config => { config.resources[0].recipients[0].minimumReportedTcb.tee = "1"; });
  reject(config => { config.resources[0].recipients[0].measurement = "0".repeat(96); });
  reject(config => { delete config.resources[0].recipients[0].chipId; });
  reject(config => { config.clients = []; });
  reject(config => { config.clients[0].podLabels = {}; });
  reject(config => { config.nodeSelector = {}; });
  reject(config => { config.port = 8006; });
  reject(config => { config.guestMemoryMiB = 512; });
  reject(config => { config.endpointHost = "example.test;evil"; });
});

test("guest policy source gate refuses exec, readback, policy mutation, swap and arbitrary copies", () => {
  const config = trusteeConfig();
  const build = (policyRego: string) => trusteeInitData(config, {
    canonicalPodSha256: trusteePlan(config).canonicalPodSha256, policyRego,
  });
  build(denyPolicy + TRUSTEE_STARTUP_METADATA_POLICY);
  build(denyPolicy + '\n# ExecProcessRequest := true\nmessage := "# ExecProcessRequest := true"\n');
  for (const request of TRUSTEE_DENIED_AGENT_REQUESTS) {
    assert.throws(() => build(denyPolicy.replace(`default ${request} := false`, `default ${request} := true`)), /unconditionally deny/);
    assert.throws(() => build(denyPolicy + `\n${request} if { true }\n`), /unconditionally deny/);
  }
  assert.throws(() => build("package agent_policy\ndefault CreateContainerRequest := true\n"), /deny container creation/);
  assert.throws(() => build(denyPolicy + "\nCopyFileRequest if { true }\n"), /bounded startup/);
  assert.throws(() => build(denyPolicy + TRUSTEE_STARTUP_METADATA_POLICY.replace("65536", "999999")), /bounded startup/);
});

test("bootstrap admission admits only the Trustee release to its own bootstrap paths", () => {
  const config = trusteeConfig();
  const policy = testArtifact(config);
  const result = trusteeBootstrapPolicies(config, policy, identity(3));
  assert.ok(result.resourcePolicy.includes(policy.initDataSha256));
  assert.ok(result.resourcePolicy.includes(identity(3).measurement));
  assert.ok(!result.resourcePolicy.includes(identity().measurement));
  assert.ok(result.resourcePolicy.includes('"key-v1"'));
  assert.equal((result.resourcePolicy.match(/"recipients"/g) ?? []).length, 3);
  assert.throws(() => trusteePolicies([{ path: ["a", "b", "c"], recipients: [identity()] },
    { path: ["a", "b", "c"], recipients: [identity()] }]), /duplicate resource/);
});

test("offline preparation, bootstrap policy export and example synthesis agree", () => {
  const dir = mkdtempSync(join(tmpdir(), "nebula-trustee-cli-"));
  const config = trusteeConfig();
  const run = (script: string, ...args: string[]) => execFileSync(process.execPath,
    ["--import", "tsx", script, ...args], { cwd: new URL("..", import.meta.url), stdio: "pipe", timeout: 20_000 });
  try {
    const configFile = join(dir, "config.json"), regoFile = join(dir, "deny.rego"), artifactFile = join(dir, "artifact.json");
    const prepared = join(dir, "prepared"), approvalFile = join(dir, "approved-snp.json"), rendered = join(dir, "rendered");
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(regoFile, denyPolicy);
    writeFileSync(approvalFile, JSON.stringify(identity(3)));
    run("scripts/prepare-trustee.ts", "template", configFile, prepared);
    assert.deepEqual(JSON.parse(readFileSync(join(prepared, "deployment.json"), "utf8")), trusteePlan(config).workload);
    run("scripts/prepare-trustee.ts", "bind", configFile, join(prepared, "preparation.json"), regoFile, artifactFile);
    const artifact = JSON.parse(readFileSync(artifactFile, "utf8"));
    assert.deepEqual(artifact, testArtifact(config));
    run("scripts/prepare-trustee.ts", "bootstrap-policies", configFile, artifactFile, approvalFile, join(dir, "bootstrap"));
    assert.equal(readFileSync(join(dir, "bootstrap/resource-policy.rego"), "utf8"), trusteeBootstrapPolicies(config, artifact, identity(3)).resourcePolicy);
    run("example/trustee.ts", configFile, artifactFile, rendered);
    const manifests = readdirSync(rendered).filter(name => name.endsWith(".yaml"));
    assert.equal(manifests.length, 1);
    assert.ok(readFileSync(join(rendered, manifests[0]), "utf8").includes(artifact.ccInitData));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
