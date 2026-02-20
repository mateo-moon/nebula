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

export interface BootstrapOptions {
  name?: string;
  project?: string;
  credentials?: string;
  skipKind?: boolean;
  skipCredentials?: boolean;
  skipGke?: boolean;
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

export async function bootstrap(options: BootstrapOptions): Promise<void> {
  const clusterName = options.name || "nebula";
  const project = options.project;

  if (!project) {
    throw new Error("GCP project ID is required. Use --project <id>");
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
