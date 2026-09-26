import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { KubeConfigMap, KubeValidatingAdmissionPolicy } from "cdk8s-plus-33/lib/imports/k8s";
import {
  ConfidentialGuestStack,
  guestClaimPrefix,
  type ConfidentialGuestStackContext,
  type ConfidentialGuestStackProps,
} from "../src/modules/k8s/confidential-guests";
import { DOMAIN, NAMESPACE, NODE, RUNTIME, image, initData, lifecycleProps, measured, roles } from "./confidential-guests-fixtures";

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
    ["component neither props nor a function", { disks: 42 as any, services: { services: [{ name: "guest-primary", selector: { app: "guests" }, ports: [8080] }] } },
      /disks must be its construct's props or a function/],
    ["a component's props refused after others were built", { services: { services: [{ name: "guest-primary", selector: { app: "guests" }, ports: [8080] }] },
      disks: {} as any }, /SealedDisks/],
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

// The pull broker, sealed disks and a standalone key injector can be given as
// their constructs' props; the stack fills in what it knows and checks that
// they serve its guests.
const GiB = 1024 ** 3, MiB = 1024 ** 2;
const brokerProps = {
  name: "pull-broker", configMapName: "pull-broker-configuration",
  networkPolicyNames: { ingressBoundary: "ingress-boundary", fromGuests: "pull-broker-from-guests" },
  podLabels: { app: "guests-pull-broker" }, guestSelector: { app: "guests" },
  brokerImage: image("kbs"), initImage: image("tools"), initCommand: ["registry-init"], configToml: "[http_server]\n",
  resourcePath: ["default", "registry", "pull"] as const, pullSecret: { name: "registry-pull", exposeAsResource: true },
};
const binding = (pod: string) => [{ pod, container: "storage" }, { pod, container: "attest" }];
const injectorProps = {
  name: "key-injector", image: image("injector"), pluginIndex: "40", runtimeHandler: RUNTIME, device: { major: 10, minor: 258 },
  bindings: [...binding("guest-primary"), ...binding("guest-primary-stage"), ...binding("guest-operator")],
};
const diskProps = (injector: object | null = injectorProps) => ({
  image: image("tools"), stateDir: "/var/lib/guests/disks",
  roles: [
    { role: "primary", claim: "guest-primary-data", file: "primary-data", sizeBytes: 64 * GiB, sizeLabel: "64Gi", provisioner: "primary-disk" },
    { role: "standby", claim: "guest-primary-stage", file: "primary-stage", sizeBytes: 16 * MiB, sizeLabel: "16Mi", provisioner: "standby-disk", placeholder: true },
    { role: "operator", claim: "guest-operator", file: "operator", sizeBytes: GiB, sizeLabel: "1Gi", provisioner: "operator-disk" },
  ],
  table: { live: { primary: { generation: 2, loop: 202 }, standby: { generation: 1, loop: 210 }, operator: { generation: 1, loop: 220 } },
    retained: [{ role: "primary" as const, generation: 1, loop: 201, sizeBytes: 32 * GiB, sizeLabel: "32Gi" }],
    retired: [], reservedLoops: [], protectedLoops: [], firstPinnedLoop: 100 },
  placeholderMagic: "example.placeholder/v1\n",
  ...(injector ? { injector } : {}),
});

test("the pull broker, disks and injector can be given as props: the stack places them and admits its own releases", () => {
  const { docs, stack } = render(stackProps({ pullBroker: brokerProps, disks: diskProps() }));
  const order = docs.map(d => `${d.kind}/${d.metadata.name}`);
  assert.deepEqual(order.slice(0, 5), ["NetworkPolicy/ingress-boundary", "NetworkPolicy/pull-broker-from-guests", "ConfigMap/pull-broker-configuration",
    "Service/pull-broker", "Deployment/pull-broker"], "the broker renders first");
  const at = (entry: string) => order.indexOf(entry);
  assert.ok(at("Deployment/primary-disk") > at("Deployment/pull-broker") && at("Deployment/key-injector") > at("Deployment/operator-disk"));
  assert.ok(at("PersistentVolumeClaim/guest-operator-v1") < at("ValidatingAdmissionPolicy/guests-creator"));
  for (const doc of docs.filter(d => d.kind !== "PersistentVolume" && !d.kind.startsWith("ValidatingAdmissionPolicy"))) {
    assert.equal(doc.metadata.namespace, NAMESPACE, `${doc.kind}/${doc.metadata.name}`);
  }
  const broker = docs.find(d => d.kind === "ConfigMap" && d.metadata.name === "pull-broker-configuration");
  assert.ok(broker.data["resource-policy.rego"].includes(`ev.init_data in ${JSON.stringify(stack.context.initDataSha256)}`), "the broker admits every release's HOST_DATA");
  const deployment = (name: string) => docs.find(d => d.kind === "Deployment" && d.metadata.name === name).spec.template;
  assert.ok(Object.keys(deployment("pull-broker").metadata.annotations).includes(`${DOMAIN}/config-sha256`));
  for (const name of ["pull-broker", "primary-disk", "key-injector"]) assert.equal(deployment(name).spec.nodeName, NODE, name);
  const claims = docs.filter(d => d.kind === "PersistentVolumeClaim").map(d => [d.metadata.name, d.spec.resources.requests.storage]);
  assert.deepEqual(claims, [["guest-primary-data-v2", "64Gi"], ["guest-primary-stage-v1", "16Mi"], ["guest-operator-v1", "1Gi"], ["guest-primary-data-v1", "32Gi"]]);
  // A standalone injector, for disks the stack does not build.
  const standalone = render(stackProps({ keyInjector: injectorProps })).docs;
  assert.deepEqual(standalone.filter(d => d.kind === "Deployment" && d.metadata.name === "key-injector").map(d => d.metadata.namespace), [NAMESPACE]);
});

test("props the stack sets, disks that miss a guest's claim and injectors that bind other Pods are refused", () => {
  refuse("broker namespace", stackProps({ pullBroker: { ...brokerProps, namespace: "other" } as any }), /pullBroker: the stack sets namespace/);
  refuse("broker admission", stackProps({ pullBroker: { ...brokerProps, initData: { form: "equals", value: "ab".repeat(32) } } as any }),
    /pullBroker: the stack sets initData/);
  refuse("broker label domain", stackProps({ pullBroker: { ...brokerProps, labelDomain: "other.example.com" } as any }), /pullBroker: the stack sets labelDomain/);
  refuse("disks node", stackProps({ disks: { ...diskProps(), nodeName: "node-b" } as any }), /disks: the stack sets nodeName/);
  refuse("injector namespace", stackProps({ keyInjector: { ...injectorProps, targetNamespace: NAMESPACE } as any }), /keyInjector: the stack sets targetNamespace/);
  const withoutOperator = diskProps();
  withoutOperator.roles = withoutOperator.roles.map(r => (r.role === "operator" ? { ...r, claim: "guest-console" } : r));
  refuse("a guest claim no disk serves", stackProps({ disks: withoutOperator }),
    /role operator: claim guest-operator-v1 is not a live disk of disks \(live: guest-primary-data-v2, guest-primary-stage-v1, guest-console-v1\)/);
  refuse("the holder on a retained generation", stackProps({ disks: { ...diskProps(), table: { ...diskProps().table,
    live: { ...diskProps().table.live, primary: { generation: 3, loop: 203 } }, retained: [{ role: "primary" as const, generation: 2, loop: 202 }] } } }),
    /role primary: claim guest-primary-data-v2 is not a live disk/);
  refuse("an injector binding outside the stack's guests", stackProps({ disks: diskProps({ ...injectorProps, bindings: binding("guest-other") }) }),
    /disks.injector binds guest-other, which is not a guest Pod of the stack/);
  refuse("a standalone injector binding outside the stack's guests", stackProps({ keyInjector: { ...injectorProps, bindings: binding("guest-other") } }),
    /keyInjector binds guest-other, which is not a guest Pod of the stack/);
  refuse("injector bindings that are not a list", stackProps({ keyInjector: { ...injectorProps, bindings: "guest-primary" as any } }),
    /NriKeyInjector: bindings must list at least one binding/);
  refuse("two injectors", stackProps({ disks: diskProps(), keyInjector: injectorProps }),
    /keyInjector: disks already renders the key injector \(disks.injector\); keyInjector is for a standalone NriKeyInjector/);
  assert.ok(render(stackProps({ disks: diskProps(null), keyInjector: injectorProps })).docs.length > 0, "disks without an injector and a standalone one");
  // Function slots keep working beside typed ones.
  assert.ok(render(stackProps({ pullBroker: brokerProps, disks: diskProps(null),
    keyInjector: (scope, context) => { new KubeConfigMap(scope, "own", { metadata: { name: "own-injector", namespace: context.namespace } }); } })).docs
    .some(d => d.metadata.name === "own-injector"));
});
