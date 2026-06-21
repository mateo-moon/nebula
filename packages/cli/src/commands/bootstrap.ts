/**
 * Bootstrap command - Full deployment workflow
 *
 * 1. Create Kind cluster
 * 2. Setup GCP credentials
 * 3. Deploy bootstrap.ts to Kind (Crossplane, providers, infra)
 * 4. Wait for GKE cluster to be ready (discovered from Crossplane resource)
 * 5. Deploy workloads to GKE
 */
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { apply } from "./apply";
import { synthAwsBootstrap, synthAwsMgmt } from "./aws-apps";

export interface BootstrapOptions {
  name?: string;
  project?: string;
  credentials?: string;
  skipKind?: boolean;
  skipCredentials?: boolean;
  skipGke?: boolean;
  /** Cloud provider for the management cluster ('gcp' | 'aws', default 'gcp') */
  provider?: string;
  /** AWS region (aws provider) */
  region?: string;
  /** AWS named profile to resolve credentials from (aws provider) */
  awsProfile?: string;
  /** Name of the CAPI management cluster CR (aws provider, default 'mgmt') */
  clusterName?: string;
  /** Namespace of the CAPI management cluster CR (aws provider, default 'default') */
  clusterNamespace?: string;
  /** AMI id for the management cluster nodes (aws; recommend Ubuntu 22.04) */
  amiId?: string;
  /** Number of control-plane nodes for the HA k0s management cluster (aws, default 3) */
  cpReplicas?: number;
  /** EC2 instance type for the management cluster nodes (aws, default m6i.large) */
  cpInstanceType?: string;
  /** VPC CIDR CAPA creates for the management cluster (aws, default 10.0.0.0/16) */
  vpcCidr?: string;
  /** Kubernetes version (aws, default v1.31.8) */
  k8sVersion?: string;
  /** Skip installing the control-plane stack on the management cluster (aws) */
  skipMgmtPlatform?: boolean;
}

interface GkeClusterInfo {
  name: string;
  location: string;
  project: string;
}

function log(msg: string): void {
  console.log(msg);
}

function exec(
  cmd: string,
  options?: { silent?: boolean; ignoreErrors?: boolean },
): string {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: options?.silent ? ["pipe", "pipe", "pipe"] : "inherit",
    });
  } catch (error: any) {
    if (options?.silent || options?.ignoreErrors) {
      return error.stdout || "";
    }
    throw error;
  }
}

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function kindClusterExists(name: string): boolean {
  try {
    const result = execSync(`kind get clusters`, {
      encoding: "utf-8",
      stdio: "pipe",
    });
    return result.split("\n").includes(name);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createKindCluster(name: string): Promise<void> {
  log("");
  log("🐳 Step 1: Creating Kind cluster");
  log("─".repeat(50));

  if (!commandExists("kind")) {
    throw new Error(
      "kind is not installed. Install it with: brew install kind",
    );
  }

  if (kindClusterExists(name)) {
    log(`   ✅ Cluster '${name}' already exists`);
    exec(`kubectl config use-context kind-${name}`, { silent: true });
    return;
  }

  log(`   Creating cluster '${name}'...`);

  const kindConfig = `
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
`;

  const configPath = `/tmp/kind-config-${name}.yaml`;
  fs.writeFileSync(configPath, kindConfig);

  exec(`kind create cluster --name ${name} --config ${configPath}`);
  fs.unlinkSync(configPath);

  log(`   ✅ Cluster '${name}' created`);
}

async function setupGcpCredentials(
  project: string,
  credentialsPath?: string,
): Promise<void> {
  log("");
  log("🔐 Step 2: Setting up GCP credentials");
  log("─".repeat(50));

  let credsPath = credentialsPath;

  if (!credsPath) {
    const adcPath = path.join(
      process.env.HOME || "",
      ".config/gcloud/application_default_credentials.json",
    );
    if (fs.existsSync(adcPath)) {
      log(`   Found ADC at: ${adcPath}`);
      credsPath = adcPath;
    } else {
      throw new Error(
        "No credentials file provided and ADC not found. Run: gcloud auth application-default login",
      );
    }
  }

  if (!fs.existsSync(credsPath)) {
    throw new Error(`Credentials file not found: ${credsPath}`);
  }

  log("   Creating GCP credentials secret...");
  exec(
    "kubectl create namespace crossplane-system --dry-run=client -o yaml | kubectl apply -f -",
    { silent: true },
  );
  exec(
    "kubectl delete secret gcp-creds -n crossplane-system --ignore-not-found",
    { silent: true },
  );
  exec(
    `kubectl create secret generic gcp-creds --from-file=creds=${credsPath} -n crossplane-system`,
  );

  log(`   ✅ GCP credentials secret created`);
}

async function deployToKind(): Promise<void> {
  log("");
  log("📦 Step 3: Deploying bootstrap to Kind");
  log("─".repeat(50));

  // Synth bootstrap.ts
  log("   Synthesizing bootstrap.ts...");
  exec('npx cdk8s synth --app "npx tsx bootstrap.ts"');

  // Apply with phased approach
  log("   Applying manifests...");
  exec("npx nebula apply");

  // Wait for providers to be healthy
  log("   Waiting for Crossplane providers...");
  await waitForProviders(300);

  log(`   ✅ Bootstrap deployed to Kind`);
}

async function waitForProviders(timeoutSeconds: number): Promise<void> {
  const start = Date.now();

  while (Date.now() - start < timeoutSeconds * 1000) {
    const result = exec(
      'kubectl get providers -o jsonpath="{.items[*].status.conditions[?(@.type==\'Healthy\')].status}" 2>/dev/null || echo ""',
      { silent: true },
    );

    const statuses = result
      .trim()
      .split(" ")
      .filter((s) => s);
    if (statuses.length > 0 && statuses.every((s) => s === "True")) {
      return;
    }

    await sleep(5000);
  }

  log("   ⚠️  Some providers may not be fully healthy yet");
}

/**
 * Discover GKE cluster info from Crossplane managed resources in Kind cluster
 */
function discoverGkeCluster(): GkeClusterInfo | null {
  try {
    // Get cluster name
    const name = exec(
      'kubectl get cluster.container.gcp.upbound.io -o jsonpath="{.items[0].metadata.name}" 2>/dev/null',
      { silent: true },
    ).trim();

    if (!name) {
      return null;
    }

    // Get cluster location (zone)
    const location = exec(
      'kubectl get cluster.container.gcp.upbound.io -o jsonpath="{.items[0].spec.forProvider.location}" 2>/dev/null',
      { silent: true },
    ).trim();

    // Get project from spec
    const project = exec(
      'kubectl get cluster.container.gcp.upbound.io -o jsonpath="{.items[0].spec.forProvider.project}" 2>/dev/null',
      { silent: true },
    ).trim();

    if (name && location) {
      return { name, location, project };
    }
    return null;
  } catch {
    return null;
  }
}

async function waitForGkeClusterResource(
  timeoutSeconds: number,
): Promise<GkeClusterInfo> {
  log("");
  log("🔍 Discovering GKE cluster from Crossplane...");
  log("─".repeat(50));

  const start = Date.now();

  while (Date.now() - start < timeoutSeconds * 1000) {
    const cluster = discoverGkeCluster();
    if (cluster) {
      log(`   Found cluster: ${cluster.name} in ${cluster.location}`);
      return cluster;
    }

    await sleep(5000);
  }

  throw new Error("No GKE cluster resource found in Kind cluster");
}

async function waitForGke(
  project: string,
  clusterName: string,
  zone: string,
  timeoutSeconds: number,
): Promise<void> {
  log("");
  log("⏳ Step 4: Waiting for GKE cluster");
  log("─".repeat(50));
  log(`   Cluster: ${clusterName} in ${zone}`);

  const start = Date.now();

  while (Date.now() - start < timeoutSeconds * 1000) {
    // Check Crossplane cluster status
    const status = exec(
      `kubectl get cluster.container.gcp.upbound.io ${clusterName} -o jsonpath="{.status.conditions[?(@.type=='Ready')].status}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();

    if (status === "True") {
      log(`   ✅ GKE cluster is ready`);
      return;
    }

    // Also check directly with gcloud
    const gcloudStatus = exec(
      `gcloud container clusters describe ${clusterName} --zone ${zone} --project ${project} --format="value(status)" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();

    if (gcloudStatus === "RUNNING") {
      log(`   ✅ GKE cluster is running`);
      return;
    }

    const elapsed = Math.round((Date.now() - start) / 1000);
    log(
      `   Waiting... (${elapsed}s elapsed, status: ${gcloudStatus || "PROVISIONING"})`,
    );

    await sleep(30000);
  }

  throw new Error(
    `GKE cluster did not become ready within ${timeoutSeconds} seconds`,
  );
}

async function switchToGke(
  project: string,
  clusterName: string,
  zone: string,
): Promise<void> {
  log("");
  log("🔄 Step 5: Switching to GKE cluster");
  log("─".repeat(50));

  exec(
    `gcloud container clusters get-credentials ${clusterName} --zone ${zone} --project ${project}`,
  );

  log(`   ✅ Now using GKE cluster: ${clusterName}`);
}

async function deployToGke(): Promise<void> {
  log("");
  log("📦 Step 6: Deploying workloads to GKE");
  log("─".repeat(50));

  // Minimum modules needed to bootstrap ArgoCD on GKE.
  // Once ArgoCD + argocd-apps are running, ArgoCD auto-syncs everything else
  // from git (clusters/managed/*, clusters/dev/*, applications/*).
  const gkeModuleNames = [
    "infra/providers",   // Phase 1: Crossplane provider CRDs
    "infra/crossplane",  // Phase 1: Crossplane functions/compositions
    "meta/argocd",       // Phase 2: ArgoCD itself
    "meta/argocd-apps",  // Phase 2: App-of-apps (drives all other apps)
  ];

  // Clear previous dist to avoid mixing bootstrap and GKE manifests
  if (fs.existsSync("dist")) {
    fs.rmSync("dist", { recursive: true, force: true });
  }
  fs.mkdirSync("dist", { recursive: true });

  // Synth each module
  log("   Synthesizing GKE modules...");
  for (const moduleName of gkeModuleNames) {
    const indexPath = `${moduleName}/index.ts`;
    const dirPath = `${moduleName}/dev.ts`;
    const outputDir = `dist/${moduleName}`;

    if (fs.existsSync(indexPath)) {
      log(`   - ${indexPath}`);
      exec(`npx cdk8s synth -o "${outputDir}" --app "npx tsx ${indexPath}"`, {
        silent: true,
      });
    } else if (fs.existsSync(dirPath)) {
      log(`   - ${dirPath}`);
      exec(`npx cdk8s synth -o "${outputDir}" --app "npx tsx ${dirPath}"`, {
        silent: true,
      });
    }
  }

  // Validate no unresolved secret references in synthesized output.
  // If resolveSecrets() missed something (e.g. vals not installed, missing SOPS keys),
  // fail fast here instead of applying broken manifests to the cluster.
  log("   Validating secrets resolution...");
  for (const moduleName of gkeModuleNames) {
    const outputDir = `dist/${moduleName}`;
    if (!fs.existsSync(outputDir)) continue;

    const yamlFiles = fs
      .readdirSync(outputDir)
      .filter((f) => f.endsWith(".yaml"));
    for (const file of yamlFiles) {
      const content = fs.readFileSync(path.join(outputDir, file), "utf-8");
      const match = content.match(/ref\+\S+/);
      if (match) {
        throw new Error(
          `Unresolved secret reference in ${moduleName}/${file}: ${match[0]}\n` +
            `Ensure 'vals' CLI is installed and SOPS decryption keys are accessible.\n` +
            `Test manually: vals get "${match[0]}"`,
        );
      }
    }
  }
  log("   ✅ All secrets resolved");

  // Phase 1: Crossplane providers + functions (CRDs needed by argocd-apps)
  log("   Phase 1: Applying Crossplane infrastructure...");
  for (const mod of ["infra/providers", "infra/crossplane"]) {
    const modDir = `dist/${mod}`;
    if (fs.existsSync(modDir)) {
      exec(`npx nebula apply --file "${modDir}/*.k8s.yaml"`, { silent: true });
    }
  }

  log("   Waiting for Crossplane providers to be healthy...");
  await waitForProviders(300);
  log("   Waiting for Crossplane functions to be healthy...");
  await waitForCrossplaneFunctions(120);

  // Phase 2: ArgoCD + argocd-apps
  log("   Phase 2: Applying ArgoCD...");
  for (const mod of ["meta/argocd", "meta/argocd-apps"]) {
    const modDir = `dist/${mod}`;
    if (fs.existsSync(modDir)) {
      exec(`npx nebula apply --file "${modDir}/*.k8s.yaml"`, { silent: true });
    }
  }

  log(`   ✅ Bootstrap modules deployed to GKE`);

  // Step 7: Sync ArgoCD apps — triggers ArgoCD to pick up everything from git
  log("");
  log("🔄 Step 7: Syncing ArgoCD apps");
  log("─".repeat(50));
  await syncCriticalApps();

  // Step 8: Post-deployment health checks and cleanup
  log("");
  log("🔧 Step 8: Post-deployment validation");
  log("─".repeat(50));
  await postDeploymentValidation();
}

/**
 * Wait for all Crossplane Functions to become healthy.
 * Functions must be healthy before XRs using Compositions can be created.
 */
async function waitForCrossplaneFunctions(
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  while (Date.now() < deadline) {
    try {
      // Check if any functions exist
      const functionsJson = exec(
        "kubectl get functions.pkg.crossplane.io -o json 2>/dev/null || echo '{\"items\":[]}'",
        { silent: true },
      );
      const functions = JSON.parse(functionsJson);

      if (functions.items.length === 0) {
        // No functions installed, skip wait
        log("   No Crossplane functions found, skipping wait");
        return;
      }

      // Check if all functions are healthy
      let allHealthy = true;
      for (const fn of functions.items) {
        const installed =
          fn.status?.conditions?.find(
            (c: { type: string }) => c.type === "Installed",
          )?.status === "True";
        const healthy =
          fn.status?.conditions?.find(
            (c: { type: string }) => c.type === "Healthy",
          )?.status === "True";

        if (!installed || !healthy) {
          allHealthy = false;
          break;
        }
      }

      if (allHealthy) {
        log(`   ✅ All ${functions.items.length} Crossplane functions healthy`);
        return;
      }
    } catch {
      // Ignore errors, keep waiting
    }

    await sleep(5000);
  }

  log("   ⚠️  Timeout waiting for functions, continuing anyway...");
}

/**
 * Sync critical ArgoCD apps after bootstrap deployment.
 * Triggers sync and retries until each app reaches Synced status.
 */
async function syncCriticalApps(): Promise<void> {
  // Wait for ArgoCD application controller to be ready
  log("   Waiting for ArgoCD to be ready...");
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const ready = exec(
      'kubectl get statefulset argocd-application-controller -n argocd -o jsonpath="{.status.readyReplicas}" 2>/dev/null || echo "0"',
      { silent: true },
    ).trim();
    if (ready && parseInt(ready) > 0) break;
    await sleep(5000);
  }

  // Sync argocd-apps — this creates all ApplicationSets and Applications.
  // ArgoCD auto-syncs everything else from git (platform + workload tiers).
  await syncAppWithRetry("argocd-apps", 180);

  log("   ✅ ArgoCD apps synced — auto-sync will handle the rest");
}

/**
 * Trigger ArgoCD sync on an app and retry until it reaches Synced or timeout.
 */
async function syncAppWithRetry(
  appName: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;

  // Check if app exists
  const exists = exec(
    `kubectl get app ${appName} -n argocd -o name 2>/dev/null || echo ""`,
    { silent: true },
  ).trim();
  if (!exists) {
    log(`   ⚠️  App ${appName} not found, skipping`);
    return;
  }

  log(`   Syncing ${appName}...`);

  while (Date.now() < deadline) {
    // Check current sync status
    const syncStatus = exec(
      `kubectl get app ${appName} -n argocd -o jsonpath="{.status.sync.status}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();

    if (syncStatus === "Synced") {
      log(`   ✅ ${appName} synced`);
      return;
    }

    // Check if there's no operation running — trigger sync
    const opPhase = exec(
      `kubectl get app ${appName} -n argocd -o jsonpath="{.status.operationState.phase}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();

    if (opPhase !== "Running") {
      // Clear any failed operation first
      exec(
        `kubectl patch app ${appName} -n argocd --type=json -p='[{"op":"remove","path":"/status/operationState"}]' 2>/dev/null`,
        { silent: true, ignoreErrors: true },
      );
      // Force ArgoCD to rediscover API resources (picks up newly installed CRDs)
      exec(
        `kubectl patch app ${appName} -n argocd --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'`,
        { silent: true, ignoreErrors: true },
      );
      await sleep(3000);
      // Trigger sync with syncOptions from the app spec
      exec(
        `kubectl patch app ${appName} -n argocd --type=merge -p '{"operation":{"initiatedBy":{"username":"nebula-bootstrap"},"sync":{"syncOptions":["CreateNamespace=true","ServerSideApply=true","SkipDryRunOnMissingResource=true","RespectIgnoreDifferences=true"]}}}'`,
        { silent: true, ignoreErrors: true },
      );
    }

    await sleep(10000);
  }

  log(`   ⚠️  ${appName} did not reach Synced within ${timeoutSeconds}s`);
}

/**
 * Post-deployment health checks and automatic cleanup.
 *
 * Handles known failure modes observed during bootstrap:
 * 1. Failed Jobs in argocd namespace (e.g. token bootstrap hitting backoff limit
 *    because ArgoCD wasn't ready). Deleting them lets ArgoCD auto-sync recreate them.
 * 2. Crossplane CRDs stuck in Terminating state because managed resources have
 *    finalizers that can't be processed (provider deployment missing). Removing
 *    the finalizers unblocks CRD deletion and provider re-creation.
 * 3. Crossplane provider revisions that can't take ownership of CRDs left by a
 *    previous revision (stale ownerReferences with old UIDs). Clearing the stale
 *    refs lets the new revision reconcile successfully.
 */
async function postDeploymentValidation(): Promise<void> {
  // --- 1. Delete failed Jobs in argocd namespace ---
  try {
    const jobsJson = exec(
      'kubectl get jobs -n argocd -o json 2>/dev/null || echo \'{"items":[]}\'',
      { silent: true },
    );
    const jobs = JSON.parse(jobsJson);
    for (const job of jobs.items) {
      const failed = job.status?.conditions?.find(
        (c: { type: string; status: string }) =>
          c.type === "Failed" && c.status === "True",
      );
      if (failed) {
        const name = job.metadata.name;
        log(`   Deleting failed job ${name} (ArgoCD will recreate it)...`);
        exec(`kubectl delete job ${name} -n argocd`, {
          silent: true,
          ignoreErrors: true,
        });
      }
    }
  } catch {
    // Non-critical, continue
  }

  // --- 2. Clean up stuck Crossplane managed resources blocking CRD deletion ---
  try {
    const crdsJson = exec(
      'kubectl get crds -o json 2>/dev/null || echo \'{"items":[]}\'',
      { silent: true },
    );
    const crds = JSON.parse(crdsJson);
    for (const crd of crds.items) {
      if (!crd.metadata.deletionTimestamp) continue;
      const crdName = crd.metadata.name as string;
      if (!crdName.includes("crossplane.io")) continue;

      log(`   Found terminating Crossplane CRD: ${crdName}`);
      // List all instances and remove their finalizers so the CRD can be deleted
      const instancesJson = exec(
        `kubectl get ${crdName} -A -o json 2>/dev/null || echo '{"items":[]}'`,
        { silent: true },
      );
      const instances = JSON.parse(instancesJson);
      for (const inst of instances.items) {
        const ns = inst.metadata.namespace;
        const name = inst.metadata.name;
        const finalizers = inst.metadata.finalizers || [];
        if (finalizers.length > 0) {
          log(`   Removing finalizers from ${crdName}/${name}...`);
          const nsFlag = ns ? `-n ${ns}` : "";
          exec(
            `kubectl patch ${crdName} ${name} ${nsFlag} --type merge -p '{"metadata":{"finalizers":[]}}'`,
            { silent: true, ignoreErrors: true },
          );
        }
      }
    }
  } catch {
    // Non-critical, continue
  }

  // --- 3. Fix unhealthy provider revisions with stale CRD owner references ---
  try {
    const revsJson = exec(
      'kubectl get providerrevisions.pkg.crossplane.io -o json 2>/dev/null || echo \'{"items":[]}\'',
      { silent: true },
    );
    const revs = JSON.parse(revsJson);
    for (const rev of revs.items) {
      const healthy = rev.status?.conditions?.find(
        (c: { type: string }) => c.type === "RevisionHealthy",
      );
      if (healthy?.status === "True") continue;

      const msg = healthy?.message || "";
      // "cannot establish control of object: <crd> is already controlled by ProviderRevision <name> (UID <old-uid>)"
      const match = msg.match(
        /cannot establish control of object: (\S+) is already controlled by/,
      );
      if (!match) continue;

      const staleCrd = match[1];
      log(
        `   Clearing stale owner reference on CRD ${staleCrd} for provider revision ${rev.metadata.name}...`,
      );
      exec(
        `kubectl patch crd ${staleCrd} --type merge -p '{"metadata":{"ownerReferences":[]}}'`,
        { silent: true, ignoreErrors: true },
      );
    }
  } catch {
    // Non-critical, continue
  }

  // Wait a moment for reconciliation to pick up the changes
  await sleep(10000);

  // Verify providers are healthy after cleanup
  log("   Verifying Crossplane providers...");
  await waitForProviders(60);

  log("   ✅ Post-deployment validation complete");
}

/**
 * Try to read GCP project ID from config.ts in cwd.
 */
function readProjectFromConfig(): string | null {
  const configPath = path.join(process.cwd(), "config.ts");
  if (!fs.existsSync(configPath)) return null;
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const match = content.match(/project:\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const provider = (options.provider || "gcp").toLowerCase();
  if (provider === "aws") {
    return bootstrapAws(options);
  }
  if (provider !== "gcp") {
    throw new Error(`Unsupported --provider '${provider}' (expected 'gcp' or 'aws')`);
  }

  const clusterName = options.name || "nebula";
  const project = options.project || readProjectFromConfig();

  if (!project) {
    throw new Error(
      "GCP project ID is required. Use --project <id> or run 'nebula init' first.",
    );
  }

  log("");
  log("🚀 Nebula Full Bootstrap");
  log("═".repeat(50));
  log(`   Kind cluster: ${clusterName}`);
  log(`   GCP project: ${project}`);

  // Check prerequisites
  if (!commandExists("kubectl")) {
    throw new Error("kubectl is not installed");
  }
  if (!commandExists("gcloud")) {
    throw new Error("gcloud is not installed");
  }

  // Step 1: Create Kind cluster
  if (!options.skipKind) {
    await createKindCluster(clusterName);
  }

  // Step 2: Setup GCP credentials
  if (!options.skipCredentials) {
    await setupGcpCredentials(project, options.credentials);
  }

  // Step 3: Deploy bootstrap to Kind
  await deployToKind();

  // Step 4-6: GKE deployment
  let gkeCluster: GkeClusterInfo | null = null;

  if (!options.skipGke) {
    // Discover GKE cluster from Crossplane resource
    gkeCluster = await waitForGkeClusterResource(60);

    // Wait for GKE cluster to be ready
    await waitForGke(
      gkeCluster.project || project,
      gkeCluster.name,
      gkeCluster.location,
      900, // 15 min timeout
    );

    // Step 5: Switch to GKE
    await switchToGke(
      gkeCluster.project || project,
      gkeCluster.name,
      gkeCluster.location,
    );

    // Step 6: Deploy workloads to GKE
    await deployToGke();
  }

  log("");
  log("═".repeat(50));
  log("✨ Bootstrap complete!");
  log("");
  log("📋 Clusters:");
  log(`   Kind (management): kind-${clusterName}`);
  if (gkeCluster) {
    log(`   GKE (workloads): ${gkeCluster.name}`);
  }
  log("");
  log("📋 Switch contexts:");
  log(`   Kind: kubectl config use-context kind-${clusterName}`);
  if (gkeCluster) {
    log(
      `   GKE:  gcloud container clusters get-credentials ${gkeCluster.name} --zone ${gkeCluster.location} --project ${gkeCluster.project || project}`,
    );
  }
  log("");
}

// ===========================================================================
// AWS bootstrap — vendor-free: a self-managed HA k0s management cluster on EC2
// via Cluster API (CAPA). Mirrors the GCP Kind→cloud→pivot flow, but the
// management cluster is self-managed k0s (no EKS), reachable via a CAPA NLB.
// ===========================================================================

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

  const kc = kubeconfig ? `KUBECONFIG="${kubeconfig}" ` : "";
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

async function waitForCapiClusterReady(
  name: string,
  namespace: string,
  timeoutSeconds: number,
): Promise<void> {
  log("");
  log("⏳ Step 4: Waiting for the management cluster (CAPI)");
  log("─".repeat(50));
  log(`   Cluster: ${name} (ns ${namespace})`);

  const start = Date.now();
  while (Date.now() - start < timeoutSeconds * 1000) {
    const phase = exec(
      `kubectl get cluster ${name} -n ${namespace} -o jsonpath="{.status.phase}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();
    const cpReady = exec(
      `kubectl get cluster ${name} -n ${namespace} -o jsonpath="{.status.controlPlaneReady}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();
    const kubeconfigExists = exec(
      `kubectl get secret ${name}-kubeconfig -n ${namespace} -o name 2>/dev/null || echo ""`,
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
    `Management cluster ${name} did not become ready within ${timeoutSeconds}s`,
  );
}

/** Write the CAPI-generated kubeconfig for a cluster to a local file. */
function fetchCapiKubeconfig(name: string, namespace: string): string {
  const b64 = exec(
    `kubectl get secret ${name}-kubeconfig -n ${namespace} -o jsonpath="{.data.value}" 2>/dev/null`,
    { silent: true },
  ).trim();
  if (!b64) {
    throw new Error(`kubeconfig secret ${name}-kubeconfig not found in ${namespace}`);
  }
  const kubeconfig = Buffer.from(b64, "base64").toString("utf-8");
  const kPath = path.join(process.cwd(), `.kube-${name}.config`);
  fs.writeFileSync(kPath, kubeconfig, { mode: 0o600 });
  return kPath;
}

/** Synth (in-process) + apply a set of cdk8s manifests, optionally to another cluster. */
async function synthAndApply(
  outdir: string,
  synthFn: () => void,
  kubeconfig?: string,
): Promise<void> {
  fs.rmSync(outdir, { recursive: true, force: true });
  synthFn();
  const prev = process.env.KUBECONFIG;
  if (kubeconfig) process.env.KUBECONFIG = kubeconfig;
  try {
    await apply({ file: `${outdir}/*.k8s.yaml` });
  } finally {
    if (kubeconfig) {
      if (prev === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = prev;
    }
  }
}

/**
 * Step 3 (Kind): synth + apply the bootstrap topology (Crossplane + provider-aws
 * + CAPA/k0s + node IAM + the AwsK0sCluster management cluster). Built in-process
 * from CLI flags — no scaffold files required.
 */
async function deployAwsBootstrapToKind(appOpts: AppOpts): Promise<void> {
  log("");
  log("📦 Step 3: Deploying the bootstrap topology to Kind");
  log("─".repeat(50));
  const outdir = path.join(process.cwd(), ".nebula-aws-bootstrap");
  await synthAndApply(outdir, () => synthAwsBootstrap(outdir, appOpts));
  log("   Waiting for Crossplane providers...");
  await waitForProviders(300);
  log("   ✅ Bootstrap topology applied to Kind");
}

/**
 * Step 6 (management cluster): install the platform (Crossplane + CAPA, no
 * cluster CR) so the management cluster is self-managing and can provision
 * workload clusters. No clusterctl pivot — the standalone k0s control plane is
 * self-contained, and Crossplane re-adopts the IAM profile via external-name.
 */
async function deployMgmtPlatform(
  mgmtKubeconfig: string,
  appOpts: AppOpts,
  profile?: string,
): Promise<void> {
  log("");
  log("📦 Step 6: Installing the platform on the management cluster");
  log("─".repeat(50));

  // The management cluster needs the AWS credential secrets too.
  await setupAwsCredentials(appOpts.region, profile, mgmtKubeconfig);

  const outdir = path.join(process.cwd(), ".nebula-aws-mgmt");
  await synthAndApply(outdir, () => synthAwsMgmt(outdir, appOpts), mgmtKubeconfig);
  log("   ✅ Platform installed on the management cluster");
}

interface AppOpts {
  region: string;
  clusterName: string;
  k8sVersion?: string;
  amiId?: string;
  cpReplicas?: number;
  cpInstanceType?: string;
  vpcCidr?: string;
}

async function bootstrapAws(options: BootstrapOptions): Promise<void> {
  const kindName = options.name || "nebula";
  const region = options.region;
  if (!region) {
    throw new Error(
      "AWS provider requires --region (e.g. --region eu-central-1)",
    );
  }
  const clusterName = options.clusterName || "mgmt";
  const clusterNamespace = options.clusterNamespace || "default";
  const appOpts: AppOpts = {
    region,
    clusterName,
    k8sVersion: options.k8sVersion,
    amiId: options.amiId,
    cpReplicas: options.cpReplicas,
    cpInstanceType: options.cpInstanceType,
    vpcCidr: options.vpcCidr,
  };

  log("");
  log("🚀 Nebula AWS Bootstrap (vendor-free, self-managed k0s management cluster)");
  log("═".repeat(50));
  log(`   Kind cluster:    ${kindName}`);
  log(`   Region:          ${region}`);
  log(`   Mgmt cluster:    ${clusterName} (ns ${clusterNamespace})`);
  log(`   CP nodes:        ${appOpts.cpReplicas ?? 3} × ${appOpts.cpInstanceType ?? "m6i.large"}`);
  log(`   AMI:             ${appOpts.amiId ?? "(CAPA image lookup — set --ami-id)"}`);

  if (!commandExists("kubectl")) throw new Error("kubectl is not installed");
  if (!commandExists("aws")) throw new Error("aws CLI is not installed");
  if (!commandExists("kind")) throw new Error("kind is not installed");

  // Step 1: Kind bootstrap cluster (ephemeral).
  if (!options.skipKind) await createKindCluster(kindName);

  // Step 2: AWS credentials (Crossplane + CAPA secrets).
  if (!options.skipCredentials) {
    await setupAwsCredentials(region, options.awsProfile);
  }

  // Step 3: Synth + apply the bootstrap topology to Kind (in-process).
  await deployAwsBootstrapToKind(appOpts);

  // Step 4: Wait for the management cluster control plane.
  await waitForCapiClusterReady(clusterName, clusterNamespace, 1800);

  // Step 5: Fetch the management cluster kubeconfig.
  log("");
  log("🔄 Step 5: Fetching the management cluster kubeconfig");
  log("─".repeat(50));
  const mgmtKubeconfig = fetchCapiKubeconfig(clusterName, clusterNamespace);
  log(`   ✅ Wrote ${mgmtKubeconfig}`);

  // Step 6: Install the platform on the management cluster (no clusterctl pivot).
  if (!options.skipMgmtPlatform) {
    await deployMgmtPlatform(mgmtKubeconfig, appOpts, options.awsProfile);
  }

  log("");
  log("═".repeat(50));
  log("✨ AWS bootstrap complete!");
  log("");
  log("📋 Clusters:");
  log(`   Kind (bootstrap):  kind-${kindName}  (ephemeral — safe to delete)`);
  log(`   k0s (management):  ${clusterName}  →  KUBECONFIG="${mgmtKubeconfig}"`);
  log("");
  log("📋 Next:");
  log(`   export KUBECONFIG="${mgmtKubeconfig}"`);
  log("   kubectl get nodes                 # self-managed k0s management cluster");
  log(`   kind delete cluster --name ${kindName}   # discard the bootstrapper`);
  log("   # provision workload clusters from the mgmt cluster with AwsWorkloadCluster");
  log("");
}
