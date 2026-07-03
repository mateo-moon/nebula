/**
 * build-cluster-template-chart — generate a k0rdent ClusterTemplate Helm chart
 * from the cdk8s `K0sCluster<M>` construct.
 *
 * WHY: a k0rdent `ClusterTemplate` wraps a Helm chart that KCM renders (via its
 * bundled Flux) into a CAPI object set. Rather than hand-author that chart in Go
 * templating (losing type-safety and the debugged `_shared.ts` CAPA layer), we
 * synth `K0sCluster<M>` with SENTINEL values and post-process the rendered YAML,
 * substituting the sentinels for the Helm expressions k0rdent expects:
 *
 *   sentinel                    → Helm expression            (k0rdent value)
 *   ───────────────────────────────────────────────────────────────────────
 *   <name>                      → {{ include "cluster.name" . }}   (.Release.Name)
 *   <region>                    → {{ .Values.region }}
 *   identityRef.kind/name       → {{ .Values.clusterIdentity.kind/name }}
 *   control-plane AMI id        → {{ .Values.controlPlane.amiID }}
 *   worker AMI id               → {{ .Values.worker.amiID }}
 *   control-plane replicas      → {{ .Values.controlPlaneNumber }}
 *   worker replicas             → {{ .Values.workersNumber }}
 *
 * Everything structurally complex (per-pool labels/taints, Ethereum P2P SG,
 * custom CNI, spot, IMDSv2, volumes) is BAKED at generation time from the cdk8s
 * config, keeping the chart's values schema tiny (which is also what KCM
 * validates `ClusterDeployment.spec.config` against).
 *
 * The chart is written to a directory; commit it to a git repo and register it
 * with a nebula `ClusterTemplate` construct (git-sourced via a Flux
 * GitRepository — no OCI registry needed).
 *
 * NOTE: v1 targets the common single-worker-pool AWS standalone-CP shape and
 * templatizes name/region/identity/ami/replicas. TODO (validate against a live
 * KCM): the bundled aws-standalone-cp AWSCluster also carries a
 * `k0rdent.mirantis.com/cleanup` finalizer + `aws.cluster.x-k8s.io/
 * external-resource-gc: "true"` annotation for teardown GC — add these once the
 * live delete path confirms they're required (a YAML round-trip would mangle the
 * Helm `{{ }}` expressions, so inject them via targeted string edits, not a parse).
 *
 * Run: tsx scripts/build-cluster-template-chart.ts [outDir]
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App, Chart } from "cdk8s";
import { K0sCluster } from "../src/modules/infra/k0s";
import { AwsK0sProvider } from "../src/modules/infra/aws";
import type { NodeIngressRuleSpec } from "../src/modules/infra/aws/_shared";
import type { NodeTaint } from "../src/modules/infra/k0s/cluster";
import {
  AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme,
  AwsClusterV1Beta2SpecIdentityRefKind,
} from "../imports/infrastructure.cluster.x-k8s.io";

/** Sentinel values injected at synth then substituted for Helm expressions. */
const SENTINELS = {
  name: "nebulaxclusterxname",
  region: "nebulaxregionxvalue",
  identityKind: "NebulaXIdentityXKind",
  identityName: "nebulaxidentityxname",
  cpAmi: "ami-0nebulaxcontrolplane",
  workerAmi: "ami-0nebulaxworkerxpool",
  cpReplicas: 987001,
  workerReplicas: 987002,
} as const;

/** sentinel → Helm expression, applied as plain-string substitutions. */
const SUBSTITUTIONS: Array<[string | number, string]> = [
  [SENTINELS.name, '{{ include "cluster.name" . }}'],
  [SENTINELS.region, "{{ .Values.region }}"],
  [SENTINELS.identityKind, "{{ .Values.clusterIdentity.kind }}"],
  [SENTINELS.identityName, "{{ .Values.clusterIdentity.name }}"],
  [SENTINELS.cpAmi, "{{ .Values.controlPlane.amiID }}"],
  [SENTINELS.workerAmi, "{{ .Values.worker.amiID }}"],
  [String(SENTINELS.cpReplicas), "{{ .Values.controlPlaneNumber }}"],
  [String(SENTINELS.workerReplicas), "{{ .Values.workersNumber }}"],
];

const CHART_ANNOTATIONS = [
  "  cluster.x-k8s.io/provider: infrastructure-aws, control-plane-k0sproject-k0smotron, bootstrap-k0sproject-k0smotron",
  "  cluster.x-k8s.io/bootstrap-k0sproject-k0smotron: v1beta1",
  "  cluster.x-k8s.io/control-plane-k0sproject-k0smotron: v1beta1",
  "  cluster.x-k8s.io/infrastructure-aws: v1beta2",
].join("\n");

const HELPERS_TPL = `{{- define "cluster.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- end }}
`;

export interface ClusterTemplateChartOptions {
  /** Output directory for the chart (created if missing). */
  outDir: string;
  /** Chart name (Chart.yaml name). */
  chartName: string;
  /** Chart version (default "0.1.0"). */
  chartVersion?: string;
  /** Kubernetes version the cluster runs (default "v1.31.8"). */
  k8sVersion?: string;
  /** k0s CNI: "custom" (Calico via ServiceTemplate) or "kuberouter". Default "custom". */
  networkProvider?: "custom" | "kuberouter" | "calico";
  /** Default control-plane replicas baked into values.yaml (still templated). */
  defaultControlPlaneNumber?: number;
  /** Default worker replicas baked into values.yaml (still templated). */
  defaultWorkersNumber?: number;
  /** Control-plane machine shape (baked except AMI, which is a value). */
  controlPlane?: {
    instanceType?: string;
    rootVolumeSizeGiB?: number;
    imdsPodAccess?: boolean;
  };
  /** Single worker pool shape (baked except AMI/replicas, which are values). */
  worker?: {
    poolName?: string;
    instanceType?: string;
    rootVolumeSizeGiB?: number;
    spot?: boolean | { maxPrice?: string };
    nodeLabels?: Record<string, string>;
    taints?: NodeTaint[];
    k0sArgs?: string[];
  };
  /** Cluster-level AWS config (baked). */
  vpcCidr?: string;
  availabilityZoneUsageLimit?: number;
  sshKeyName?: string;
  iamInstanceProfile?: string;
  controlPlaneLoadBalancerScheme?: AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme;
  /** Extra node-SG ingress (e.g. Ethereum P2P). Baked. */
  additionalNodeIngressRules?: NodeIngressRuleSpec[];
}

/** Synth K0sCluster<M> with sentinels and wrap it as a k0rdent ClusterTemplate chart. */
export function buildClusterTemplateChart(opts: ClusterTemplateChartOptions): string {
  const workerPool = opts.worker?.poolName ?? "worker";

  const app = new App();
  const chart = new Chart(app, "cluster-template");
  new K0sCluster(chart, "cluster", {
    name: SENTINELS.name,
    namespace: "default",
    k8sVersion: opts.k8sVersion ?? "v1.31.8",
    networkProvider: opts.networkProvider ?? "custom",
    provider: new AwsK0sProvider({
      region: SENTINELS.region,
      vpcCidr: opts.vpcCidr,
      availabilityZoneUsageLimit: opts.availabilityZoneUsageLimit,
      sshKeyName: opts.sshKeyName,
      iamInstanceProfile: opts.iamInstanceProfile,
      controlPlaneLoadBalancerScheme: opts.controlPlaneLoadBalancerScheme,
      additionalNodeIngressRules: opts.additionalNodeIngressRules,
      imdsPodAccess: opts.controlPlane?.imdsPodAccess,
      identityRef: {
        kind: SENTINELS.identityKind as AwsClusterV1Beta2SpecIdentityRefKind,
        name: SENTINELS.identityName,
      },
    }),
    controlPlane: {
      replicas: SENTINELS.cpReplicas,
      machine: {
        instanceType: opts.controlPlane?.instanceType,
        rootVolumeSizeGiB: opts.controlPlane?.rootVolumeSizeGiB,
        ami: { id: SENTINELS.cpAmi },
      },
    },
    workerPools: {
      [workerPool]: {
        replicas: SENTINELS.workerReplicas,
        nodeLabels: opts.worker?.nodeLabels,
        taints: opts.worker?.taints,
        k0sArgs: opts.worker?.k0sArgs,
        machine: {
          instanceType: opts.worker?.instanceType,
          rootVolumeSizeGiB: opts.worker?.rootVolumeSizeGiB,
          ami: { id: SENTINELS.workerAmi },
          spot: opts.worker?.spot,
        },
      },
    },
  });

  // Synth to a temp dir, read the single rendered manifest.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-ct-"));
  app.synth();
  // cdk8s writes to ./dist by default; relocate deterministically instead.
  const distFile = path.join(process.cwd(), "dist", "cluster-template.k8s.yaml");
  let manifest = fs.readFileSync(distFile, "utf8");
  fs.rmSync(distFile, { force: true });
  fs.rmSync(tmp, { recursive: true, force: true });

  // Substitute sentinels → Helm expressions.
  for (const [from, to] of SUBSTITUTIONS) {
    manifest = manifest.split(String(from)).join(to);
  }

  // Write the chart.
  const outDir = opts.outDir;
  fs.mkdirSync(path.join(outDir, "templates"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "Chart.yaml"),
    [
      "apiVersion: v2",
      `name: ${opts.chartName}`,
      "description: nebula-generated k0rdent ClusterTemplate (AWS standalone k0s control plane)",
      "type: application",
      `version: ${opts.chartVersion ?? "0.1.0"}`,
      `appVersion: "${opts.k8sVersion ?? "v1.31.8"}+k0s.0"`,
      "annotations:",
      CHART_ANNOTATIONS,
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(outDir, "templates", "_helpers.tpl"), HELPERS_TPL);
  fs.writeFileSync(path.join(outDir, "templates", "cluster.yaml"), manifest);
  fs.writeFileSync(
    path.join(outDir, "values.yaml"),
    [
      "# k0rdent ClusterDeployment.spec.config maps to these values.",
      'region: ""',
      `controlPlaneNumber: ${opts.defaultControlPlaneNumber ?? 3}`,
      `workersNumber: ${opts.defaultWorkersNumber ?? 2}`,
      "# clusterIdentity is injected by KCM from the ClusterDeployment credential.",
      "clusterIdentity: {}",
      "controlPlane:",
      '  amiID: ""',
      "worker:",
      '  amiID: ""',
      "",
    ].join("\n"),
  );

  return outDir;
}

// CLI entry — build a representative Ethereum-node cluster template for a smoke test.
if (import.meta.url === `file://${process.argv[1]}`) {
  const outDir = process.argv[2] ?? path.join(process.cwd(), "dist-cluster-template");
  buildClusterTemplateChart({
    outDir,
    chartName: "nebula-eth-node-cluster",
    networkProvider: "custom",
    controlPlane: { instanceType: "m6g.xlarge", rootVolumeSizeGiB: 100 },
    worker: {
      poolName: "tool-node",
      instanceType: "m6i.2xlarge",
      rootVolumeSizeGiB: 500,
      spot: { maxPrice: "0.30" },
      nodeLabels: { "nucon.io/pool": "tool-node" },
      taints: [{ key: "nucon.io/tool-node", value: "true", effect: "NoSchedule" }],
    },
    availabilityZoneUsageLimit: 3,
    additionalNodeIngressRules: [
      { description: "Ethereum execution P2P (TCP)", protocol: "tcp", fromPort: 30303, toPort: 30303, cidrBlocks: ["0.0.0.0/0"] },
      { description: "Ethereum execution P2P (UDP)", protocol: "udp", fromPort: 30303, toPort: 30303, cidrBlocks: ["0.0.0.0/0"] },
      { description: "Ethereum consensus P2P (TCP)", protocol: "tcp", fromPort: 9000, toPort: 9000, cidrBlocks: ["0.0.0.0/0"] },
      { description: "Ethereum consensus P2P (UDP)", protocol: "udp", fromPort: 9000, toPort: 9000, cidrBlocks: ["0.0.0.0/0"] },
    ],
  });
  // eslint-disable-next-line no-console
  console.log(`ClusterTemplate chart written to ${outDir}`);
}
