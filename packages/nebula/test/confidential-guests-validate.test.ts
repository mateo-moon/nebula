// The constructs share one set of prop validators: every refusal is a
// TypeError that starts with the construct's name, and one rule (such as a
// label domain) means the same thing in every construct that takes it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Testing } from "cdk8s";
import {
  AttestedPullBroker,
  ConfidentialGuestStack,
  GuestAdmissionFence,
  GuestLifecycle,
  GuestLogRetention,
  GuestServices,
  NriKeyInjector,
  SealedDisks,
  SignedReleases,
} from "../src/modules/k8s/confidential-guests";
import { image, lifecycleProps } from "./confidential-guests-fixtures";

const moduleDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "modules", "k8s", "confidential-guests");

const refusedAs = (owner: string, pattern: RegExp) => (error: unknown) => {
  assert.ok(error instanceof TypeError, `${owner}: ${String(error)} is not a TypeError`);
  assert.ok(error.message.startsWith(`${owner}: `), `${owner}: ${error.message}`);
  assert.match(error.message, pattern);
  return true;
};

const MESSAGES = {
  creator: "c", name: "n", placement: "p", hostNamespaces: "h", serviceAccount: "s", volumes: "v", claim: "cl", privilege: "pr", initData: "i",
};
const fence = {
  namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "guests" } },
  policyNames: { creator: "guests-creator", shape: "guests-shape" },
  messages: MESSAGES,
  controllers: [{ serviceAccount: { namespace: "guests", name: "primary-lifecycle" }, guests: [{ name: "guest-primary", claimPrefix: "guest-primary-v" }] }],
  runtimeClassName: "kata-qemu-snp",
  nodeName: "node-a",
  guestClaimPrefix: "guest-",
};
const broker = {
  namespace: "guests", name: "pull-broker", configMapName: "pull-broker-configuration",
  networkPolicyNames: { ingressBoundary: "ingress-boundary", fromGuests: "pull-broker-from-guests" },
  podLabels: { app: "guests-pull-broker" }, guestSelector: { app: "guests" }, nodeName: "node-a",
  brokerImage: image("kbs"), initImage: image("tools"), initCommand: ["registry-init"], configToml: "[http_server]\n",
  resourcePath: ["default", "registry", "pull"] as const, initData: { form: "equals" as const, value: "ab".repeat(32) },
  pullSecret: { name: "registry-pull", exposeAsResource: false }, labelDomain: "guests.example.com",
};
const injector = {
  name: "key-injector", namespace: "guests", nodeName: "node-a", image: image("injector"), pluginIndex: "40",
  runtimeHandler: "kata-qemu-snp", device: { major: 10, minor: 258 }, bindings: [{ pod: "guest-primary", container: "storage" }],
};
const disks = {
  namespace: "guests", nodeName: "node-a", image: image("storage"), stateDir: "/var/lib/guests",
  roles: [{ role: "data", claim: "data", file: "data", sizeBytes: 1024 ** 3, sizeLabel: "1Gi" }],
  table: { live: { data: { generation: 1, loop: 200 } }, retained: [], retired: [], reservedLoops: [], protectedLoops: [], firstPinnedLoop: 100 },
};
const stackProps = (labelDomain: string) => {
  const { namespace, nodeName, runtimeClassName, ...lifecycle } = lifecycleProps({ controller: { image: image("control") } });
  return { namespace, nodeName, runtimeClassName, labelDomain, lifecycle,
    fence: { policyNames: fence.policyNames, guestClaimPrefix: "guest-", messages: MESSAGES } };
};

test("every construct refuses a bad prop with a TypeError that names it", () => {
  const cases: [string, () => void, RegExp][] = [
    ["GuestLifecycle", () => new GuestLifecycle(Testing.chart(), "x", lifecycleProps({ namespace: "Guests" })), /namespace/],
    ["GuestAdmissionFence", () => new GuestAdmissionFence(Testing.chart(), "x", { ...fence, nodeName: "Node A" }), /nodeName/],
    ["GuestLogRetention", () => new GuestLogRetention(Testing.chart(), "x", {
      namespace: "guests", nodeName: "node-a", labelDomain: "guests.example.com", hostPath: "relative",
      scopes: [{ pod: "guest-primary", containers: ["app"] }], collector: { image: image("tools") } }), /hostPath/],
    ["GuestServices", () => new GuestServices(Testing.chart(), "x", { namespace: "guests", services: [{ name: "a", selector: { app: "a" }, ports: [0] }] }), /port/],
    ["SignedReleases", () => new SignedReleases(Testing.chart(), "x", { namespace: "guests", payloadTypes: {}, releaseSet: false, reading: [], authorities: [] } as any), /./],
    ["AttestedPullBroker", () => new AttestedPullBroker(Testing.chart(), "x", { ...broker, port: 70000 }), /port/],
    ["NriKeyInjector", () => new NriKeyInjector(Testing.chart(), "x", { ...injector, name: "Key" }), /name/],
    ["SealedDisks", () => new SealedDisks(Testing.chart(), "x", { ...disks, nodeName: "Node A" }), /nodeName/],
    ["ConfidentialGuestStack", () => new ConfidentialGuestStack(Testing.chart(), "x", { ...stackProps("guests.example.com"), lifecycle: undefined as any }), /lifecycle/],
  ];
  for (const [owner, build, pattern] of cases) assert.throws(build, refusedAs(owner, pattern), owner);
});

test("a label domain reserved for Kubernetes is refused by every construct that takes one", () => {
  for (const domain of ["guests.kubernetes.io", "kubernetes.io", "x.k8s.io"]) {
    const cases: [string, () => void][] = [
      ["GuestLifecycle", () => new GuestLifecycle(Testing.chart(), "x", lifecycleProps({ labelDomain: domain }))],
      ["GuestLogRetention", () => new GuestLogRetention(Testing.chart(), "x", {
        namespace: "guests", nodeName: "node-a", labelDomain: domain, hostPath: "/var/lib/guests/logs",
        scopes: [{ pod: "guest-primary", containers: ["app"] }], collector: { image: image("tools") } })],
      ["AttestedPullBroker", () => new AttestedPullBroker(Testing.chart(), "x", { ...broker, labelDomain: domain })],
      ["ConfidentialGuestStack", () => new ConfidentialGuestStack(Testing.chart(), "x", stackProps(domain))],
    ];
    for (const [owner, build] of cases) assert.throws(build, refusedAs(owner, /reserved for Kubernetes/), `${owner} ${domain}`);
  }
});

test("each validator is defined in one place", () => {
  const definitions = new Map<string, string[]>();
  for (const file of readdirSync(moduleDir).filter(name => name.endsWith(".ts"))) {
    for (const [, name] of readFileSync(join(moduleDir, file), "utf8").matchAll(/^(?:export )?(?:function|const) ([A-Za-z]+)\b/gm)) {
      definitions.set(name, [...(definitions.get(name) ?? []), file]);
    }
  }
  const validators = ["fail", "dnsLabel", "dnsSubdomain", "labelDomain", "labelKey", "labelValue", "labels", "integer", "boundedInteger",
    "hostPath", "isPlainObject", "knownFields", "pullSecrets", "image", "syncWave", "waveAnnotation", "waveAnnotations", "list", "record", "unique"];
  const repeated = validators.filter(name => (definitions.get(name) ?? []).length > 1).map(name => `${name}: ${definitions.get(name)!.join(", ")}`);
  assert.deepEqual(repeated, []);
});
