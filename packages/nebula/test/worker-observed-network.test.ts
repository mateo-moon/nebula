import assert from "node:assert/strict";
import test, { after } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WORKER_NETWORK_OBSERVATION } from "../src/modules/infra/aws/worker-network-observation";

const dir = mkdtempSync(join(tmpdir(), "worker-network-template-"));
const binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, "."], {
  cwd: fileURLToPath(new URL("./support/oidc-template", import.meta.url)),
  env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-oidc-go-cache"), GOTOOLCHAIN: "local" }, timeout: 120000,
});
after(() => rmSync(dir, { recursive: true, force: true }));
const healthy = { conditions: [{ type: "Ready", status: "True" }, { type: "Synced", status: "True", observedGeneration: 3 }] };
const group = { apiVersion: "ec2.aws.upbound.io/v1beta1", kind: "SecurityGroup",
  metadata: { name: "worker-sg", generation: 3, annotations: { "crossplane.io/external-name": "sg-0123456789abcdef0" } },
  spec: { providerConfigRef: { name: "worker-provider" }, forProvider: { region: "eu-central-1", vpcId: "vpc-0123456789abcdef0" } },
  status: { ...healthy, atProvider: { id: "sg-0123456789abcdef0", region: "eu-central-1", vpcId: "vpc-0123456789abcdef0" } } };
const observer = { resource: { metadata: { generation: 3 }, status: { ...healthy, atProvider: { manifest: group } } } };
const spec = { securityGroupName: "worker-sg", kubeProviderConfigName: "reader", launchTemplate: {
  spec: { providerConfigRef: { name: "worker-provider" }, forProvider: { region: "eu-central-1" } } } };
const template = `{{- $spec := .spec -}}{{- $resources := .resources -}}{{- $region := $spec.launchTemplate.spec.forProvider.region -}}
{{- $annotation := "gotemplating.fn.crossplane.io/composition-resource-name" -}}{{- $observers := list -}}
${WORKER_NETWORK_OBSERVATION}
{{ dict "ready" $networkReady "id" $securityGroupId "observers" $observers | toJson }}`;
function render(observed: any = observer) {
  return JSON.parse(execFileSync(binary, [], { input: JSON.stringify({ template,
    data: { spec, resources: observed ? { "security-group": observed } : {} } }), encoding: "utf8" }));
}

test("SG observations resolve the same bound identity and only request read-only named access", () => {
  const out = render();
  assert.equal(out.ready, true);
  assert.equal(out.id, group.status.atProvider.id);
  assert.equal(out.observers.length, 1);
  assert.deepEqual(out.observers[0].spec.managementPolicies, ["Observe"]);
  assert.equal(out.observers[0].spec.providerConfigRef.name, "reader");
  assert.deepEqual(out.observers[0].spec.forProvider.manifest, {
    apiVersion: group.apiVersion, kind: "SecurityGroup", metadata: { name: "worker-sg" },
  });
});

test("SG observations refuse stale, mismatched, deleting or unhealthy bindings", () => {
  assert.equal(render(null).ready, false);
  for (const edit of [
    (o: any) => o.resource.status.conditions[1].status = "False",
    (o: any) => o.resource.metadata.generation++,
    (o: any) => o.resource.status.atProvider.manifest.metadata.generation++,
    (o: any) => o.resource.status.atProvider.manifest.status.conditions[0].status = "False",
    (o: any) => o.resource.status.atProvider.manifest.metadata.name = "other-sg",
    (o: any) => o.resource.status.atProvider.manifest.metadata.deletionTimestamp = "2026-01-01T00:00:00Z",
    (o: any) => o.resource.status.atProvider.manifest.metadata.annotations["crossplane.io/external-name"] = "sg-11111111111111111",
    (o: any) => o.resource.status.atProvider.manifest.status.atProvider.id = "not-an-aws-id",
    (o: any) => o.resource.status.atProvider.manifest.spec.forProvider.region = "us-east-1",
    (o: any) => o.resource.status.atProvider.manifest.status.atProvider.region = "us-east-1",
    (o: any) => o.resource.status.atProvider.manifest.spec.providerConfigRef.name = "other-provider",
    (o: any) => o.resource.status.atProvider.manifest.status.atProvider.vpcId = "vpc-11111111111111111",
  ]) { const changed = structuredClone(observer); edit(changed); assert.equal(render(changed).ready, false); }
});

test("a newly bound SG changes the emitted ID without retaining a copied cloud constant", () => {
  const changed = structuredClone(observer);
  const resource = changed.resource.status.atProvider.manifest;
  resource.metadata.annotations["crossplane.io/external-name"] = "sg-11111111111111111";
  resource.status.atProvider.id = "sg-11111111111111111";
  assert.equal(render(changed).ready, true);
  assert.equal(render(changed).id, "sg-11111111111111111");
});
