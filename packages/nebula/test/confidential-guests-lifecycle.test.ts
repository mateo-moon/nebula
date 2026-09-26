import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import {
  GuestLifecycle,
  INIT_DATA_ANNOTATION,
  LIFECYCLE_CLAIM_PLACEHOLDER,
  LIFECYCLE_CONTROLLER_COMMAND,
  LIFECYCLE_SPEC_VERSIONS,
  canonicalJson,
  guestLifecycleSpec,
  lifecycleIgnoreDifferences,
  lifecycleLabelKey,
  type GuestLifecycleProps,
  type GuestLifecycleRole,
} from "../src/modules/k8s/confidential-guests";
import { CONTROLLER_CODE, DOMAIN, NAMESPACE, NODE, image, initData, lifecycleProps, measured, roles, sha256 } from "./confidential-guests-fixtures";

function render(props: GuestLifecycleProps) {
  const chart = Testing.chart();
  const lifecycle = new GuestLifecycle(chart, "lifecycle", props);
  return { lifecycle, docs: Testing.synth(chart) };
}
const setup = { "argocd.argoproj.io/sync-wave": "-2" };
const kept = { ...setup, "argocd.argoproj.io/sync-options": "Prune=false,Delete=false" };
const last = { "argocd.argoproj.io/sync-wave": "0" };

test("code mode: per role the code, spec, ledger and imported ledger, then access and the controller, in that order", () => {
  const props = lifecycleProps();
  const { docs } = render(props);
  assert.deepEqual(docs.map(d => `${d.kind}/${d.metadata.name}`), [
    "ConfigMap/primary-lifecycle-code", "ConfigMap/primary-lifecycle-spec", "ConfigMap/primary-lifecycle-ledger", "ConfigMap/primary-budget-v1",
    "ServiceAccount/primary-lifecycle", "Role/primary-lifecycle", "RoleBinding/primary-lifecycle", "Deployment/primary-lifecycle",
    "ConfigMap/operator-lifecycle-code", "ConfigMap/operator-lifecycle-spec", "ConfigMap/operator-lifecycle-ledger",
    "ServiceAccount/operator-lifecycle", "Role/operator-lifecycle", "RoleBinding/operator-lifecycle", "Deployment/operator-lifecycle",
  ]);
  const operator = docs.slice(8);
  const meta = (name: string, annotations: Record<string, string>) => ({ name, namespace: NAMESPACE, annotations });
  const labels = { app: "guests-operator-lifecycle" };
  assert.deepEqual(operator, [
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta("operator-lifecycle-code", setup), data: CONTROLLER_CODE },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta("operator-lifecycle-spec", last),
      data: { "spec.json": canonicalJson(guestLifecycleSpec(props, "operator")) } },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta("operator-lifecycle-ledger", kept) },
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta("operator-lifecycle", setup), automountServiceAccountToken: false },
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: meta("operator-lifecycle", setup), rules: [
      { apiGroups: [""], resources: ["pods"], resourceNames: ["guest-operator"], verbs: ["get", "delete"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["create"] },
      { apiGroups: [""], resources: ["configmaps"], resourceNames: ["operator-lifecycle-spec"], verbs: ["get"] },
      { apiGroups: [""], resources: ["configmaps"], resourceNames: ["operator-lifecycle-ledger"], verbs: ["get", "patch"] },
    ] },
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: meta("operator-lifecycle", setup),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "operator-lifecycle" },
      subjects: [{ kind: "ServiceAccount", name: "operator-lifecycle", namespace: NAMESPACE }] },
    { apiVersion: "apps/v1", kind: "Deployment", metadata: meta("operator-lifecycle", last), spec: {
      replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels },
      template: {
        metadata: { labels, annotations: { [`${DOMAIN}/code-sha256`]: sha256(canonicalJson(CONTROLLER_CODE)) } },
        spec: {
          nodeName: NODE, serviceAccountName: "operator-lifecycle", automountServiceAccountToken: true, enableServiceLinks: false,
          terminationGracePeriodSeconds: 15,
          containers: [{
            name: "controller", image: image("python"),
            command: ["python3", "-I", "-S", "-B", "-c", "import sys; sys.path.insert(0, '/opt/lifecycle'); from guest_control import lifecycle; lifecycle.main()"],
            env: [{ name: "LIFECYCLE_ROLE", value: "operator" }, { name: "LIFECYCLE_NAMESPACE", value: NAMESPACE }],
            securityContext: { runAsUser: 65532, runAsGroup: 65532, runAsNonRoot: true, allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] }, seccompProfile: { type: "RuntimeDefault" } },
            resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "128Mi" } },
            volumeMounts: [{ name: "code", mountPath: "/opt/lifecycle/guest_control", readOnly: true }],
          }],
          volumes: [{ name: "code", configMap: { name: "operator-lifecycle-code" } }],
        },
      },
    } },
  ]);
  const primary = docs.slice(0, 8);
  assert.deepEqual(primary[3].data, { state: JSON.stringify({ version: 1, attempts: [] }) });
  assert.deepEqual(primary[3].metadata.annotations, kept, "an imported ledger is kept like the ledger");
  assert.deepEqual(primary[5].rules[0].resourceNames, ["guest-primary", "guest-primary-stage"]);
  assert.deepEqual(primary[5].rules[2].resourceNames, ["primary-lifecycle-spec", "primary-budget-v1"]);
});

test("the spec carries every release with its HOST_DATA and the role's scope", () => {
  const props = lifecycleProps();
  const [primary] = roles();
  const spec = guestLifecycleSpec(props, "primary");
  assert.deepEqual(spec, {
    version: 1, role: "primary", holder_name: "guest-primary", stage_name: "guest-primary-stage", generation: 2,
    claims: { data: "guest-primary-data-v2", stage: "guest-primary-stage-v1" },
    releases: {
      r1: { template: primary.releases.r1, init_data_sha256: initData("primary-r1").initDataSha256, stage_containers: ["storage", "attest"] },
      r2: { template: primary.releases.r2, init_data_sha256: initData("primary-r2").initDataSha256, stage_containers: ["storage", "attest"] },
    },
    current: "r2", previous: "r1", rollout_id: 4, grace_seconds: 120,
    containers: ["storage", "attest", "app"], initializers: ["initialize"],
    live: ["attest", "/livez", 8081], ready: ["app", "/readyz", 8081], startup_seconds: 600, budget: { epoch: 2, limit: 3 },
    rollout: { limit: 3, stage_seconds: 300, backoff_seconds: 60, settle_seconds: 10 },
  });
  const operator = guestLifecycleSpec(props, "operator");
  assert.equal(operator.stage_name, null);
  assert.deepEqual(operator.claims, { data: "guest-operator-v1", stage: null });
  assert.equal(operator.previous, null);
  assert.equal(operator.rollout_id, 0);
  assert.deepEqual(operator.releases.m1.stage_containers, []);
  assert.throws(() => guestLifecycleSpec(props, "other"), /unknown role/);
});

test("image mode: no code ConfigMap; the controller reads its node, runtime class and label domains from spec version 2", () => {
  const props = lifecycleProps({ controller: { image: image("control") }, acceptLabelDomains: ["old.example.org"], imagePullSecrets: ["pull"] });
  const { docs } = render(props);
  assert.ok(!docs.some(d => d.metadata.name.endsWith("-code")));
  const deployment = docs.find(d => d.kind === "Deployment" && d.metadata.name === "primary-lifecycle");
  assert.deepEqual(deployment.spec.template.metadata, { labels: { app: "guests-primary-lifecycle" } }, "no code hash to roll on");
  const pod = deployment.spec.template.spec;
  assert.deepEqual(pod.imagePullSecrets, [{ name: "pull" }]);
  assert.equal(pod.volumes, undefined);
  const [container] = pod.containers;
  assert.equal(container.image, image("control"));
  assert.deepEqual(container.command, [...LIFECYCLE_CONTROLLER_COMMAND]);
  assert.deepEqual(LIFECYCLE_CONTROLLER_COMMAND, ["python3", "-I", "-B", "-m", "confidential_guests.lifecycle"]);
  assert.equal(container.volumeMounts, undefined);
  assert.deepEqual(container.env, [{ name: "LIFECYCLE_ROLE", value: "primary" }, { name: "LIFECYCLE_NAMESPACE", value: NAMESPACE }],
    "the environment of code mode: everything else is in the spec");
  const spec = guestLifecycleSpec(props, "primary");
  assert.deepEqual(spec, { ...guestLifecycleSpec(lifecycleProps(), "primary"), version: 2,
    node_name: NODE, runtime_class_name: "kata-qemu-snp", label_domains: [DOMAIN, "old.example.org"] }, "version 1 plus the placement and the label domains, emitted domain first");
  assert.equal(docs.find(d => d.metadata.name === "primary-lifecycle-spec").data["spec.json"], canonicalJson(spec));
  assert.deepEqual(LIFECYCLE_SPEC_VERSIONS, { code: 1, image: 2 });
  const custom = render(lifecycleProps({ controller: { image: image("control"), command: ["/bin/controller", "--serve"] } }));
  assert.deepEqual(custom.docs.find(d => d.kind === "Deployment").spec.template.spec.containers[0].command, ["/bin/controller", "--serve"]);
});

test("every claim belongs to one guest: a stage boot never mounts its holder's disk and roles share no claim", () => {
  const refusals: [string, GuestLifecycleProps, RegExp][] = [
    ["the stage claim is the data claim", withRole(0, r => { r.stage.claim = r.claim; }),
      /role primary: the stage claim is the data claim guest-primary-data-v2/],
    ["two roles share a claim", withRole(1, r => { r.claim = "guest-primary-data-v2"; r.releases = { m1: measured("operator", { claim: r.claim }) }; }),
      /claim "guest-primary-data-v2" is declared twice/],
    ["a role claims another role's stage disk", withRole(1, r => { r.claim = "guest-primary-stage-v1"; r.releases = { m1: measured("operator", { claim: r.claim }) }; }),
      /claim "guest-primary-stage-v1" is declared twice/],
    ["a claim that is the placeholder", lifecycleProps({ claimPlaceholder: "guest-operator-v1", roles: roles().slice(1) }),
      /role operator: claim guest-operator-v1 is the claim placeholder/],
    ["an imported ledger named like another role's ConfigMap", withRole(1, r => { r.importedLedger = { name: "primary-lifecycle-spec", state: {} }; }),
      /ConfigMap "primary-lifecycle-spec" is declared twice/],
    ["a stage without a container the controller requires", lifecycleProps({ requiredStageContainers: ["app"] }),
      /role primary: the stage boot must run app/],
    ["a required stage container that is no name", lifecycleProps({ requiredStageContainers: [""] }), /requiredStageContainers/],
  ];
  for (const [label, props, error] of refusals) assert.throws(() => render(props), error, label);
  assert.deepEqual(render(lifecycleProps({ requiredStageContainers: ["storage", "attest"] })).docs, render(lifecycleProps()).docs,
    "mirroring a controller's stage rule changes no byte");
});

test("any label domain the deployment controls is used, and none is assumed", () => {
  const { lifecycle, docs } = render(lifecycleProps({ labelDomain: "ops.example.net" }));
  assert.equal(lifecycle.lifecycleLabel, "ops.example.net/lifecycle");
  assert.equal(lifecycleLabelKey("ops.example.net"), "ops.example.net/lifecycle");
  const deployment = docs.find(d => d.kind === "Deployment");
  assert.deepEqual(Object.keys(deployment.spec.template.metadata.annotations), ["ops.example.net/code-sha256"]);
  for (const labelDomain of [undefined, "", "guests", "Guests.example.com", "example.com/x"]) {
    assert.throws(() => render(lifecycleProps({ labelDomain } as any)), /labelDomain/, String(labelDomain));
  }
  assert.throws(() => render(lifecycleProps({ acceptLabelDomains: ["old.example.org"] })), /image-mode/);
  assert.throws(() => render(lifecycleProps({ controller: { image: image("control") }, acceptLabelDomains: [DOMAIN] })), /twice/);
});

test("the controllers' ledgers are ignored by Argo: imported ledgers first, then lifecycle ledgers, in role order", () => {
  const props = lifecycleProps();
  const expected = ["primary-budget-v1", "primary-lifecycle-ledger", "operator-lifecycle-ledger"].map(name =>
    ({ group: "", kind: "ConfigMap", name, namespace: NAMESPACE, jsonPointers: ["/data/state"] }));
  assert.deepEqual(lifecycleIgnoreDifferences(props), expected);
  assert.deepEqual(render(props).lifecycle.ignoreDifferences(), expected);
  const both = lifecycleIgnoreDifferences({ namespace: "ns", roles: [{ role: "a", importedLedger: { name: "a-v1" } }, { role: "b", importedLedger: { name: "b-v1" } }] });
  assert.deepEqual(both.map(e => e.name), ["a-v1", "b-v1", "a-lifecycle-ledger", "b-lifecycle-ledger"]);
});

test("the construct exposes what the admission fence and Services derive from it", () => {
  const { lifecycle } = render(lifecycleProps());
  assert.deepEqual(lifecycle.serviceAccounts, [
    { role: "primary", namespace: NAMESPACE, name: "primary-lifecycle" }, { role: "operator", namespace: NAMESPACE, name: "operator-lifecycle" }]);
  assert.equal(lifecycle.specs.primary.current, "r2");
  assert.equal(LIFECYCLE_CLAIM_PLACEHOLDER, "${DISK}");
});

function withRole(index: number, change: (role: GuestLifecycleRole & Record<string, any>) => void): GuestLifecycleProps {
  const all = roles() as (GuestLifecycleRole & Record<string, any>)[];
  change(all[index]);
  return lifecycleProps({ roles: all });
}
function withTemplate(change: (pod: any) => void, remeasure = true): GuestLifecycleProps {
  return withRole(1, role => {
    const pod: any = structuredClone(role.releases.m1);
    change(pod);
    if (remeasure) pod.metadata.annotations[INIT_DATA_ANNOTATION] ??= initData("m1").ccInitData;
    role.releases = { m1: pod };
  });
}

test("templates outside the controller's contract fail the render, not the controller", () => {
  const refusals: [string, GuestLifecycleProps, RegExp][] = [
    ["named other than the holder", withTemplate(p => { p.metadata.name = "guest-other"; }), /holder/],
    ["another namespace", withTemplate(p => { p.metadata.namespace = "other"; }), /namespace/],
    ["no init-data", withTemplate(p => { delete p.metadata.annotations[INIT_DATA_ANNOTATION]; }, false), /init-data/],
    ["broken init-data", withTemplate(p => { p.metadata.annotations[INIT_DATA_ANNOTATION] = "bm90IGd6aXA="; }), /init-data/],
    ["Argo tracking id", withTemplate(p => { p.metadata.annotations["argocd.argoproj.io/tracking-id"] = "x"; }), /tracking-id/],
    ["a create nonce", withTemplate(p => { p.metadata.annotations[`${DOMAIN}/create-nonce`] = "x"; }), /create-nonce/],
    ["live metadata", withTemplate(p => { p.metadata.uid = "x"; }), /live metadata/],
    ["restartPolicy", withTemplate(p => { p.spec.restartPolicy = "Always"; }), /restartPolicy/],
    ["grace", withTemplate(p => { p.spec.terminationGracePeriodSeconds = 30; }), /terminationGracePeriodSeconds/],
    ["token", withTemplate(p => { delete p.spec.automountServiceAccountToken; }), /automountServiceAccountToken/],
    ["service account", withTemplate(p => { p.spec.serviceAccountName = "admin"; }), /ServiceAccount/],
    ["runtime class", withTemplate(p => { p.spec.runtimeClassName = "runc"; }), /runtimeClassName/],
    ["node", withTemplate(p => { p.spec.nodeName = "node-b"; }), /nodeName/],
    ["host network", withTemplate(p => { p.spec.hostNetwork = true; }), /hostNetwork/],
    ["hostPath volume", withTemplate(p => { p.spec.volumes.push({ name: "host", hostPath: { path: "/" } }); }), /exactly one of/],
    ["two claims", withTemplate(p => { p.spec.volumes.push({ name: "more", persistentVolumeClaim: { claimName: "x" } }); }), /exactly one claim/],
    ["claim not named data", withTemplate(p => { p.spec.volumes[0].name = "disk"; }), /exactly one claim/],
    ["another role's claim", withTemplate(p => { p.spec.volumes[0].persistentVolumeClaim.claimName = "guest-primary-data-v2"; }), /data claim/],
    ["live probe moved", withTemplate(p => { p.spec.containers[1].readinessProbe.httpGet.path = "/other"; }), /live signal/],
    ["release of another role", withRole(0, r => { r.releases = { ...r.releases, r1: measured("operator") }; }), /holder/],
    ["release with other containers", withRole(0, r => {
      const pod: any = structuredClone(r.releases.r1);
      pod.spec.containers.pop();
      r.releases = { ...r.releases, r1: pod };
    }), /same containers/],
    ["broken init-data names the release", withTemplate(p => { p.metadata.annotations[INIT_DATA_ANNOTATION] = "bm90IGd6aXA="; }), /role operator release m1: init-data/],
    ["undeclared current", withRole(0, r => { r.current = "r9"; }), /current release/],
    ["previous equals current", withRole(0, r => { r.previous = "r2"; }), /previous/],
    ["undeclared previous", withRole(0, r => { r.previous = "r9"; }), /previous/],
    ["bad release id", withRole(1, r => { r.releases = { "M 1": r.releases.m1 }; r.current = "M 1"; }), /release id/],
    ["stage container not in template", withRole(0, r => { r.stage.containers = ["storage", "other"]; }), /stage container/],
    ["live container not in template", withRole(1, r => { r.live = ["other", "/livez", 8081]; }), /live container/],
    ["bad port", withRole(1, r => { r.ready = ["attest", "/livez", 0]; }), /port/],
    ["duplicate role", lifecycleProps({ roles: [roles()[1], roles()[1]] }), /twice/],
    ["holder shared by roles", withRole(1, r => { r.holder = "guest-primary-stage"; }), /twice/],
    ["bad role name", withRole(1, r => { r.role = "Operator"; }), /role/],
    ["label value too long", withRole(1, r => { r.role = "m".repeat(60); }), /label value/],
    ["generation 0", withRole(1, r => { r.generation = 0; }), /generation/],
  ];
  for (const [label, props, error] of refusals) assert.throws(() => render(props), error, label);
});

test("controller, budget and rollout inputs are required and checked", () => {
  const refusals: [string, Partial<GuestLifecycleProps>, RegExp][] = [
    ["no controller", { controller: undefined as any }, /controller/],
    ["tagged runtime", { controller: { code: CONTROLLER_CODE, runtimeImage: "docker.io/library/python:3", package: "guest_control" } }, /digestImage/],
    ["tagged image", { controller: { image: "ghcr.io/example/control:latest" } }, /digestImage/],
    ["no lifecycle.py", { controller: { code: { "__init__.py": "" }, runtimeImage: image("python"), package: "guest_control" } }, /lifecycle\.py/],
    ["file outside the package", { controller: { code: { ...CONTROLLER_CODE, "../x.py": "" }, runtimeImage: image("python"), package: "guest_control" } }, /file/],
    ["package with code in it", { controller: { code: CONTROLLER_CODE, runtimeImage: image("python"), package: "x; import os" } }, /package/],
    ["no budget", { budget: undefined as any }, /budget/],
    ["no startup", { startupSeconds: undefined as any }, /startupSeconds/],
    ["no rollout", { rollout: undefined as any }, /rollout/],
    ["bad node", { nodeName: "Node A" }, /nodeName/],
    ["no runtime class", { runtimeClassName: undefined as any }, /runtimeClassName/],
    ["no roles", { roles: [] }, /roles/],
    ["bad wave", { waves: { setup: "first" } }, /wave/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => render(lifecycleProps(change)), error, label);
  assert.equal(render(lifecycleProps({ claimPlaceholder: "@claim@", roles: roles().slice(1) })).docs.length, 7, "a custom placeholder");
});
