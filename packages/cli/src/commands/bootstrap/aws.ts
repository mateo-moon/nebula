/**
 * AWS provider — vendor-free: a self-managed HA k0s management cluster on EC2 via
 * Cluster API (CAPA), with no EKS. The Kind cluster only bootstraps; the standalone
 * k0s control plane is self-contained, so the platform is redeployed onto the new
 * cluster and Kind is discarded (no clusterctl pivot). Built in-process from flags.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  exec,
  log,
  sleep,
  commandExists,
  createKindCluster,
  kubeconfigPrefix,
  waitForProviders,
  waitForCrds,
  synthAndApply,
} from "./shared";
import {
  synthAwsPlatform,
  synthAwsCluster,
  AwsBootstrapAppOptions,
} from "./aws-apps";
import type { BootstrapOptions, BootstrapProvider } from "./types";

const MGMT_CLUSTER = "mgmt";
const MGMT_NAMESPACE = "default";

/** CRDs the cluster-api-operator installs at runtime that the cluster CRs depend on. */
const CAPI_CLUSTER_CRDS = [
  "clusters.cluster.x-k8s.io",
  "awsclusters.infrastructure.cluster.x-k8s.io",
  "awsmachinetemplates.infrastructure.cluster.x-k8s.io",
  "k0scontrolplanes.controlplane.cluster.x-k8s.io",
];

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Resolve AWS credentials from a named profile (handles static keys and SSO). */
function awsExportCredentials(profile?: string): AwsCreds {
  const p = profile ? `--profile ${profile}` : "";
  let out = "";
  try {
    out = exec(`aws configure export-credentials ${p} --format env-no-export`, {
      silent: true,
    });
  } catch {
    throw new Error(
      `Failed to resolve AWS credentials${profile ? ` for profile '${profile}'` : ""}. ` +
        `Run: aws configure --profile <name>`,
    );
  }
  const get = (k: string): string => {
    const m = out.match(new RegExp(`^${k}=(.*)$`, "m"));
    return m ? m[1].trim() : "";
  };
  const accessKeyId = get("AWS_ACCESS_KEY_ID");
  const secretAccessKey = get("AWS_SECRET_ACCESS_KEY");
  const sessionToken = get("AWS_SESSION_TOKEN") || undefined;
  if (!accessKeyId || !secretAccessKey) {
    throw new Error("Could not resolve AWS credentials (empty access key).");
  }
  return { accessKeyId, secretAccessKey, sessionToken };
}

/** Create the Crossplane (`aws-creds`) and CAPA (`aws-capa-credentials`) secrets on the target cluster. */
async function setupAwsCredentials(
  region: string,
  profile?: string,
  kubeconfig?: string,
): Promise<void> {
  if (!kubeconfig) {
    log("");
    log("🔐 Step 2: Setting up AWS credentials");
    log("─".repeat(50));
  }

  const kc = kubeconfigPrefix(kubeconfig);
  const { accessKeyId, secretAccessKey, sessionToken } =
    awsExportCredentials(profile);
  if (sessionToken && !kubeconfig) {
    log(
      "   ⚠️  Using temporary credentials (session token); they expire — prefer a static IAM user key for long bootstraps.",
    );
  }

  const ini =
    `[default]\n` +
    `aws_access_key_id = ${accessKeyId}\n` +
    `aws_secret_access_key = ${secretAccessKey}\n` +
    (sessionToken ? `aws_session_token = ${sessionToken}\n` : "") +
    `region = ${region}\n`;
  const iniPath = `/tmp/nebula-aws-creds-${Date.now()}.ini`;
  fs.writeFileSync(iniPath, ini, { mode: 0o600 });

  try {
    // Crossplane provider-aws credentials (secretRef key 'creds')
    exec(
      `${kc}kubectl create namespace crossplane-system --dry-run=client -o yaml | ${kc}kubectl apply -f -`,
      { silent: true },
    );
    exec(
      `${kc}kubectl delete secret aws-creds -n crossplane-system --ignore-not-found`,
      { silent: true },
    );
    exec(
      `${kc}kubectl create secret generic aws-creds --from-file=creds=${iniPath} -n crossplane-system`,
    );

    // CAPA credentials (AWS_B64ENCODED_CREDENTIALS + AWS_REGION)
    const b64 = Buffer.from(ini, "utf-8").toString("base64");
    exec(
      `${kc}kubectl create namespace capa-system --dry-run=client -o yaml | ${kc}kubectl apply -f -`,
      { silent: true },
    );
    exec(
      `${kc}kubectl delete secret aws-capa-credentials -n capa-system --ignore-not-found`,
      { silent: true },
    );
    exec(
      `${kc}kubectl create secret generic aws-capa-credentials ` +
        `--from-literal=AWS_B64ENCODED_CREDENTIALS=${b64} ` +
        `--from-literal=AWS_REGION=${region} -n capa-system`,
    );
  } finally {
    fs.unlinkSync(iniPath);
  }

  log(
    `   ✅ Created secrets: aws-creds (crossplane-system), aws-capa-credentials (capa-system)${kubeconfig ? " on the management cluster" : ""}`,
  );
}

/**
 * Apply the platform stage: Crossplane + cert-manager + provider-aws + node IAM +
 * cluster-api-operator. cert-manager must be up before the operator's webhook cert
 * is issued, so we apply, wait for cert-manager, then re-apply (idempotent) so the
 * operator's Certificate/Issuer land. Used for both Kind and the mgmt cluster.
 */
async function deployPlatform(
  appOpts: AwsBootstrapAppOptions,
  kubeconfig?: string,
): Promise<void> {
  const kc = kubeconfigPrefix(kubeconfig);
  const outdir = path.join(process.cwd(), ".nebula-aws-platform");

  await synthAndApply(outdir, () => synthAwsPlatform(outdir, appOpts), kubeconfig);

  log("   Waiting for cert-manager webhook...");
  exec(
    `${kc}kubectl -n cert-manager rollout status deploy/cert-manager-webhook --timeout=240s`,
    { ignoreErrors: true },
  );
  // Re-apply so the operator's cert-manager Certificate/Issuer (which need the
  // webhook up) and any first-pass-skipped resources are created.
  await synthAndApply(outdir, () => synthAwsPlatform(outdir, appOpts), kubeconfig);

  log("   Waiting for Crossplane providers...");
  await waitForProviders(300, kubeconfig);
}

/** Apply the management cluster CRs (after the operator installs the CAPA/k0s CRDs). */
async function deployCluster(appOpts: AwsBootstrapAppOptions): Promise<void> {
  const outdir = path.join(process.cwd(), ".nebula-aws-cluster");
  await synthAndApply(outdir, () => synthAwsCluster(outdir, appOpts));
}

/** Wait until the CAPI cluster's control plane is ready and its kubeconfig secret exists. */
async function waitForClusterReady(timeoutSeconds: number): Promise<void> {
  log("");
  log("⏳ Step 4: Waiting for the management cluster (CAPI)");
  log("─".repeat(50));
  log(`   Cluster: ${MGMT_CLUSTER} (ns ${MGMT_NAMESPACE})`);

  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    const get = (jsonpath: string): string =>
      exec(
        `kubectl get cluster ${MGMT_CLUSTER} -n ${MGMT_NAMESPACE} -o jsonpath="${jsonpath}" 2>/dev/null || echo ""`,
        { silent: true },
      ).trim();
    const phase = get("{.status.phase}");
    const cpReady = get("{.status.controlPlaneReady}");
    const kubeconfigExists = exec(
      `kubectl get secret ${MGMT_CLUSTER}-kubeconfig -n ${MGMT_NAMESPACE} -o name 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();

    if (cpReady === "true" && kubeconfigExists) {
      log("   ✅ Management cluster control plane is ready");
      return;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    log(
      `   Waiting... (${elapsed}s, phase: ${phase || "Pending"}, controlPlaneReady: ${cpReady || "false"})`,
    );
    await sleep(30000);
  }
  throw new Error(
    `Management cluster ${MGMT_CLUSTER} did not become ready within ${timeoutSeconds}s`,
  );
}

/** Write the CAPI-generated kubeconfig for the management cluster to a local file. */
function fetchKubeconfig(): string {
  const b64 = exec(
    `kubectl get secret ${MGMT_CLUSTER}-kubeconfig -n ${MGMT_NAMESPACE} -o jsonpath="{.data.value}" 2>/dev/null`,
    { silent: true },
  ).trim();
  if (!b64) {
    throw new Error(
      `kubeconfig secret ${MGMT_CLUSTER}-kubeconfig not found in ${MGMT_NAMESPACE}`,
    );
  }
  const kubeconfig = Buffer.from(b64, "base64").toString("utf-8");
  const kPath = path.join(process.cwd(), `.kube-${MGMT_CLUSTER}.config`);
  fs.writeFileSync(kPath, kubeconfig, { mode: 0o600 });
  return kPath;
}

async function bootstrapAws(options: BootstrapOptions): Promise<void> {
  const kindName = options.name || "nebula";
  const region = options.region;
  if (!region) {
    throw new Error("AWS provider requires --region (e.g. --region eu-central-1)");
  }
  const appOpts: AwsBootstrapAppOptions = {
    region,
    clusterName: MGMT_CLUSTER,
    amiId: options.amiId,
  };

  log("");
  log("🚀 Nebula AWS Bootstrap (vendor-free, self-managed k0s management cluster)");
  log("═".repeat(50));
  log(`   Kind cluster: ${kindName}`);
  log(`   Region:       ${region}`);
  log(`   Mgmt cluster: ${MGMT_CLUSTER}`);
  log(`   AMI:          ${appOpts.amiId ?? "(CAPA image lookup — pass --ami-id)"}`);

  for (const tool of ["kubectl", "aws", "kind"]) {
    if (!commandExists(tool)) throw new Error(`${tool} is not installed`);
  }

  // Step 1: Kind bootstrap cluster (ephemeral).
  if (!options.skipKind) await createKindCluster(kindName);

  // Step 2: AWS credentials (Crossplane + CAPA secrets).
  if (!options.skipCredentials) await setupAwsCredentials(region, options.awsProfile);

  // Step 3: Platform on Kind, then wait for the operator to install CAPA/k0s CRDs.
  log("");
  log("📦 Step 3: Deploying the platform to Kind (Crossplane + cert-manager + CAPA)");
  log("─".repeat(50));
  await deployPlatform(appOpts);
  log("   Waiting for the cluster-api-operator to install CAPA/k0s CRDs...");
  await waitForCrds(CAPI_CLUSTER_CRDS, 600);

  // Step 4: Create the management cluster, then wait for its control plane.
  log("");
  log("📦 Step 4: Creating the management cluster (CAPA + k0s)");
  log("─".repeat(50));
  await deployCluster(appOpts);
  await waitForClusterReady(1800);

  // Step 5: Fetch the management cluster kubeconfig.
  log("");
  log("🔄 Step 5: Fetching the management cluster kubeconfig");
  log("─".repeat(50));
  const mgmtKubeconfig = fetchKubeconfig();
  log(`   ✅ Wrote ${mgmtKubeconfig}`);

  // Step 6: Install the platform on the management cluster (no clusterctl pivot —
  // the standalone k0s control plane is self-contained; Kind can be discarded).
  log("");
  log("📦 Step 6: Installing the platform on the management cluster");
  log("─".repeat(50));
  await setupAwsCredentials(region, options.awsProfile, mgmtKubeconfig);
  await deployPlatform(appOpts, mgmtKubeconfig);

  log("");
  log("═".repeat(50));
  log("✨ AWS bootstrap complete!");
  log("");
  log(`   Kind (bootstrap):  kind-${kindName}  (ephemeral — safe to delete)`);
  log(`   k0s (management):  ${MGMT_CLUSTER}  →  KUBECONFIG="${mgmtKubeconfig}"`);
  log("");
  log(`   export KUBECONFIG="${mgmtKubeconfig}"`);
  log("   kubectl get nodes");
  log(`   kind delete cluster --name ${kindName}`);
  log("");
}

export const awsProvider: BootstrapProvider = {
  name: "aws",
  bootstrap: bootstrapAws,
};
