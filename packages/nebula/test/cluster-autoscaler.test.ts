import assert from "node:assert/strict";
import test from "node:test";
import { Testing } from "cdk8s";
import { K0smotronCluster } from "../src/modules/infra/k0s/k0smotron-cluster";
import { autoscalerAnnotations, type K0sInfraProvider, type K0sWorkerPool } from "../src/modules/infra/k0s/cluster";
import { ClusterAutoscaler, clusterAutoscalerValues } from "../src/modules/k8s/cluster-autoscaler";

const provider: K0sInfraProvider<{ size: string }> = {
  infraClusterApiGroup: "infrastructure.cluster.x-k8s.io",
  infraClusterKind: "AWSCluster",
  emitInfraCluster: () => {},
  emitMachineTemplate: (_scope, _id, ctx) => ({
    apiVersion: "infrastructure.cluster.x-k8s.io/v1beta2",
    kind: "AWSMachineTemplate",
    name: `${ctx.baseName}-t`,
  }),
};

function machineDeployments(pools: Record<string, K0sWorkerPool<{ size: string }>>) {
  const chart = Testing.chart();
  new K0smotronCluster(chart, "c", { name: "c", networkProvider: "custom", provider, workerPools: pools });
  return Testing.synth(chart).filter(r => r.kind === "MachineDeployment");
}

test("a static pool keeps its replicas and carries no autoscaler annotations", () => {
  const [md] = machineDeployments({ w: { replicas: 3, machine: { size: "m" } } });
  assert.equal(md.spec.replicas, 3);
  assert.equal(md.metadata.annotations, undefined);
  assert.equal(autoscalerAnnotations({ machine: { size: "m" } }), undefined);
});

test("an autoscaled pool has min/max, its labels and taints, and no replicas of its own", () => {
  const [md] = machineDeployments({
    ci: {
      autoscaling: { minSize: 0, maxSize: 6 },
      replicas: 2,
      nodeLabels: { "node-role.kubernetes.io/ci": "", tier: "spot" },
      taints: [{ key: "ci", value: "true", effect: "NoSchedule" }, { key: "spot", effect: "PreferNoSchedule" }],
      machine: { size: "l" },
    },
  });
  assert.equal(md.spec.replicas, undefined);
  assert.deepEqual(md.metadata.annotations, {
    "cluster.x-k8s.io/cluster-api-autoscaler-node-group-min-size": "0",
    "cluster.x-k8s.io/cluster-api-autoscaler-node-group-max-size": "6",
    "capacity.cluster-autoscaler.kubernetes.io/labels": "node-role.kubernetes.io/ci=,tier=spot",
    "capacity.cluster-autoscaler.kubernetes.io/taints": "ci=true:NoSchedule,spot:PreferNoSchedule",
  });
  assert.throws(() => autoscalerAnnotations({ autoscaling: { minSize: 3, maxSize: 2 }, machine: { size: "l" } }), /minSize/);
  assert.throws(() => autoscalerAnnotations({ autoscaling: { minSize: -1, maxSize: 2 }, machine: { size: "l" } }), /minSize/);
});

test("the autoscaler's chart values bind it to one cluster through its kubeconfig secret", () => {
  const values = clusterAutoscalerValues({ clusterName: "ci", clusterNamespace: "clusters", scaleDownUnneededTime: "20m", extraArgs: { "scan-interval": "20s" } });
  assert.equal(values.cloudProvider, "clusterapi");
  assert.equal(values.clusterAPIMode, "kubeconfig-incluster");
  assert.equal(values.clusterAPIKubeconfigSecret, "ci-kubeconfig");
  assert.equal(values.clusterAPIWorkloadKubeconfigPath, "/etc/kubernetes/value");
  assert.deepEqual(values.autoDiscovery, { clusterName: "ci", namespace: "clusters" });
  assert.equal(values.fullnameOverride, "cluster-autoscaler-ci");
  const args = values.extraArgs as Record<string, unknown>;
  assert.equal(args["scale-down-unneeded-time"], "20m");
  assert.equal(args["scale-down-delay-after-add"], "5m");
  assert.equal(args.expander, "least-waste");
  assert.equal(args["skip-nodes-with-local-storage"], false);
  assert.equal(args["scan-interval"], "20s");
});

// Rendering the chart needs helm and the chart repository: opt in with NEBULA_HELM_TESTS=1.
test("the construct renders one autoscaler deployment in the cluster's namespace with the kubeconfig mounted", {
  skip: process.env.NEBULA_HELM_TESTS !== "1",
}, () => {
  const chart = Testing.chart();
  new ClusterAutoscaler(chart, "ca", { clusterName: "ci" });
  const objects = Testing.synth(chart);
  const deployment = objects.find(o => o.kind === "Deployment");
  assert.equal(deployment.metadata.namespace, "default");
  assert.equal(deployment.metadata.name, "cluster-autoscaler-ci");
  const container = deployment.spec.template.spec.containers[0];
  const args: string[] = container.command ?? container.args;
  assert.ok(args.some((a: string) => a === "--cloud-provider=clusterapi"), args.join(" "));
  assert.ok(args.some((a: string) => a.startsWith("--node-group-auto-discovery=clusterapi:")), args.join(" "));
  assert.ok(args.some((a: string) => a === "--kubeconfig=/etc/kubernetes/value"), args.join(" "));
  assert.ok(args.some((a: string) => a === "--scale-down-unneeded-time=10m"), args.join(" "));
  const volume = deployment.spec.template.spec.volumes.find((v: { secret?: { secretName: string } }) => v.secret?.secretName === "ci-kubeconfig");
  assert.ok(volume, "kubeconfig secret volume");
  assert.ok(objects.some(o => o.kind === "ClusterRole" && JSON.stringify(o.rules).includes("cluster.x-k8s.io")));
  // Scale from zero reads the infrastructure templates' capacity; the chart's role leaves that group out.
  const infra = objects.find(o => o.kind === "ClusterRole" && o.metadata.name === "cluster-autoscaler-ci-infrastructure");
  assert.deepEqual(infra.rules, [{ apiGroups: ["infrastructure.cluster.x-k8s.io"], resourceNames: [], resources: ["*"], verbs: ["get", "list", "watch"] }]);
  const binding = objects.find(o => o.kind === "ClusterRoleBinding" && o.roleRef.name === "cluster-autoscaler-ci-infrastructure");
  assert.deepEqual(binding.subjects, [{ apiGroup: "", kind: "ServiceAccount", name: "cluster-autoscaler-ci", namespace: "default" }]);
});
