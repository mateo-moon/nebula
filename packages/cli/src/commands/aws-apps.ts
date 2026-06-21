/**
 * In-process cdk8s apps for the self-sufficient `nebula bootstrap --provider aws`.
 *
 * The bootstrap command builds and synthesizes these directly (no user-authored
 * bootstrap.ts/mgmt.ts scaffold required). A power user can still place a
 * bootstrap.ts in the cwd to override.
 */
import { App, Chart } from "cdk8s";
import {
  AwsProvider,
  Aws,
  AwsK0sCluster,
  Crossplane,
  ClusterApiOperator,
} from "nebula-cdk8s";

export interface AwsBootstrapAppOptions {
  region: string;
  clusterName: string;
  k8sVersion?: string;
  amiId?: string;
  cpReplicas?: number;
  cpInstanceType?: string;
  vpcCidr?: string;
}

function addPlatform(chart: Chart, o: AwsBootstrapAppOptions): void {
  // Crossplane universal control plane.
  new Crossplane(chart, "crossplane", { namespace: "crossplane-system" });

  // Crossplane provider-aws — credentials from the CLI-created secret.
  new AwsProvider(chart, "aws-provider", {
    families: ["ec2", "iam"],
    credentials: {
      type: "secret",
      secretRef: {
        name: "aws-creds",
        namespace: "crossplane-system",
        key: "creds",
      },
    },
  });

  // Node IAM instance profile (CAPA requires it to pre-exist).
  new Aws(chart, "aws", { name: o.clusterName, region: o.region });

  // Cluster API operator: CAPA + k0s. References the CLI-created CAPA secret.
  new ClusterApiOperator(chart, "capi", {
    aws: {
      region: o.region,
      secretName: "aws-capa-credentials",
      secretNamespace: "capa-system",
    },
  });
}

/**
 * Bootstrap-stage app (applied to Kind): the platform + the vendor-free HA k0s
 * management cluster definition (standalone control plane + NLB API endpoint).
 */
export function synthAwsBootstrap(
  outdir: string,
  o: AwsBootstrapAppOptions,
): void {
  const app = new App({ outdir });
  const chart = new Chart(app, "aws-bootstrap");
  addPlatform(chart, o);
  new AwsK0sCluster(chart, "mgmt", {
    name: o.clusterName,
    region: o.region,
    ...(o.k8sVersion ? { k8sVersion: o.k8sVersion } : {}),
    ...(o.vpcCidr ? { vpcCidr: o.vpcCidr } : {}),
    controlPlane: {
      replicas: o.cpReplicas ?? 3,
      instanceType: o.cpInstanceType ?? "m6i.large",
      ...(o.amiId ? { ami: { id: o.amiId } } : {}),
    },
  });
  app.synth();
}

/**
 * Management-stage app (applied to the new k0s cluster): the platform only (no
 * cluster CR). Installs Crossplane + CAPA so the management cluster is
 * self-managing and can provision workload clusters. Crossplane re-adopts the
 * node IAM profile via crossplane.io/external-name — no clusterctl move needed.
 */
export function synthAwsMgmt(outdir: string, o: AwsBootstrapAppOptions): void {
  const app = new App({ outdir });
  const chart = new Chart(app, "aws-mgmt");
  addPlatform(chart, o);
  app.synth();
}
