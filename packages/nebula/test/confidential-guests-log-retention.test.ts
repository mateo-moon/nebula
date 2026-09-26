import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { GuestLogRetention, LOG_RETENTION_COMMAND, canonicalJson, type GuestLogRetentionProps } from "../src/modules/k8s/confidential-guests";
import { DOMAIN, NAMESPACE, NODE, image, sha256 } from "./confidential-guests-fixtures";

const CODE = { "follow.py": "import os\nprint(os.environ['LOG_SCOPE'])\n" };
const SCOPES = [{ pod: "guest-primary", containers: ["storage", "attest", "app"] }, { pod: "guest-maintenance", containers: ["attest"] }];
function props(extra: Partial<GuestLogRetentionProps> = {}): GuestLogRetentionProps {
  return { namespace: NAMESPACE, nodeName: NODE, labelDomain: DOMAIN, scopes: SCOPES, hostPath: "/var/lib/guests/logs",
    collector: { code: CODE, runtimeImage: image("python") }, ...extra };
}
const render = (value: GuestLogRetentionProps) => {
  const chart = Testing.chart();
  new GuestLogRetention(chart, "logs", value);
  return Testing.synth(chart);
};

test("code mode: access to the listed guests' logs only, the code, and one collector on the guests' node", () => {
  const annotations = { "argocd.argoproj.io/sync-wave": "-3" };
  const meta = (name: string) => ({ name, namespace: NAMESPACE, annotations });
  const labels = { app: "guests-log-retention" };
  assert.deepEqual(render(props()), [
    { apiVersion: "v1", kind: "ServiceAccount", metadata: meta("log-retention"), automountServiceAccountToken: true },
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "Role", metadata: meta("log-retention"), rules: [
      { apiGroups: [""], resources: ["pods/log"], resourceNames: ["guest-primary", "guest-maintenance"], verbs: ["get"] }] },
    { apiVersion: "rbac.authorization.k8s.io/v1", kind: "RoleBinding", metadata: meta("log-retention"),
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "log-retention" },
      subjects: [{ kind: "ServiceAccount", name: "log-retention", namespace: NAMESPACE }] },
    { apiVersion: "v1", kind: "ConfigMap", metadata: meta("log-retention-code"), data: CODE },
    { apiVersion: "apps/v1", kind: "Deployment", metadata: meta("log-retention"), spec: {
      replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels },
      template: { metadata: { labels, annotations: { [`${DOMAIN}/code-sha256`]: sha256(canonicalJson(CODE)) } }, spec: {
        nodeName: NODE, serviceAccountName: "log-retention", automountServiceAccountToken: true, terminationGracePeriodSeconds: 15,
        containers: [{ name: "collector", image: image("python"), command: ["python3", "-I", "-S", "-B", "/opt/log-retention/follow.py"],
          env: [{ name: "LOG_NAMESPACE", value: NAMESPACE },
            { name: "LOG_SCOPE", value: '[["guest-primary",["storage","attest","app"]],["guest-maintenance",["attest"]]]' }],
          securityContext: { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
          resources: { requests: { cpu: "10m", memory: "32Mi" }, limits: { memory: "256Mi" } },
          volumeMounts: [{ name: "logs", mountPath: "/logs" }, { name: "code", mountPath: "/opt/log-retention", readOnly: true }] }],
        volumes: [{ name: "logs", hostPath: { path: "/var/lib/guests/logs", type: "DirectoryOrCreate" } },
          { name: "code", configMap: { name: "log-retention-code" } }],
      } },
    } },
  ]);
});

test("image mode, name, wave and pull secrets", () => {
  const docs = render(props({ collector: { image: image("tools") }, name: "logs", wave: "-9", imagePullSecrets: ["pull"] }));
  assert.deepEqual(docs.map(d => `${d.kind}/${d.metadata.name}`), ["ServiceAccount/logs", "Role/logs", "RoleBinding/logs", "Deployment/logs"]);
  const deployment = docs[3];
  assert.equal(deployment.metadata.annotations["argocd.argoproj.io/sync-wave"], "-9");
  assert.deepEqual(deployment.spec.template.metadata, { labels: { app: "guests-logs" } });
  const pod = deployment.spec.template.spec;
  assert.deepEqual(pod.imagePullSecrets, [{ name: "pull" }]);
  assert.deepEqual(pod.containers[0].command, [...LOG_RETENTION_COMMAND]);
  assert.deepEqual(pod.containers[0].volumeMounts, [{ name: "logs", mountPath: "/logs" }]);
  assert.deepEqual(pod.volumes, [{ name: "logs", hostPath: { path: "/var/lib/guests/logs", type: "DirectoryOrCreate" } }]);
  const custom = render(props({ collector: { image: image("tools"), command: ["/bin/follow"] } }));
  assert.deepEqual(custom[3].spec.template.spec.containers[0].command, ["/bin/follow"]);
});

test("inputs are checked", () => {
  const refusals: [string, Partial<GuestLogRetentionProps>, RegExp][] = [
    ["no label domain", { labelDomain: undefined as any }, /labelDomain/],
    ["relative host path", { hostPath: "logs" }, /hostPath/],
    ["host root", { hostPath: "/" }, /hostPath/],
    ["unnormalized host path", { hostPath: "/var/lib/../etc" }, /hostPath/],
    ["no scopes", { scopes: [] }, /scopes/],
    ["scope without containers", { scopes: [{ pod: "guest-a", containers: [] }] }, /containers/],
    ["same Pod twice", { scopes: [SCOPES[1], SCOPES[1]] }, /twice/],
    ["two files, no entry", { collector: { code: { ...CODE, "util.py": "" }, runtimeImage: image("python") } }, /entry/],
    ["entry not in code", { collector: { code: CODE, entry: "main.py", runtimeImage: image("python") } }, /entry/],
    ["file path", { collector: { code: { "../follow.py": "" }, runtimeImage: image("python") } }, /file/],
    ["tagged runtime", { collector: { code: CODE, runtimeImage: "docker.io/library/python:3" } }, /digestImage/],
    ["tagged image", { collector: { image: "ghcr.io/example/tools:1" } }, /digestImage/],
    ["no collector", { collector: undefined as any }, /collector/],
  ];
  for (const [label, change, error] of refusals) assert.throws(() => render(props(change)), error, label);
  const two = render(props({ collector: { code: { ...CODE, "util.py": "" }, entry: "follow.py", runtimeImage: image("python") } }));
  assert.deepEqual(two[4].spec.template.spec.containers[0].command.at(-1), "/opt/log-retention/follow.py");
});
