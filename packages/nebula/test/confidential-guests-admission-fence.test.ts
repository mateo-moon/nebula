import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { GuestAdmissionFence, type GuestAdmissionFenceProps } from "../src/modules/k8s/confidential-guests";

const MESSAGES = {
  creator: "only the lifecycle controllers create guest Pods", name: "guest name outside the controller's role",
  placement: "guest must be a kata-qemu-snp Pod on node-a with restartPolicy Never", hostNamespaces: "guest must not share host or process namespaces",
  serviceAccount: "guest must run as the default ServiceAccount without a token",
  volumes: "guest volumes are limited to configMap, emptyDir and persistentVolumeClaim",
  claim: "guest mounts exactly one claim, named data, of its own role", privilege: "guest containers must not be privileged or escalate",
  initData: "guest must carry init-data and no Argo tracking-id",
};
const SA_P = "system:serviceaccount:guests:primary-lifecycle", SA_M = "system:serviceaccount:guests:maintenance-lifecycle";

function props(extra: Partial<GuestAdmissionFenceProps> = {}): GuestAdmissionFenceProps {
  return {
    namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "guests" } },
    policyNames: { creator: "guests-creator", shape: "guests-shape" },
    messages: MESSAGES,
    controllers: [
      { serviceAccount: { namespace: "guests", name: "primary-lifecycle" },
        guests: [{ name: "guest-primary", claimPrefix: "guest-primary-data-v" }, { name: "guest-primary-stage", claimPrefix: "guest-primary-stage-v" }] },
      { serviceAccount: { namespace: "guests", name: "maintenance-lifecycle" }, guests: [{ name: "guest-maintenance", claimPrefix: "guest-maintenance-v" }] },
    ],
    runtimeClassName: "kata-qemu-snp", nodeName: "node-a", guestClaimPrefix: "guest-",
    ...extra,
  };
}
const render = (value: GuestAdmissionFenceProps) => {
  const chart = Testing.chart();
  new GuestAdmissionFence(chart, "fence", value);
  return Testing.synth(chart);
};

test("two cluster-scoped policies, each with its binding, limited to the selected namespaces", () => {
  const selector = { matchLabels: { "kubernetes.io/metadata.name": "guests" } };
  const annotations = { "argocd.argoproj.io/sync-wave": "-2" };
  const unprivileged = "!has(c.securityContext) || (!(has(c.securityContext.privileged) && c.securityContext.privileged)"
    + " && !(has(c.securityContext.allowPrivilegeEscalation) && c.securityContext.allowPrivilegeEscalation))";
  const policy = (name: string, spec: object) => ({ apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicy",
    metadata: { name, annotations }, spec: { failurePolicy: "Fail",
      matchConstraints: { namespaceSelector: selector, resourceRules: [{ apiGroups: [""], apiVersions: ["v1"], operations: ["CREATE"], resources: ["pods"] }] },
      ...spec } });
  const binding = (name: string) => ({ apiVersion: "admissionregistration.k8s.io/v1", kind: "ValidatingAdmissionPolicyBinding",
    metadata: { name, annotations }, spec: { policyName: name, validationActions: ["Deny"], matchResources: { namespaceSelector: selector } } });
  assert.deepEqual(render(props()), [
    policy("guests-creator", {
      matchConditions: [{ name: "confidential-guest", expression: "(has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'kata-qemu-snp')"
        + " || (has(object.spec.volumes) && object.spec.volumes.exists(v, has(v.persistentVolumeClaim) && v.persistentVolumeClaim.claimName.startsWith('guest-')))" }],
      validations: [{ expression: `request.userInfo.username in ['${SA_P}', '${SA_M}']`, message: MESSAGES.creator }],
    }),
    binding("guests-creator"),
    policy("guests-shape", {
      matchConditions: [{ name: "lifecycle-controller", expression: `request.userInfo.username in ['${SA_P}', '${SA_M}']` }],
      validations: [
        { expression: `request.userInfo.username == '${SA_P}' ? object.metadata.name in ['guest-primary', 'guest-primary-stage'] : object.metadata.name == 'guest-maintenance'`,
          message: MESSAGES.name },
        { expression: "has(object.spec.runtimeClassName) && object.spec.runtimeClassName == 'kata-qemu-snp' && has(object.spec.nodeName) && object.spec.nodeName == 'node-a' && object.spec.restartPolicy == 'Never'",
          message: MESSAGES.placement },
        { expression: "!(has(object.spec.hostNetwork) && object.spec.hostNetwork) && !(has(object.spec.hostPID) && object.spec.hostPID) && !(has(object.spec.hostIPC) && object.spec.hostIPC) && !(has(object.spec.shareProcessNamespace) && object.spec.shareProcessNamespace)",
          message: MESSAGES.hostNamespaces },
        { expression: "(!has(object.spec.serviceAccountName) || object.spec.serviceAccountName == 'default') && has(object.spec.automountServiceAccountToken) && object.spec.automountServiceAccountToken == false",
          message: MESSAGES.serviceAccount },
        { expression: "has(object.spec.volumes) && object.spec.volumes.all(v, has(v.configMap) || has(v.emptyDir) || has(v.persistentVolumeClaim))",
          message: MESSAGES.volumes },
        { expression: "has(object.spec.volumes) && object.spec.volumes.filter(v, has(v.persistentVolumeClaim)).size() == 1 && object.spec.volumes.exists(v, v.name == 'data' && has(v.persistentVolumeClaim)"
          + " && v.persistentVolumeClaim.claimName.startsWith(object.metadata.name == 'guest-primary' ? 'guest-primary-data-v' : object.metadata.name == 'guest-primary-stage' ? 'guest-primary-stage-v' : 'guest-maintenance-v'))",
          message: MESSAGES.claim },
        { expression: `object.spec.containers.all(c, ${unprivileged}) && (!has(object.spec.initContainers) || object.spec.initContainers.all(c, ${unprivileged}))`,
          message: MESSAGES.privilege },
        { expression: "has(object.metadata.annotations) && 'io.katacontainers.config.hypervisor.cc_init_data' in object.metadata.annotations && !('argocd.argoproj.io/tracking-id' in object.metadata.annotations)",
          message: MESSAGES.initData },
      ],
    }),
    binding("guests-shape"),
  ]);
});

test("one controller needs no branch; three chain their branches; condition names and wave are props", () => {
  const one = render(props({ controllers: [props().controllers[1]], conditionNames: { guest: "guest", controller: "controller" }, wave: "-4" }));
  assert.equal(one[2].spec.validations[0].expression, "object.metadata.name == 'guest-maintenance'");
  assert.deepEqual(one[2].spec.matchConditions.map((c: any) => c.name), ["controller"]);
  assert.deepEqual(one[0].spec.matchConditions.map((c: any) => c.name), ["guest"]);
  assert.equal(one[0].metadata.annotations["argocd.argoproj.io/sync-wave"], "-4");
  const three = render(props({ controllers: [...props().controllers,
    { serviceAccount: { namespace: "guests", name: "extra-lifecycle" }, guests: [{ name: "guest-extra", claimPrefix: "guest-extra-v" }] }] }));
  assert.equal(three[2].spec.validations[0].expression, `request.userInfo.username == '${SA_P}' ? object.metadata.name in ['guest-primary', 'guest-primary-stage']`
    + ` : request.userInfo.username == '${SA_M}' ? object.metadata.name == 'guest-maintenance' : object.metadata.name == 'guest-extra'`);
});

test("the fence cannot be rendered cluster-wide or under shared names", () => {
  for (const namespaceSelector of [undefined, {}, { matchLabels: {} }, { matchExpressions: [] }]) {
    assert.throws(() => render(props({ namespaceSelector } as any)), /namespaceSelector is required/, JSON.stringify(namespaceSelector));
  }
  const byExpression = render(props({ namespaceSelector: { matchExpressions: [{ key: "guests.example.com/fenced", operator: "Exists" }] } }));
  assert.deepEqual(byExpression[1].spec.matchResources, { namespaceSelector: { matchExpressions: [{ key: "guests.example.com/fenced", operator: "Exists" }] } });
  assert.throws(() => render(props({ policyNames: undefined } as any)), /policyNames/);
  assert.throws(() => render(props({ policyNames: { creator: "same", shape: "same" } })), /differ/);
  assert.throws(() => render(props({ messages: undefined } as any)), /messages/);
  assert.throws(() => render(props({ messages: { ...MESSAGES, claim: "" } })), /messages.claim/);
});

test("values that reach CEL string literals cannot break out of them", () => {
  const refusals: [string, Partial<GuestAdmissionFenceProps>, RegExp][] = [
    ["quote in the node", { nodeName: "node-a' || true || '" }, /nodeName/],
    ["quote in the runtime class", { runtimeClassName: "x' || 'y" }, /runtimeClassName/],
    ["quote in the claim prefix", { guestClaimPrefix: "guest-') || true || ('" }, /guestClaimPrefix/],
    ["quote in a guest", { controllers: [{ serviceAccount: { namespace: "guests", name: "a" }, guests: [{ name: "a'", claimPrefix: "a" }] }] }, /guest name/],
    ["backslash in a claim prefix", { controllers: [{ serviceAccount: { namespace: "guests", name: "a" }, guests: [{ name: "a", claimPrefix: "a\\" }] }] }, /claimPrefix/],
    ["quote in an account", { controllers: [{ serviceAccount: { namespace: "guests", name: "a'" }, guests: [{ name: "a", claimPrefix: "a" }] }] }, /ServiceAccount/],
    ["no controllers", { controllers: [] }, /controllers/],
    ["controller without guests", { controllers: [{ serviceAccount: { namespace: "guests", name: "a" }, guests: [] }] }, /guests/],
    ["guest under two controllers", { controllers: [...props().controllers, { serviceAccount: { namespace: "guests", name: "x" }, guests: [{ name: "guest-primary", claimPrefix: "x" }] }] }, /twice/],
    ["controller twice", { controllers: [props().controllers[1], props().controllers[1]] }, /twice/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => render(props(change)), error, label);
});
