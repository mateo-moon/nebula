import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Testing } from "cdk8s";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { evaluate } from "@marcbachmann/cel-js";
import { parseAllDocuments } from "yaml";
import { BaremetalFleet, BaremetalSetup, baremetalWorker, type BaremetalSetupOptions } from "../src/modules/infra/k0s/baremetal";
import type { BaremetalUefiConfiguration } from "../src/modules/infra/k0s/baremetal/uefi";

const options: BaremetalSetupOptions = {
  clusterName: "test", k0sVersion: "v1.36.3+k0s.2", sshSecretName: "worker-ssh", tagDomain: "example.test",
  namespace: "clusters", image: "registry.example.test/provisioner@sha256:" + "3".repeat(64),
  trustOnFirstUse: true, defaults: { geo: "eu", region: "dc1", zone: "dc1" },
  installation: {
    suite: "trixie", mirror: { hostname: "deb.debian.org", directory: "/debian" },
    kernel: { url: "https://images.example.test/kernel", sha256: "1".repeat(64) },
    initrd: { url: "https://images.example.test/initrd", sha256: "2".repeat(64) },
    disk: { minSizeGiB: 32 }, rootSizeGiB: 16, volumeGroup: "worker-vg",
  },
};
const uefi: BaremetalUefiConfiguration = {
  match: { boardVendor: "Fixture Vendor", boardName: "Fixture Board", biosVersion: "1.0" },
  variables: [{ name: "Setup", guid: "00000000-0000-0000-0000-aaaaaaaaaaaa", payloadSize: 16, attributes: 7,
    parameters: [{ name: "Enable feature", offset: 1, width: 1, value: 1, allowedValues: [0, 1, 255] }] }],
  verification: { cpuFlags: ["sev_snp"], moduleParameters: [{ module: "kvm_amd", parameter: "sev_snp", value: "Y" }] },
};
const dir = mkdtempSync(join(tmpdir(), "baremetal-worker-template-"));
const binary = join(dir, "render");
execFileSync("go", ["build", "-o", binary, "."], {
  cwd: fileURLToPath(new URL("./support/oidc-template", import.meta.url)),
  env: { ...process.env, GOCACHE: join(tmpdir(), "nebula-oidc-go-cache"), GOTOOLCHAIN: "local" }, timeout: 120000,
});
after(() => rmSync(dir, { recursive: true, force: true }));
function setup(o = options) {
  const chart = Testing.chart();
  new BaremetalSetup(chart, "setup", o);
  new BaremetalFleet(chart, "fleet").addNode("192.0.2.10");
  const resources = Testing.synth(chart);
  const xr = resources.find(r => r.kind === "XBaremetalWorker")!;
  xr.metadata.uid = "request-123";
  return { resources, xr, template: resources.find(r => r.kind === "Composition")!.spec.pipeline[0].input.inline.template };
}
const fixture = setup();
const healthy = { conditions: [{ type: "Ready", status: "True" }, { type: "Synced", status: "True" }] };
function render(observed: Record<string, any> = {}, xr = fixture.xr, template = fixture.template): any[] {
  const out = execFileSync(binary, [], { input: JSON.stringify({ template,
    data: { observed: { composite: { resource: xr }, resources: observed } } }), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  return out.split(/^---$/m).map(s => s.trim()).filter(Boolean).map(s => JSON.parse(s));
}
const key = (r: any) => r.metadata?.annotations?.["gotemplating.fn.crossplane.io/composition-resource-name"];
const named = (rs: any[], name: string) => rs.find(r => key(r) === name);
const native = (rs: any[], name: string) => named(rs, name)?.spec.forProvider.manifest;
const status = (rs: any[]) => rs.find(r => r.kind === "XBaremetalWorker")!.status;
const readiness = (rs: any[], name: string) => named(rs, name)?.metadata.annotations["gotemplating.fn.crossplane.io/ready"];
function observe(rs: any[]): Record<string, any> {
  return Object.fromEntries(rs.filter(r => r.kind === "Object").map(r => [key(r), { resource: { ...structuredClone(r),
    status: { ...structuredClone(healthy), atProvider: { manifest: structuredClone(r.spec.forProvider.manifest) } },
  } }]));
}
function installed(template = fixture.template, xr = fixture.xr): Record<string, any> {
  const rs = render({}, xr, template);
  const observed = observe(rs);
  const data = observed.state.resource.status.atProvider.manifest.data;
  data.phase = "OSReady"; data.verifiedRequestHash = data.requestHash;
  data.progress = JSON.stringify({ phase: "OSReady", addresses: [xr.spec.address] });
  observed.install.resource.status.atProvider.manifest.status = { conditions: [{ type: "Complete", status: "True" }] };
  return observed;
}

test("the baremetal worker XR follows Setup/Composition with immutable identity and pinned revision", () => {
  assert.deepEqual(fixture.xr.spec, { address: "192.0.2.10", crossplane: { compositionRef: { name: "baremetal-worker" }, compositionUpdatePolicy: "Manual" } });
  assert.equal(fixture.xr.metadata.namespace, undefined);
  assert.equal(fixture.resources.filter(r => r.kind === "CompositeResourceDefinition").length, 1);
  assert.equal(fixture.resources.find(r => r.kind === "CompositeResourceDefinition")!.spec.defaultCompositionUpdatePolicy, "Manual");
  assert.ok(!fixture.resources.some(r => ["Deployment", "CustomResourceDefinition"].includes(r.kind)));
  const schema = fixture.resources.find(r => r.kind === "CompositeResourceDefinition")!.spec.versions[0].schema.openAPIV3Schema;
  assert.deepEqual(schema.properties.spec.required, ["address"]);
  const pattern = new RegExp(schema.properties.spec.properties.address.pattern);
  assert.ok(pattern.test("192.0.2.10"));
  for (const value of ["256.1.2.3", "01.2.3.4", "2001:db8::1", "1.2.3.4;reboot"]) assert.ok(!pattern.test(value));
  assert.match(schema.properties.spec["x-kubernetes-validations"][0].rule, /oldSelf.address/);
  const fleet = new BaremetalFleet(Testing.chart(), "fleet");
  fleet.addNode("192.0.2.10"); assert.throws(() => fleet.addNode("192.0.2.10"), /duplicate/);
  for (const field of ["hostname", "sshUser", "sshPort"])
    assert.ok(schema.properties.spec["x-kubernetes-validations"].some((rule: any) => rule.message === `${field} is immutable`));
});

test("named workers carry their settings through OS installation and deferred CAPI enrollment", () => {
  const shared = setup({ ...options, defaults: { ...options.defaults,
    nodeLabels: { workload: "shared", inherited: "yes" }, taints: ["workload=shared:NoSchedule"] } });
  const chart = Testing.chart();
  baremetalWorker(chart, { compositionName: "baremetal-worker" }, {
    name: "worker-1", address: "192.0.2.10", sshUser: "admin", sshPort: 2222,
    geo: "us", region: "dc2", zone: "dc2-a", nodeLabels: { workload: "guest", empty: "", marker: "NEBULA_TAINT_ARGS" }, taints: ["workload=guest:NoSchedule"],
  });
  const xr = Testing.synth(chart)[0]; xr.metadata.uid = "named-worker-request";
  const initial = render({}, xr, shared.template);
  assert.equal(native(initial, "pool"), undefined);
  const request = JSON.parse(native(initial, "request").data["request.json"]);
  assert.equal(request.spec.hostname, "worker-1"); assert.equal(request.spec.ssh.user, "admin"); assert.equal(request.spec.ssh.port, 2222);
  const final = render(installed(shared.template, xr), xr, shared.template);
  const pool = native(final, "pool"); assert.equal(pool.metadata.name, "worker-1"); assert.equal(pool.spec.pool, "worker-1");
  assert.equal(pool.spec.machine.user, "root"); assert.equal(pool.spec.machine.port, 2222); assert.equal(pool.spec.machine.sshKeyRef.name, "worker-ssh");
  const config = native(final, "bootstrap-template").spec.template.spec;
  assert.equal(config.useSystemHostname, true);
  const labels = Object.fromEntries(config.args[0].slice("--labels=".length).split(",").map((entry: string) => entry.split("=")));
  assert.deepEqual(labels, { "example.test/geo": "us", "topology.kubernetes.io/region": "dc2", "topology.kubernetes.io/zone": "dc2-a",
    workload: "guest", inherited: "yes", empty: "", marker: "NEBULA_TAINT_ARGS" });
  assert.match(config.args[1], /--register-with-taints=workload=guest:NoSchedule/);
  const machine = native(final, "worker"); assert.equal(machine.metadata.name, "worker-1");
  assert.deepEqual(machine.spec.rollout.strategy.rollingUpdate, { maxSurge: 0, maxUnavailable: 1 });
  assert.equal(machine.spec.template.spec.deletion.nodeDrainTimeoutSeconds, 300);
  const changedLabels = { ...xr, spec: { ...xr.spec, nodeLabels: { workload: "updated" }, taints: [] }, status: status(final) };
  const updated = render(installed(shared.template, xr), changedLabels, shared.template);
  assert.equal(native(updated, "state").data.requestHash, native(final, "state").data.requestHash);
  assert.match(native(updated, "bootstrap-template").spec.template.spec.args[0], /workload=updated/);
  assert.doesNotMatch(native(updated, "bootstrap-template").spec.template.spec.args[1], /--register-with-taints/);
});

test("a maximum-length worker hostname keeps its identity within native Job name limits", () => {
  const chart = Testing.chart();
  const name = "worker-" + "a".repeat(56);
  baremetalWorker(chart, {}, { name, address: "192.0.2.11" });
  const xr = Testing.synth(chart)[0]; xr.metadata.uid = "long-hostname-request";
  const first = render({}, xr);
  assert.ok(native(first, "install").metadata.name.length <= 63);
  const final = render(installed(fixture.template, xr), xr);
  assert.equal(native(final, "pool").metadata.name, name);
  assert.equal(status(final).hostname, name);
});

test("initial graph has a bounded Job, private mounts, exact progress permissions and no enrollment", () => {
  const rs = render();
  assert.equal(rs.filter(r => r.kind === "Object").length, 6);
  assert.equal(native(rs, "pool"), undefined); assert.equal(status(rs).osReady, false);
  assert.equal(named(rs, "install").metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
  const job = native(rs, "install");
  assert.equal(job.spec.parallelism, 1); assert.ok(job.spec.activeDeadlineSeconds > 3600);
  assert.equal(job.spec.template.spec.securityContext.runAsNonRoot, true);
  assert.equal(job.spec.template.spec.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(job.spec.ttlSecondsAfterFinished, undefined);
  assert.ok(job.spec.template.spec.volumes.some((v: any) => v.secret?.secretName === "worker-ssh"));
  assert.deepEqual(native(rs, "role").rules, [{ apiGroups: [""], resources: ["configmaps"], resourceNames: [native(rs, "state").metadata.name], verbs: ["get", "patch"] }]);
  const requestJSON = native(rs, "request").data["request.json"];
  assert.equal(createHash("sha256").update(requestJSON).digest("hex"), native(rs, "state").data.requestHash);
  assert.deepEqual(Object.keys(JSON.parse(requestJSON).spec).sort(), ["address", "hostname", "installation", "ssh"]);
  assert.equal(native(rs, "request").immutable, true);
  for (const r of rs.filter(r => r.kind === "Object")) {
    assert.equal(r.spec.deletionPolicy, "Orphan"); assert.ok(!r.spec.managementPolicies.includes("Delete")); assert.ok(!r.spec.managementPolicies.includes("Update"));
  }
});

test("pool publication requires a completed Job and verification bound to this request", () => {
  assert.equal(native(render(installed()), "pool").spec.machine.address, "192.0.2.10");
  for (const mutate of [
    (o: any) => { delete o.install.resource.status.atProvider.manifest.status; },
    (o: any) => { o.state.resource.status.atProvider.manifest.data.phase = "Installing"; },
    (o: any) => { o.state.resource.status.atProvider.manifest.data.uid = "foreign"; },
    (o: any) => { o.state.resource.status.atProvider.manifest.data.verifiedRequestHash = "stale"; },
    (o: any) => { o.state.resource.status.atProvider.manifest.data.requestHash = "stale"; },
    (o: any) => { o.install.resource.status.atProvider.manifest.metadata.annotations["baremetal.nebula.io/request-uid"] = "foreign"; },
    (o: any) => { o.install.resource.status.atProvider.manifest.metadata.annotations["baremetal.nebula.io/request-hash"] = "stale"; },
    (o: any) => { o.state.resource.status.conditions[1].status = "False"; }, (o: any) => { delete o.state; },
    (o: any) => { o.state.resource.spec.providerConfigRef.name = "foreign"; },
    (o: any) => { o.install.resource.spec.providerConfigRef.name = "foreign"; },
    (o: any) => { o.install.resource.status.atProvider.manifest.metadata.namespace = "foreign"; },
    (o: any) => { o.install.resource.spec.forProvider.manifest.spec.template.spec.containers[0].image = "changed"; },
    (o: any) => { o.install.resource.status.atProvider.manifest.metadata.deletionTimestamp = "2026-01-01T00:00:00Z"; },
    (o: any) => { o.state.resource.status.atProvider.manifest.metadata.deletionTimestamp = "2026-01-01T00:00:00Z"; },
    (o: any) => { o.state.resource.status.atProvider.manifest.data.progress = JSON.stringify({ terminalError: true }); },
  ]) {
    const observed = installed(); mutate(observed);
    const rs = render(observed);
    assert.equal(native(rs, "pool"), undefined); assert.equal(status(rs).osReady, false);
    assert.equal(named(rs, "install").metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
  }
});

test("verified installation publishes the pooled CAPI graph and waits for the worker generation", () => {
  const first = render(installed());
  const objects = ["pool", "remote-template", "bootstrap-template", "worker"].map(k => native(first, k));
  assert.deepEqual(objects.map(r => r.kind), ["PooledRemoteMachine", "RemoteMachineTemplate", "K0sWorkerConfigTemplate", "MachineDeployment"]);
  assert.ok(objects.every(r => !r.metadata.ownerReferences)); assert.equal(objects[0].spec.machine.user, "root");
  assert.deepEqual(objects[3].spec.rollout.strategy.rollingUpdate, { maxSurge: 0, maxUnavailable: 1 });
  assert.ok(objects[2].spec.template.spec.args.some((a: string) => a.includes("$(cat /run/node-ip),$(cat /run/node-ip6)")));
  assert.equal(status(first).workerReady, false);
  const observed = { ...observe(first), ...installed() };
  const worker = observed.worker.resource.status.atProvider.manifest;
  worker.metadata.generation = 2;
  worker.status = { observedGeneration: 1, readyReplicas: 1, conditions: [{ type: "MachinesReady", status: "True", observedGeneration: 1 }] };
  assert.equal(status(render(observed)).workerReady, false);
  worker.status.observedGeneration = 2; worker.status.conditions[0].observedGeneration = 2;
  assert.equal(status(render(observed)).workerReady, true);
  worker.status.conditions[0].status = "False";
  const notReady = render(observed);
  assert.equal(status(notReady).workerReady, false);
  assert.equal(named(notReady, "worker").metadata.annotations["gotemplating.fn.crossplane.io/ready"], "False");
});

test("provider CEL readiness distinguishes Job completion from failure and rejects stale CAPI status", () => {
  const rs = render(installed());
  const jobQuery = named(rs, "install").spec.readiness.celQuery;
  const workerQuery = named(rs, "worker").spec.readiness.celQuery;
  assert.equal(evaluate(jobQuery, { object: native(rs, "install") }), false);
  assert.equal(evaluate(jobQuery, { object: { status: { conditions: [{ type: "Failed", status: "True" }] } } }), false);
  assert.equal(evaluate(jobQuery, { object: { status: { conditions: [{ type: "Complete", status: "True" }] } } }), true);
  const object = { metadata: { generation: 2 }, spec: { replicas: 1 }, status: { observedGeneration: 2, readyReplicas: 1,
    conditions: [{ type: "MachinesReady", status: "True", observedGeneration: 2 }] } };
  assert.equal(evaluate(workerQuery, { object }), true);
  object.status.conditions[0].observedGeneration = 1;
  assert.equal(evaluate(workerQuery, { object }), false);
  assert.equal(evaluate(workerQuery, { object: {} }), false);
});

test("lost observations retain published enrollment without readiness or a new install", () => {
  const first = render(installed());
  const lost = render({}, { ...fixture.xr, status: status(first) });
  for (const name of ["pool", "remote-template", "bootstrap-template", "worker"]) assert.deepEqual(native(lost, name), native(first, name));
  assert.equal(status(lost).workerReady, false); assert.equal(status(lost).enrollmentPublished, true);
  assert.equal(native(lost, "state").data.progress, undefined);
  const observed = installed();
  observed.install.resource.spec.forProvider.manifest.spec.template.spec.containers[0].image = "registry.example.test/old@sha256:" + "4".repeat(64);
  assert.equal(native(render(observed), "install").spec.template.spec.containers[0].image, observed.install.resource.spec.forProvider.manifest.spec.template.spec.containers[0].image);
});

test("changing a bound install profile fails without withdrawing its graph; new UIDs cannot reuse completion", () => {
  const xr = { ...fixture.xr, status: status(render()) };
  const changed = setup({ ...options, installation: { ...options.installation, rootSizeGiB: 20 } });
  assert.throws(() => render({}, xr, changed.template), /installation profile changed/);
  const recreated = { ...fixture.xr, metadata: { ...fixture.xr.metadata, uid: "replacement-request" } };
  assert.notEqual(native(render({}, recreated), "state").metadata.name, native(render(), "state").metadata.name);
  assert.equal(native(render(installed(), recreated), "pool"), undefined);
});

test("Cilium admission uses the workload ProviderConfig and gates first pooled handoff", () => {
  const network = setup({ ...options, ipv6PodCidrPrefix: "2001:db8::", workloadKubeProviderConfigName: "workload" });
  const ready = installed(network.template);
  const first = render(ready, network.xr, network.template);
  assert.equal(status(first).ipv6PodCidr, "2001:db8:c000:20a::/64"); assert.equal(native(first, "pool"), undefined);
  assert.equal(named(first, "cidr-policy").spec.providerConfigRef.name, "workload");
  assert.equal(native(first, "cidr-policy").kind, "MutatingAdmissionPolicy");
  assert.match(native(first, "identity-policy").spec.validations[0].expression, /system:node:/);
  const observed = { ...observe(first), ...ready };
  const wrong = structuredClone(observed);
  wrong["cidr-policy"].resource.status.atProvider.manifest.spec.mutations[0].applyConfiguration.expression = "wrong allocation";
  const waiting = render(wrong, network.xr, network.template);
  assert.equal(native(waiting, "pool"), undefined);
  assert.equal(readiness(waiting, "cidr-policy"), "False");
  // API-server defaults must not prevent observation of the requested policy.
  observed["cidr-policy"].resource.status.atProvider.manifest.spec.matchConstraints.namespaceSelector = {};
  const second = render(observed, { ...network.xr, status: status(first) }, network.template);
  assert.ok(native(second, "pool"));
  const lost = render({}, { ...network.xr, status: status(second) }, network.template);
  for (const name of ["cidr-policy", "cidr-binding", "identity-policy", "identity-binding", "pool", "worker"]) assert.deepEqual(native(lost, name), native(second, name));
  assert.equal(status(lost).workerReady, false);
});

test("readiness requires current owned intent and ignores unrelated controller defaults", () => {
  const initial = render(installed());
  const observed = { ...observe(initial), ...installed() };
  const worker = observed.worker.resource.status.atProvider.manifest;
  worker.metadata.generation = 2;
  worker.status = { observedGeneration: 2, readyReplicas: 1,
    conditions: [{ type: "MachinesReady", status: "True", observedGeneration: 2 }] };
  assert.equal(status(render(observed)).workerReady, true);
  for (const mutate of [
    (o: any) => { o["bootstrap-template"].resource.status.atProvider.manifest.spec.template.spec.args = ["--labels=stale"]; },
    (o: any) => { o.pool.resource.spec.forProvider.manifest.spec.machine.address = "192.0.2.99"; },
    (o: any) => { o.worker.resource.status.atProvider.manifest.spec.replicas = 2; },
    (o: any) => { o.worker.resource.metadata.deletionTimestamp = "2026-01-01T00:00:00Z"; },
    (o: any) => { o.worker.resource.status.atProvider.manifest.metadata.deletionTimestamp = "2026-01-01T00:00:00Z"; },
  ]) {
    const stale = structuredClone(observed); mutate(stale);
    const result = render(stale);
    assert.equal(status(result).workerReady, false);
    assert.equal(readiness(result, "worker"), "False");
  }
  const changed = { ...fixture.xr, spec: { ...fixture.xr.spec, nodeLabels: { purpose: "updated" } } };
  assert.equal(status(render(observed, changed)).workerReady, false);
  worker.metadata.labels = { ...worker.metadata.labels, "controller.example.test/default": "injected" };
  worker.spec.controllerDefault = "preserved-by-server-side-apply";
  const result = render(observed);
  assert.equal(status(result).workerReady, true);
  assert.equal(native(result, "worker").spec.controllerDefault, undefined);
  assert.equal(native(result, "worker").metadata.generation, undefined);
  assert.equal(native(result, "worker").metadata.labels?.["controller.example.test/default"], undefined);
  assert.equal(native(result, "worker").status, undefined);
});

test("partially applied graphs survive a missing XR publication checkpoint", () => {
  const complete = render(installed());
  for (const key of ["pool", "remote-template", "bootstrap-template", "worker"]) {
    const observed = observe(complete);
    const recovered = render({ [key]: observed[key] });
    for (const name of ["pool", "remote-template", "bootstrap-template", "worker"])
      assert.deepEqual(native(recovered, name), native(complete, name));
    assert.equal(status(recovered).workerReady, false);
  }
  const network = setup({ ...options, ipv6PodCidrPrefix: "2001:db8::", workloadKubeProviderConfigName: "workload" });
  const admission = render(installed(network.template), network.xr, network.template);
  for (const key of ["cidr-policy", "cidr-binding", "identity-policy", "identity-binding"]) {
    const observed = observe(admission);
    const recovered = render({ [key]: observed[key] }, network.xr, network.template);
    for (const name of ["cidr-policy", "cidr-binding", "identity-policy", "identity-binding"])
      assert.deepEqual(native(recovered, name), native(admission, name));
    assert.equal(native(recovered, "pool"), undefined);
  }
});

test("Crossplane CLI runs the pinned function pipeline with real readiness semantics", {
  skip: !process.env.BAREMETAL_CROSSPLANE_CLI, timeout: 240_000,
}, () => {
  const functions = [
    ["function-go-templating", "v0.9.0"], ["function-auto-ready", "v0.4.2"],
  ].map(([name, version]) => ({ apiVersion: "pkg.crossplane.io/v1", kind: "Function",
    metadata: { name, annotations: { "render.crossplane.io/runtime-docker-pull-policy": "IfNotPresent" } },
    spec: { package: `xpkg.upbound.io/crossplane-contrib/${name}:${version}` },
  }));
  const network = setup({ ...options, installation: { ...options.installation, uefi },
    ipv6PodCidrPrefix: "2001:db8::", workloadKubeProviderConfigName: "workload" });
  const file = (name: string, objects: any[]) => {
    const path = join(dir, name + ".yaml"); writeFileSync(path, objects.map(o => JSON.stringify(o)).join("\n---\n")); return path;
  };
  const composition = file("composition", network.resources.filter(r => r.kind === "Composition"));
  const fn = file("functions", functions);
  const fullRender = (observed: Record<string, any>, xr = network.xr) => {
    const input = Object.entries(observed).map(([name, entry]) => {
      const resource = structuredClone(entry.resource);
      resource.metadata.annotations = { "crossplane.io/composition-resource-name": name };
      return resource;
    });
    const output = execFileSync(process.env.BAREMETAL_CROSSPLANE_CLI!, ["render", file("xr", [xr]), composition, fn,
      "--observed-resources=" + file("observed", input), "--include-full-xr", "--timeout=90s"],
      { encoding: "utf8", timeout: 100_000, stdio: ["ignore", "pipe", "pipe"] });
    return parseAllDocuments(output).map(d => d.toJSON());
  };
  const ready = (rs: any[]) => rs.find(r => r.kind === "XBaremetalWorker").status.conditions.find((c: any) => c.type === "Ready").status;
  const count = (rs: any[]) => rs.filter(r => r.kind === "Object").length;
  assert.equal(ready(fullRender({})), "False");
  const observed = installed(network.template);
  assert.equal(ready(fullRender(observed)), "False", "OS verification cannot bypass UEFI");
  observed.state.resource.status.atProvider.manifest.data.progress = JSON.stringify({ phase: "OSReady", uefiVerified: true });
  const admission = render(observed, network.xr, network.template);
  const policies = { ...observe(admission), ...observed };
  const wrong = structuredClone(policies);
  wrong["cidr-policy"].resource.status.atProvider.manifest.spec.failurePolicy = "Ignore";
  const blocked = fullRender(wrong);
  assert.equal(count(blocked), 10); assert.equal(ready(blocked), "False", "auto-ready must preserve explicit policy failure");
  const enrolling = fullRender(policies);
  assert.equal(count(enrolling), 14); assert.equal(ready(enrolling), "False");
  const graph = render(policies, network.xr, network.template);
  const all = { ...observe(graph), ...policies };
  const worker = all.worker.resource.status.atProvider.manifest;
  worker.metadata.generation = 1;
  worker.status = { observedGeneration: 1, readyReplicas: 1,
    conditions: [{ type: "MachinesReady", status: "True", observedGeneration: 1 }] };
  assert.equal(ready(fullRender(all)), "True");
  const updated = { ...network.xr, spec: { ...network.xr.spec, nodeLabels: { purpose: "updated" } } };
  assert.equal(ready(fullRender(all, updated)), "False", "old ready worker cannot acknowledge new bootstrap intent");
  const lost = fullRender({}, { ...network.xr, status: status(graph) });
  assert.equal(count(lost), 14); assert.equal(ready(lost), "False");
});

test("custom SSH port and pinned known hosts survive installation and handoff", () => {
  const pinned = setup({ ...options, initialSshPort: 2222, trustOnFirstUse: false, knownHostsSecretName: "host-keys" });
  const rs = render(installed(pinned.template), pinned.xr, pinned.template);
  assert.equal(JSON.parse(native(rs, "request").data["request.json"]).spec.ssh.port, 2222);
  assert.equal(native(rs, "pool").spec.machine.port, 2222);
  assert.ok(native(rs, "install").spec.template.spec.volumes.some((v: any) => v.secret?.secretName === "host-keys"));
});

test("unsafe installation inputs fail before producing resources", () => {
  for (const mutate of [
    (o: any) => { o.trustOnFirstUse = false; }, (o: any) => { o.knownHostsSecretName = "known-hosts"; },
    (o: any) => { o.installation.kernel.sha256 = "latest"; }, (o: any) => { o.installation.initrd.url = "http://images.example.test/initrd"; },
    (o: any) => { o.installation.rootSizeGiB = 64; }, (o: any) => { o.defaults.region = "dc1; reboot"; },
    (o: any) => { o.initialSshUser = "root;reboot"; }, (o: any) => { o.installation.volumeGroup = "vg;reboot"; },
    (o: any) => { o.ipv6PodCidrPrefix = "2001:db8::"; },
  ]) {
    const invalid = structuredClone(options); mutate(invalid);
    assert.throws(() => new BaremetalSetup(Testing.chart(), "invalid", invalid), /Baremetal worker/);
  }
});

test("UEFI configuration is bound to the installation and gates CAPI publication", () => {
  const firmware = setup({ ...options, installation: { ...options.installation, uefi } });
  const first = render({}, firmware.xr, firmware.template);
  assert.deepEqual(JSON.parse(native(first, "request").data["request.json"]).spec.installation.uefi, uefi);
  assert.equal(native(first, "install").spec.activeDeadlineSeconds, native(render(), "install").spec.activeDeadlineSeconds + 900);
  assert.ok(firmware.resources.find(r => r.kind === "ConfigMap").data["uefi.py"]);
  const observed = installed(firmware.template, firmware.xr);
  const osOnly = render(observed, firmware.xr, firmware.template);
  assert.equal(status(osOnly).uefiReady, false); assert.equal(status(osOnly).osReady, false);
  assert.equal(native(osOnly, "pool"), undefined);
  observed.state.resource.status.atProvider.manifest.data.progress = JSON.stringify({ phase: "OSReady", uefiVerified: true });
  const ready = render(observed, firmware.xr, firmware.template);
  assert.equal(status(ready).uefiReady, true); assert.equal(status(ready).osReady, true); assert.ok(native(ready, "pool"));
  const modified = structuredClone(uefi); modified.variables[0].parameters[0].value = 0;
  const changed = setup({ ...options, installation: { ...options.installation, uefi: modified } });
  assert.throws(() => render(observed, { ...firmware.xr, status: status(ready) }, changed.template), /installation profile changed/);
});

test("unqualified firmware layouts and unsafe parameter definitions are rejected", () => {
  for (const mutate of [
    (p: any) => { p.match.biosVersion = ""; }, (p: any) => { p.variables[0].guid = "../bad"; },
    (p: any) => { p.variables[0].attributes = 39; }, (p: any) => { p.variables[0].payloadSize = 1; },
    (p: any) => { p.variables[0].parameters[0].value = 256; },
    (p: any) => { p.variables[0].parameters[0].allowedValues = [0]; },
    (p: any) => { p.variables[0].parameters.push({ ...p.variables[0].parameters[0], name: "overlap" }); },
    (p: any) => { p.variables.push(structuredClone(p.variables[0])); },
    (p: any) => { p.verification.moduleParameters[0].module = "../module"; },
    (p: any) => { p.rebootTimeoutSeconds = 0; },
  ]) {
    const invalid = structuredClone(uefi); mutate(invalid);
    assert.throws(() => setup({ ...options, installation: { ...options.installation, uefi: invalid } }), /Baremetal UEFI/);
  }
});

test("actual Python installer and finite Job restart qualification", () => {
  execFileSync("python3", ["-B", fileURLToPath(new URL("./baremetal-runtime.py", import.meta.url))], { stdio: "pipe" });
});

test("UEFI variable transactions, firmware reboot and Job recovery qualification", () => {
  execFileSync("python3", ["-B", fileURLToPath(new URL("./baremetal-uefi.py", import.meta.url))], { stdio: "pipe" });
});

test("isolated Python agent packaging and transport failure semantics", () => {
  execFileSync("python3", ["-B", fileURLToPath(new URL("./baremetal-transport.py", import.meta.url))], { stdio: "pipe" });
});
