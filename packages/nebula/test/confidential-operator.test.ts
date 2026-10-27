import assert from "node:assert/strict";
import { test } from "node:test";
import { App, Chart, Testing } from "cdk8s";
import { generateKeyPairSync } from "node:crypto";
import { ConfidentialOperator, ConfidentialWorkload } from "../src/modules/k8s/confidential-workloads";
import { TRUSTEE_CHART } from "../src/modules/k8s/confidential-workloads/chart";

test("operator installation scopes watches and leader lease without key or disk mutation permissions", () => {
  const chart = new Chart(new App(), "test");
  new ConfidentialOperator(chart, "operator", { namespace: "operators", watchNamespaces: ["first", "second"],
    image: `example.invalid/operator@sha256:${"a".repeat(64)}` });
  const resources = Testing.synth(chart);
  const deployment = resources.find(r => r.kind === "Deployment")!;
  assert.deepEqual(deployment.spec.template.spec.containers[0].command, ["/manager"]);
  assert.ok(deployment.spec.template.spec.containers[0].args.includes("--leader-elect"));
  assert.equal(deployment.spec.template.spec.containers[0].env.find((e: any) => e.name === "WATCH_NAMESPACES").value, "first,second");
  assert.ok(!resources.some(r => r.kind === "ClusterRole" || r.kind === "Secret"));
  const roles = resources.filter(r => r.kind === "Role");
  assert.equal(roles.length, 3);
  for (const resource of resources.filter(r => ["Role", "RoleBinding", "ServiceAccount"].includes(r.kind))) {
    assert.ok(Number(resource.metadata.annotations["argocd.argoproj.io/sync-wave"]) <=
      Number(deployment.metadata.annotations["argocd.argoproj.io/sync-wave"]));
  }
  for (const role of roles) for (const rule of role.rules) {
    assert.ok(rule.resources.every((name: string) => !["*", "secrets", "pods/exec", "pods/attach"].includes(name)));
    if (rule.resources.includes("persistentvolumeclaims")) assert.deepEqual(rule.verbs, ["get", "list", "watch"]);
    if (rule.resources.includes("pods")) assert.ok(!rule.verbs.some((verb: string) => ["delete", "update", "patch"].includes(verb)));
    if (rule.resources.includes("leases")) assert.equal(role.metadata.namespace, "operators");
  }
});

test("workload declarations are retained by Argo instead of pruning enrolled guests", () => {
  const chart = new Chart(new App(), "retention");
  new ConfidentialWorkload(chart, "workload", { name: "workload", namespace: "qualified",
    spec: {
      profile: "workload", ownerPublicKeyPem: generateKeyPairSync("ec", { namedCurve: "prime256v1" })
        .publicKey.export({ format: "pem", type: "spki" }).toString(),
      guest: { measurement: "a".repeat(96), chipId: "b".repeat(128),
        minimumReportedTcb: { bootloader: 1, tee: 0, snp: 1, microcode: 1 } },
      nodeSelector: { "kubernetes.io/hostname": "node" },
      network: { ipv4AddressPattern: "^10[.].+$", ipv6AddressPattern: "^fd42:.+$" },
      trustee: { chart: TRUSTEE_CHART,
        kbsImage: `example.invalid/kbs@sha256:${"a".repeat(64)}`,
        tngImage: `example.invalid/tng@sha256:${"a".repeat(64)}`,
        gatewayImage: `example.invalid/gateway@sha256:${"a".repeat(64)}` },
      storageImage: `example.invalid/storage@sha256:${"a".repeat(64)}`,
      containers: [{ name: "app", image: `example.invalid/app@sha256:${"a".repeat(64)}`,
        command: ["/app"], uid: 11000, gid: 11000 }],
      resources: [["default", "image", "app"]],
    } });
  const resource = Testing.synth(chart).find(r => r.kind === "ConfidentialWorkload")!;
  assert.equal(resource.metadata.annotations["argocd.argoproj.io/sync-options"], "Prune=false,Delete=false");
});

test("access-link support can read only the named bootstrap Secrets and never expands disk or exec permissions", () => {
  const chart = Testing.chart();
  new ConfidentialOperator(chart, "operator", { namespace: "operators", watchNamespaces: ["first", "second"],
    image: `example.invalid/operator@sha256:${"a".repeat(64)}`, accessLinkSecrets: [{ namespace: "first", name: "workload-access" }] });
  const resources = Testing.synth(chart), first = resources.find(r => r.kind === "Role" && r.metadata.namespace === "first")!;
  const read = first.rules.find((r: any) => r.resources.includes("secrets") && r.verbs.includes("get"));
  assert.deepEqual(read.resourceNames, ["workload-access"]);
  assert.ok(!read.verbs.includes("list") && !read.verbs.includes("watch"));
  assert.ok(!resources.find(r => r.kind === "Role" && r.metadata.namespace === "second")!.rules.some((r: any) => r.resources.includes("secrets")));
  assert.ok(resources.some(r => r.kind === "Service" && r.metadata.name === "confidential-operator-access"));
  for (const role of resources.filter(r => r.kind === "Role")) for (const rule of role.rules) {
    assert.ok(!rule.resources.includes("pods/exec"));
    if (rule.resources.includes("persistentvolumeclaims")) assert.deepEqual(rule.verbs, ["get", "list", "watch"]);
  }
});
