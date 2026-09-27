import assert from "node:assert/strict";
import test from "node:test";
import { evaluate } from "@marcbachmann/cel-js";
import { Testing } from "cdk8s";
import { GuestAdmissionFence, type GuestAdmissionFenceProps } from "../src/modules/k8s/confidential-guests";

// Admission decisions of the rendered policies, evaluated with a CEL
// interpreter: a test of what the fence admits, not of the expression text.
const MESSAGES = {
  creator: "creator", name: "name", placement: "placement", hostNamespaces: "hostNamespaces", serviceAccount: "serviceAccount",
  volumes: "volumes", claim: "claim", privilege: "privilege", initData: "initData",
};
const SA_P = "system:serviceaccount:guests:primary-lifecycle";
const PROPS: GuestAdmissionFenceProps = {
  namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "guests" } },
  policyNames: { creator: "guests-creator", shape: "guests-shape" },
  messages: MESSAGES,
  controllers: [
    { serviceAccount: { namespace: "guests", name: "primary-lifecycle" }, guests: [{ name: "guest-primary", claimPrefix: "guest-primary-data-v" }] },
    { serviceAccount: { namespace: "guests", name: "operator-lifecycle" }, guests: [{ name: "guest-operator", claimPrefix: "guest-operator-v" }] },
  ],
  runtimeClassName: "kata-qemu-snp", nodeName: "node-a", guestClaimPrefix: "guest-",
};

const chart = Testing.chart();
new GuestAdmissionFence(chart, "fence", PROPS);
const policies = Testing.synth(chart).filter((d: any) => d.kind === "ValidatingAdmissionPolicy");

/// The messages of the validations a CREATE is denied by, across both
/// policies; a policy whose match conditions do not hold contributes none. An
/// evaluation error denies (failurePolicy Fail) and is reported as such.
function denials(object: object, username = SA_P): string[] {
  const vars = { object, request: { userInfo: { username } } };
  const holds = (expression: string) => evaluate(expression, vars) === true;
  const denied: string[] = [];
  for (const { spec } of policies) {
    if (!(spec.matchConditions ?? []).every((c: any) => holds(c.expression))) continue;
    for (const v of spec.validations) {
      try {
        if (!holds(v.expression)) denied.push(v.message);
      } catch {
        denied.push(`error: ${v.message}`);
      }
    }
  }
  return denied;
}

const safe = { allowPrivilegeEscalation: false, capabilities: { drop: ["ALL"] } };
function guest(containers: object[], initContainers?: object[], spec: object = {}) {
  return {
    metadata: { name: "guest-primary", annotations: { "io.katacontainers.config.hypervisor.cc_init_data": "synthetic" } },
    spec: {
      runtimeClassName: "kata-qemu-snp", nodeName: "node-a", restartPolicy: "Never", automountServiceAccountToken: false,
      volumes: [{ name: "data", persistentVolumeClaim: { claimName: "guest-primary-data-v3" } }, { name: "config", configMap: { name: "c" } }],
      ...(initContainers ? { initContainers } : {}), containers, ...spec,
    },
  };
}

test("a well-formed guest is admitted, and the harness does decide the other shape rules", () => {
  assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }], [{ name: "init", securityContext: safe }])), []);
  assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }])), [], "no init containers");
  assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }], [])), [], "an empty init container list");
  assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }], undefined, { hostNetwork: true })), ["hostNamespaces"]);
  assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }]), "system:serviceaccount:guests:other"), ["creator"]);
});

test("every regular and init container must set allowPrivilegeEscalation to false explicitly", () => {
  const cases: [string, object | undefined, string[]][] = [
    ["no securityContext", undefined, ["privilege"]],
    ["a securityContext without the field", { runAsUser: 1000 }, ["privilege"]],
    ["an empty securityContext", {}, ["privilege"]],
    ["allowPrivilegeEscalation true", { allowPrivilegeEscalation: true }, ["privilege"]],
    ["allowPrivilegeEscalation false", { allowPrivilegeEscalation: false }, []],
    ["privileged with allowPrivilegeEscalation false", { allowPrivilegeEscalation: false, privileged: true }, ["privilege"]],
    ["unprivileged with allowPrivilegeEscalation false", { allowPrivilegeEscalation: false, privileged: false }, []],
  ];
  for (const [label, securityContext, expected] of cases) {
    const container = { name: "under-test", ...(securityContext ? { securityContext } : {}) };
    assert.deepEqual(denials(guest([container])), expected, `container: ${label}`);
    assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }], [container])), expected, `init container: ${label}`);
    assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }, container], [{ name: "init", securityContext: safe }])), expected,
      `second container: ${label}`);
    assert.deepEqual(denials(guest([{ name: "main", securityContext: safe }], [{ name: "init", securityContext: safe }, container])), expected,
      `second init container: ${label}`);
  }
});
