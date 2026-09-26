import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Chart, Testing } from "cdk8s";
import { KubeConfigMap, KubeValidatingAdmissionPolicy } from "cdk8s-plus-33/lib/imports/k8s";
import {
  ConfidentialGuestStack,
  guestClaimPrefix,
  type ConfidentialGuestStackContext,
  type ConfidentialGuestStackProps,
} from "../src/modules/k8s/confidential-guests";
import { confidentialGuestStackExample } from "../example/confidential-guests-stack";
import { DOMAIN, NAMESPACE, NODE, RUNTIME, image, initData, lifecycleProps, measured, roles } from "./confidential-guests-fixtures";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const GOLDEN = join(here, "confidential-guests-stack.golden.yaml");

function exampleYaml(): string {
  const app = Testing.app();
  confidentialGuestStackExample(new Chart(app, "confidential-guests-stack"));
  return app.synthYaml();
}

const MESSAGES = {
  creator: "c", name: "n", placement: "p", hostNamespaces: "h", serviceAccount: "s", volumes: "v", claim: "cl", privilege: "pr", initData: "i",
};
function stackProps(extra: Partial<ConfidentialGuestStackProps> = {}): ConfidentialGuestStackProps {
  const { namespace, nodeName, runtimeClassName, labelDomain, ...lifecycle } = lifecycleProps({ controller: { image: image("control") } });
  return {
    namespace, nodeName, runtimeClassName, labelDomain, lifecycle,
    fence: { policyNames: { creator: "guests-creator", shape: "guests-shape" }, guestClaimPrefix: "guest-", messages: MESSAGES },
    ...extra,
  };
}
function render(props: ConfidentialGuestStackProps) {
  const chart = Testing.chart();
  const stack = new ConfidentialGuestStack(chart, "stack", props);
  return { stack, docs: Testing.synth(chart) };
}

test("the example synthesizes to the reviewed golden output", () => {
  const yaml = exampleYaml();
  if (process.env.UPDATE_GOLDEN === "1") writeFileSync(GOLDEN, yaml);
  assert.equal(yaml, readFileSync(GOLDEN, "utf8"), "example output changed; review it and rerun with UPDATE_GOLDEN=1");
});

test("the example's output passes the publication guard, and the guard sees this input", () => {
  const guard = (input: string) => spawnSync(process.execPath, [join(repoRoot, "scripts", "publication-guard.mjs"), "--stdin", "--label", "example-synth"],
    { input, encoding: "utf8", env: { ...process.env, GITHUB_REPOSITORY_OWNER: "" } });
  const clean = guard(exampleYaml());
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  // Assembled at run time so the seed itself is not a finding in this file.
  const seeded = guard(exampleYaml().replace("tee-node-1", [10, 0, 0, 7].join(".")));
  assert.equal(seeded.status, 1, "a private address seeded into the output must be found");
});

test("every rendered object is explicitly named and namespaced unless cluster-scoped", () => {
  const app = Testing.app();
  confidentialGuestStackExample(new Chart(app, "confidential-guests-stack"));
  const docs = app.charts.flatMap(chart => chart.toJson());
  assert.ok(docs.length > 20);
  for (const doc of docs) {
    assert.match(doc.metadata?.name ?? "", /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/, `${doc.kind} without an explicit name`);
    const clusterScoped = doc.kind.startsWith("ValidatingAdmissionPolicy");
    assert.equal(doc.metadata.namespace, clusterScoped ? undefined : "guests", `${doc.kind}/${doc.metadata.name}`);
  }
});

test("emission order: broker, releases, services, disks, injector, logs, fence, controllers; components receive the context", () => {
  const seen: Record<string, ConfidentialGuestStackContext> = {};
  const stub = (name: string) => (scope: any, context: ConfidentialGuestStackContext) => {
    seen[name] = context;
    new KubeConfigMap(scope, name, { metadata: { name, namespace: context.namespace } });
  };
  const fp = "0123456789abcdef";
  const release = { payloadType: "application/vnd.example.release+json", payload: Buffer.from('{"expires_at":1}').toString("base64") };
  const { docs, stack } = render(stackProps({
    pullBroker: stub("broker"), disks: stub("disks"), keyInjector: stub("injector"),
    releases: { payloadTypes: { f: { release: release.payloadType, releaseSet: "application/vnd.example.release-set+json" } }, releaseSet: false,
      reading: [fp], authorities: [{ fingerprint: fp, status: "active", formats: [{ format: "f", configMap: "trust", envelopes: { release } }] }] },
    services: { services: [{ name: "guest-primary", selector: { app: "guests" }, ports: [8080] }] },
    logRetention: { hostPath: "/var/lib/guests/logs", collector: { image: image("tools") } },
  }));
  const order = docs.map(d => `${d.kind}/${d.metadata.name}`);
  const at = (entry: string) => { const i = order.indexOf(entry); assert.ok(i >= 0, entry); return i; };
  const sequence = ["ConfigMap/broker", "ConfigMap/trust", "Service/guest-primary", "ConfigMap/disks", "ConfigMap/injector", "Deployment/log-retention",
    "ValidatingAdmissionPolicy/guests-creator", "ValidatingAdmissionPolicyBinding/guests-shape", "ConfigMap/primary-lifecycle-spec",
    "Deployment/operator-lifecycle"].map(at);
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), order.join("\n"));
  assert.equal(order.at(-1), "Deployment/operator-lifecycle", "the controllers render last");
  const context = seen.broker;
  assert.deepEqual([seen.disks, seen.injector], [context, context]);
  assert.deepEqual(context, {
    namespace: NAMESPACE, nodeName: NODE, runtimeClassName: RUNTIME, labelDomain: DOMAIN, lifecycleLabel: `${DOMAIN}/lifecycle`,
    initDataSha256: [initData("primary-r1").initDataSha256, initData("primary-r2").initDataSha256, initData("operator-r1").initDataSha256],
    guestPods: ["guest-primary", "guest-primary-stage", "guest-operator"],
    roles: [
      { role: "primary", holder: "guest-primary", claim: "guest-primary-data-v2", generation: 2, stage: { name: "guest-primary-stage", claim: "guest-primary-stage-v1" } },
      { role: "operator", holder: "guest-operator", claim: "guest-operator-v1", generation: 1 },
    ],
  });
  assert.equal(stack.context, context);
  assert.equal(stack.releases?.configMapOf(fp), "trust");
  assert.deepEqual(stack.ignoreDifferences().map(e => e.name), ["primary-budget-v1", "primary-lifecycle-ledger", "operator-lifecycle-ledger"]);
});

test("the fence and log retention derive from the lifecycle roles unless given", () => {
  const { docs } = render(stackProps({ logRetention: { hostPath: "/var/lib/guests/logs", collector: { image: image("tools") } } }));
  const creator = docs.find(d => d.metadata.name === "guests-creator" && d.kind === "ValidatingAdmissionPolicy");
  assert.deepEqual(creator.spec.matchConstraints.namespaceSelector, { matchLabels: { "kubernetes.io/metadata.name": NAMESPACE } });
  assert.equal(creator.spec.validations[0].expression,
    "request.userInfo.username in ['system:serviceaccount:guests:primary-lifecycle', 'system:serviceaccount:guests:operator-lifecycle']");
  const shape = docs.find(d => d.metadata.name === "guests-shape" && d.kind === "ValidatingAdmissionPolicy");
  assert.match(shape.spec.validations[5].expression,
    /startsWith\(object.metadata.name == 'guest-primary' \? 'guest-primary-data-v' : object.metadata.name == 'guest-primary-stage' \? 'guest-primary-stage-v' : 'guest-operator-v'\)/);
  const collector = docs.find(d => d.kind === "Deployment" && d.metadata.name === "log-retention");
  assert.equal(collector.spec.template.spec.containers[0].env[1].value,
    '[["guest-primary",["storage","attest","app"]],["guest-operator",["storage","attest"]],["guest-primary-stage",["storage","attest"]]]');
  const custom = render(stackProps({
    fence: { ...stackProps().fence, namespaceSelector: { matchLabels: { fenced: "true" } } },
    logRetention: { hostPath: "/var/lib/guests/logs", collector: { image: image("tools") }, scopes: [{ pod: "guest-primary", containers: ["app"] }] },
  })).docs;
  assert.deepEqual(custom.find(d => d.kind === "ValidatingAdmissionPolicyBinding").spec.matchResources.namespaceSelector, { matchLabels: { fenced: "true" } });
  assert.equal(custom.find(d => d.metadata.name === "log-retention" && d.kind === "Deployment").spec.template.spec.containers[0].env[1].value, '[["guest-primary",["app"]]]');
  assert.equal(guestClaimPrefix("guest-primary-data-v12"), "guest-primary-data-v");
  assert.equal(guestClaimPrefix("scratch"), "scratch");
});

test("any label domain: nothing outside the guest templates carries another", () => {
  const { docs } = render(stackProps({ labelDomain: "ops.example.net",
    services: { services: [{ name: "guest-primary", selector: { app: "guests" }, ports: [8080] }] },
    logRetention: { hostPath: "/var/lib/guests/logs", collector: { code: { "follow.py": "" }, runtimeImage: image("python") } } }));
  const outside = JSON.stringify(docs.map(d => d.data?.["spec.json"] ? { ...d, data: {} } : d));
  assert.ok(!outside.includes(DOMAIN), "the fixture templates' domain leaked outside them");
  assert.ok(outside.includes("ops.example.net/code-sha256"));
});

test("refusals happen before anything renders", () => {
  const refusals: [string, Partial<ConfidentialGuestStackProps>, RegExp][] = [
    ["a part refuses after others were built", { services: { services: [{ name: "guest-primary", selector: { app: "guests" }, ports: [8080] }] },
      fence: { ...stackProps().fence, messages: { ...MESSAGES, claim: "" } } }, /messages.claim/],
    ["claim outside the fenced prefix", { fence: { ...stackProps().fence, guestClaimPrefix: "vm-" } }, /outside fence.guestClaimPrefix/],
    ["no fence", { fence: undefined as any }, /fence is required/],
    ["no lifecycle", { lifecycle: undefined as any }, /lifecycle is required/],
    ["no label domain", { labelDomain: undefined as any }, /labelDomain/],
    ["component not a function", { disks: {} as any, services: { services: [{ name: "guest-primary", selector: { app: "guests" }, ports: [8080] }] } }, /disks must be a function/],
  ];
  for (const [label, change, error] of refusals) {
    const chart = Testing.chart();
    assert.throws(() => new ConfidentialGuestStack(chart, "stack", stackProps(change)), error, label);
    assert.deepEqual(Testing.synth(chart), [], `${label}: nothing rendered`);
  }
});

/** Stack props whose roles use the given claims (the primary holder runs its placeholder release only). */
function withClaims(primaryClaim: string, operatorClaim: string, stageClaim?: string): ConfidentialGuestStackProps {
  const [primary, operator] = roles();
  const base = stackProps();
  return { ...base, lifecycle: { ...base.lifecycle, roles: [
    { ...primary, claim: primaryClaim, releases: { r2: primary.releases.r2 }, previous: null,
      stage: { ...primary.stage!, ...(stageClaim ? { claim: stageClaim } : {}) } },
    { ...operator, claim: operatorClaim, releases: { m1: measured("operator", { claim: operatorClaim }) } },
  ] } };
}
const controller = (role: string, guests: [string, string][]) =>
  ({ serviceAccount: { namespace: NAMESPACE, name: `${role}-lifecycle` }, guests: guests.map(([name, claimPrefix]) => ({ name, claimPrefix })) });
function withControllers(controllers: ReturnType<typeof controller>[]): ConfidentialGuestStackProps {
  const base = stackProps();
  return { ...base, fence: { ...base.fence, controllers } };
}
function refuse(label: string, props: ConfidentialGuestStackProps, error: RegExp) {
  const chart = Testing.chart();
  assert.throws(() => new ConfidentialGuestStack(chart, "stack", props), error, label);
  assert.deepEqual(Testing.synth(chart), [], `${label}: nothing rendered`);
}

test("each role's claims stay its own through the fence, derived or given", () => {
  refuse("claims that differ only in their number", withClaims("guest-disk-1", "guest-disk-2"),
    /guest guest-primary claimPrefix "guest-disk-" overlaps guest guest-operator's "guest-disk-"/);
  refuse("a stage claim under its holder's prefix", withClaims("guest-primary-v1", "guest-operator-v1", "guest-primary-v2"),
    /guest guest-primary claimPrefix "guest-primary-v" overlaps guest guest-primary-stage's "guest-primary-v"/);
  refuse("a role's guest listed under another controller", withControllers([
    controller("primary", [["guest-primary", "guest-primary-data-v"]]),
    controller("operator", [["guest-operator", "guest-operator-v"], ["guest-primary-stage", "guest-primary-stage-v"]])]),
    /role primary: guest guest-primary-stage is not a guest of its controller guests\/primary-lifecycle in fence.controllers/);
  refuse("a role's guest missing from the fence", withControllers([
    controller("primary", [["guest-primary", "guest-primary-data-v"]]), controller("operator", [["guest-operator", "guest-operator-v"]])]),
    /guest guest-primary-stage is not a guest of its controller/);
  refuse("a claim outside its guest's prefix", withControllers([
    controller("primary", [["guest-primary", "guest-primary-data-v"], ["guest-primary-stage", "guest-primary-stage-v"]]),
    controller("operator", [["guest-operator", "guest-operator-x"]])]),
    /role operator: claim guest-operator-v1 is outside guest guest-operator's claimPrefix "guest-operator-x"/);
  const given = withControllers([
    controller("primary", [["guest-primary", "guest-primary-data-v2"], ["guest-primary-stage", "guest-primary-stage-v1"]]),
    controller("operator", [["guest-operator", "guest-operator-v1"]])]);
  assert.ok(render(given).docs.length > 0, "narrower prefixes that still admit each claim are accepted");
});

test("no two parts render the same object", () => {
  const release = { payloadType: "application/vnd.example.release+json", payload: Buffer.from('{"expires_at":1}').toString("base64") };
  const releases = (configMap: string) => ({ payloadTypes: { f: { release: release.payloadType, releaseSet: "application/vnd.example.release-set+json" } },
    releaseSet: false, reading: ["0123456789abcdef"],
    authorities: [{ fingerprint: "0123456789abcdef", status: "active" as const, formats: [{ format: "f", configMap, envelopes: { release } }] }] });
  refuse("a release ConfigMap named like a controller's spec", stackProps({ releases: releases("primary-lifecycle-spec") }),
    /ConfigMap guests\/primary-lifecycle-spec is rendered twice/);
  refuse("a component object named like another part's", stackProps({
    disks: (scope, context) => { new KubeConfigMap(scope, "ledger", { metadata: { name: "operator-lifecycle-ledger", namespace: context.namespace } }); } }),
    /ConfigMap guests\/operator-lifecycle-ledger is rendered twice/);
  refuse("a cluster-scoped duplicate", stackProps({
    keyInjector: scope => { new KubeValidatingAdmissionPolicy(scope, "policy", { metadata: { name: "guests-shape" } }); } }),
    /ValidatingAdmissionPolicy.admissionregistration.k8s.io guests-shape is rendered twice/);
  const elsewhere = render(stackProps({ releases: releases("trust"),
    disks: scope => { new KubeConfigMap(scope, "other", { metadata: { name: "primary-lifecycle-spec", namespace: "other" } }); } })).docs;
  assert.equal(elsewhere.filter(d => d.kind === "ConfigMap" && d.metadata.name === "primary-lifecycle-spec").length, 2, "the same name in another namespace is another object");
});
