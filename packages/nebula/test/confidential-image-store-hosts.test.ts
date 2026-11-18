import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Testing } from "cdk8s";
import { ConfidentialOperator } from "../src/modules/k8s/confidential-workloads";

const image = `example.invalid/operator@sha256:${"a".repeat(64)}`;
const authority = "confidential-operator-images.qualified.svc:8084";
function synth(directory?: string, name?: string) {
  const chart = Testing.chart();
  new ConfidentialOperator(chart, "operator", { name, namespace: "qualified", watchNamespaces: ["qualified"],
    image, installCrds: false, imageStore: { claimName: "ciphertexts", repository: "qualified/workload",
      preparationPodSelector: { "confidential.nebula.dev/browser": "preparation" },
      ...(directory !== undefined ? { nodeRegistryHostsDirectory: directory } : {}) } });
  return Testing.synth(chart);
}

test("host transport is one one-shot init with only the exact authority directory", () => {
  const resources = synth("/etc/containerd/certs.d");
  const deployments = resources.filter(r => ["Deployment", "DaemonSet", "Pod", "Job"].includes(r.kind));
  assert.equal(deployments.length, 1, "host transport must not create another daemon or guest");
  const pod = deployments[0].spec.template.spec;
  assert.equal(pod.runtimeClassName, undefined);
  assert.equal(pod.hostNetwork, undefined);
  assert.equal(pod.hostPID, undefined);
  assert.equal(pod.enableServiceLinks, true, "the existing Service supplies its native service-link address");
  const [init] = pod.initContainers;
  assert.equal(pod.initContainers.length, 1);
  assert.equal(init.name, "image-store-registry-hosts");
  assert.equal(init.image, image);
  assert.deepEqual(init.command, ["/manager"]);
  assert.deepEqual(init.args, ["--configure-image-store-registry-hosts", `--image-store-authority=${authority}`,
    "--image-store-hosts-directory=/node-registry-hosts"]);
  assert.deepEqual(init.securityContext, { runAsUser: 0, runAsGroup: 0, allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } });
  assert.deepEqual(init.volumeMounts, [{ name: "registry-hosts", mountPath: "/node-registry-hosts" }]);
  assert.equal(init.env, undefined, "no credentials, caller-selected IP or API client configuration is injected");
  assert.deepEqual(pod.volumes.filter((v: any) => v.hostPath), [{ name: "registry-hosts", hostPath: {
    path: `/etc/containerd/certs.d/${authority}`, type: "DirectoryOrCreate" } }]);
  const [main] = pod.containers;
  assert.equal(pod.containers.length, 1);
  assert.equal(main.securityContext.runAsUser, 10001);
  assert.equal(main.securityContext.runAsNonRoot, true);
  assert.ok(main.args.includes(`--image-store-authority=${authority}`));
  assert.ok(!main.volumeMounts.some((v: any) => v.name === "registry-hosts"));
  assert.deepEqual(main.volumeMounts.map((v: any) => v.name), ["tmp", "image-store", "operator-api"]);
});

test("the root init has no API token while the nonroot manager keeps normal rotating API access", () => {
  const resources = synth("/etc/containerd/certs.d");
  const pod = resources.find(r => r.kind === "Deployment")!.spec.template.spec;
  assert.equal(pod.automountServiceAccountToken, false);
  const api = pod.volumes.find((v: any) => v.name === "operator-api");
  assert.deepEqual(api.projected, { defaultMode: 0o644, sources: [
    { serviceAccountToken: { path: "token", expirationSeconds: 3600 } },
    { configMap: { name: "kube-root-ca.crt", items: [{ key: "ca.crt", path: "ca.crt" }] } },
    { downwardAPI: { items: [{ path: "namespace", fieldRef: { apiVersion: "v1", fieldPath: "metadata.namespace" } }] } },
  ] });
  assert.deepEqual(pod.containers[0].volumeMounts.find((v: any) => v.name === "operator-api"), {
    name: "operator-api", mountPath: "/var/run/secrets/kubernetes.io/serviceaccount", readOnly: true });
  assert.ok(!pod.initContainers[0].volumeMounts.some((v: any) => v.name === "operator-api"));
  assert.ok(!resources.some(r => r.kind === "Secret"));
  assert.deepEqual(resources.filter(r => ["Role", "RoleBinding", "ServiceAccount"].includes(r.kind)),
    synth().filter(r => ["Role", "RoleBinding", "ServiceAccount"].includes(r.kind)), "host initialization needs no RBAC expansion");
});

test("only the opted-in private store Service and policy move into the operator wave", () => {
  const resources = synth("/etc/containerd/certs.d");
  const deployment = resources.find(r => r.kind === "Deployment")!;
  for (const kind of ["Service", "NetworkPolicy"]) {
    const store = resources.find(r => r.kind === kind && r.metadata.name === "confidential-operator-images")!;
    assert.equal(store.metadata.annotations["argocd.argoproj.io/sync-wave"], "-2");
    assert.equal(store.metadata.annotations["argocd.argoproj.io/sync-wave"], deployment.metadata.annotations["argocd.argoproj.io/sync-wave"]);
    assert.equal(synth().find(r => r.kind === kind && r.metadata.name === store.metadata.name)!.metadata.annotations, undefined);
  }
  const service = resources.find(r => r.kind === "Service")!;
  assert.equal(service.spec.externalIPs, undefined);
  assert.equal(service.spec.type, undefined);
  assert.deepEqual(service.spec.ports.map((p: any) => p.port), [8084, 8085]);
});

test("omitting host configuration preserves the prior operator entrypoint, token mounting and volumes", () => {
  const resources = synth();
  // Captured by executing the original construct from qualified c54b2273.
  // Includes the image-store Service/policy and their original sync ordering.
  assert.equal(createHash("sha256").update(JSON.stringify(resources)).digest("hex"),
    "e33f47a73dbdc2ecf64ac82b936c9f06a418aa79fb8bfbcc7b8acf2287bbcb5a");
  const pod = resources.find(r => r.kind === "Deployment")!.spec.template.spec;
  assert.equal(pod.initContainers, undefined);
  assert.equal(pod.automountServiceAccountToken, undefined);
  assert.equal(pod.enableServiceLinks, undefined);
  assert.deepEqual(pod.containers[0].args, ["--leader-elect"]);
  assert.deepEqual(pod.containers[0].volumeMounts.map((v: any) => v.name), ["tmp", "image-store"]);
  assert.deepEqual(pod.volumes.map((v: any) => v.name), ["tmp", "image-store"]);
  assert.ok(pod.volumes.every((v: any) => !v.hostPath && !v.projected));
  assert.equal(synth(undefined, "alternate").find(r => r.kind === "Deployment")!.metadata.name, "alternate");
});

test("host paths are normalized absolute directories and the fixed service-link name cannot address another operator", () => {
  for (const path of ["", "/", "etc/containerd", "/etc/../containerd", "/etc/./containerd", "/etc//containerd",
    "/etc/containerd/", "/etc\\containerd", "/etc/space path", "/etc/\0", "/etc/containerd\n", `/${"a".repeat(1025)}`]) {
    assert.throws(() => synth(path), /normalized absolute hosts directory/, JSON.stringify(path));
  }
  assert.throws(() => synth("/etc/containerd/certs.d", "alternate"), /default operator name/);
  assert.doesNotThrow(() => synth("/etc/docker/certs.d"));
});
