/**
 * GCP provider — Kind → Crossplane provisions GKE → pivot the control-plane stack
 * onto GKE (ArgoCD then GitOps-syncs the rest). Consumes a project layout in the
 * cwd (bootstrap.ts + infra/* + meta/argocd*).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  exec,
  log,
  sleep,
  commandExists,
  createKindCluster,
  waitForProviders,
} from "./shared";
import type { BootstrapOptions, BootstrapProvider } from "./types";

interface GkeClusterInfo {
  name: string;
  location: string;
  project: string;
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
  exec("kubectl delete secret gcp-creds -n crossplane-system --ignore-not-found", {
    silent: true,
  });
  exec(
    `kubectl create secret generic gcp-creds --from-file=creds=${credsPath} -n crossplane-system`,
  );
  log(`   ✅ GCP credentials secret created`);
}

async function deployToKind(): Promise<void> {
  log("");
  log("📦 Step 3: Deploying bootstrap to Kind");
  log("─".repeat(50));
  log("   Synthesizing bootstrap.ts...");
  exec('npx cdk8s synth --app "npx tsx bootstrap.ts"');
  log("   Applying manifests...");
  exec("npx nebula apply");
  log("   Waiting for Crossplane providers...");
  await waitForProviders(300);
  log(`   ✅ Bootstrap deployed to Kind`);
}

/** Discover GKE cluster info from the Crossplane managed resource in the Kind cluster. */
function discoverGkeCluster(): GkeClusterInfo | null {
  try {
    const get = (jsonpath: string): string =>
      exec(
        `kubectl get cluster.container.gcp.upbound.io -o jsonpath="${jsonpath}" 2>/dev/null`,
        { silent: true },
      ).trim();
    const name = get("{.items[0].metadata.name}");
    if (!name) return null;
    const location = get("{.items[0].spec.forProvider.location}");
    const project = get("{.items[0].spec.forProvider.project}");
    return name && location ? { name, location, project } : null;
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
    const status = exec(
      `kubectl get cluster.container.gcp.upbound.io ${clusterName} -o jsonpath="{.status.conditions[?(@.type=='Ready')].status}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();
    if (status === "True") {
      log(`   ✅ GKE cluster is ready`);
      return;
    }
    const gcloudStatus = exec(
      `gcloud container clusters describe ${clusterName} --zone ${zone} --project ${project} --format="value(status)" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();
    if (gcloudStatus === "RUNNING") {
      log(`   ✅ GKE cluster is running`);
      return;
    }
    const elapsed = Math.round((Date.now() - start) / 1000);
    log(`   Waiting... (${elapsed}s elapsed, status: ${gcloudStatus || "PROVISIONING"})`);
    await sleep(30000);
  }
  throw new Error(`GKE cluster did not become ready within ${timeoutSeconds} seconds`);
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

/** Wait for all Crossplane Functions to become healthy (needed before XRs using Compositions). */
async function waitForCrossplaneFunctions(timeoutSeconds: number): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    try {
      const functionsJson = exec(
        "kubectl get functions.pkg.crossplane.io -o json 2>/dev/null || echo '{\"items\":[]}'",
        { silent: true },
      );
      const functions = JSON.parse(functionsJson);
      if (functions.items.length === 0) {
        log("   No Crossplane functions found, skipping wait");
        return;
      }
      const allHealthy = functions.items.every((fn: any) => {
        const cond = (t: string) =>
          fn.status?.conditions?.find((c: { type: string }) => c.type === t)
            ?.status === "True";
        return cond("Installed") && cond("Healthy");
      });
      if (allHealthy) {
        log(`   ✅ All ${functions.items.length} Crossplane functions healthy`);
        return;
      }
    } catch {
      // keep waiting
    }
    await sleep(5000);
  }
  log("   ⚠️  Timeout waiting for functions, continuing anyway...");
}

/** Trigger an ArgoCD sync on an app and retry until it reaches Synced or timeout. */
async function syncAppWithRetry(
  appName: string,
  timeoutSeconds: number,
): Promise<void> {
  const deadline = Date.now() + timeoutSeconds * 1000;
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
    const syncStatus = exec(
      `kubectl get app ${appName} -n argocd -o jsonpath="{.status.sync.status}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();
    if (syncStatus === "Synced") {
      log(`   ✅ ${appName} synced`);
      return;
    }
    const opPhase = exec(
      `kubectl get app ${appName} -n argocd -o jsonpath="{.status.operationState.phase}" 2>/dev/null || echo ""`,
      { silent: true },
    ).trim();
    if (opPhase !== "Running") {
      exec(
        `kubectl patch app ${appName} -n argocd --type=json -p='[{"op":"remove","path":"/status/operationState"}]' 2>/dev/null`,
        { silent: true, ignoreErrors: true },
      );
      exec(
        `kubectl patch app ${appName} -n argocd --type=merge -p '{"metadata":{"annotations":{"argocd.argoproj.io/refresh":"hard"}}}'`,
        { silent: true, ignoreErrors: true },
      );
      await sleep(3000);
      exec(
        `kubectl patch app ${appName} -n argocd --type=merge -p '{"operation":{"initiatedBy":{"username":"nebula-bootstrap"},"sync":{"syncOptions":["CreateNamespace=true","ServerSideApply=true","SkipDryRunOnMissingResource=true","RespectIgnoreDifferences=true"]}}}'`,
        { silent: true, ignoreErrors: true },
      );
    }
    await sleep(10000);
  }
  log(`   ⚠️  ${appName} did not reach Synced within ${timeoutSeconds}s`);
}

/** Wait for ArgoCD then sync the app-of-apps; ArgoCD auto-syncs everything else from git. */
async function syncCriticalApps(): Promise<void> {
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
  await syncAppWithRetry("argocd-apps", 180);
  log("   ✅ ArgoCD apps synced — auto-sync will handle the rest");
}

/**
 * Post-deployment health checks + automatic cleanup of known bootstrap failure modes:
 * failed argocd Jobs, terminating Crossplane CRDs blocked by finalizers, and provider
 * revisions blocked by stale CRD owner references.
 */
async function postDeploymentValidation(): Promise<void> {
  try {
    const jobs = JSON.parse(
      exec('kubectl get jobs -n argocd -o json 2>/dev/null || echo \'{"items":[]}\'', {
        silent: true,
      }),
    );
    for (const job of jobs.items) {
      const failed = job.status?.conditions?.find(
        (c: { type: string; status: string }) =>
          c.type === "Failed" && c.status === "True",
      );
      if (failed) {
        log(`   Deleting failed job ${job.metadata.name} (ArgoCD will recreate it)...`);
        exec(`kubectl delete job ${job.metadata.name} -n argocd`, {
          silent: true,
          ignoreErrors: true,
        });
      }
    }
  } catch {
    // non-critical
  }

  try {
    const crds = JSON.parse(
      exec('kubectl get crds -o json 2>/dev/null || echo \'{"items":[]}\'', {
        silent: true,
      }),
    );
    for (const crd of crds.items) {
      if (!crd.metadata.deletionTimestamp) continue;
      const crdName = crd.metadata.name as string;
      if (!crdName.includes("crossplane.io")) continue;
      log(`   Found terminating Crossplane CRD: ${crdName}`);
      const instances = JSON.parse(
        exec(`kubectl get ${crdName} -A -o json 2>/dev/null || echo '{"items":[]}'`, {
          silent: true,
        }),
      );
      for (const inst of instances.items) {
        if ((inst.metadata.finalizers || []).length === 0) continue;
        const nsFlag = inst.metadata.namespace ? `-n ${inst.metadata.namespace}` : "";
        log(`   Removing finalizers from ${crdName}/${inst.metadata.name}...`);
        exec(
          `kubectl patch ${crdName} ${inst.metadata.name} ${nsFlag} --type merge -p '{"metadata":{"finalizers":[]}}'`,
          { silent: true, ignoreErrors: true },
        );
      }
    }
  } catch {
    // non-critical
  }

  try {
    const revs = JSON.parse(
      exec(
        'kubectl get providerrevisions.pkg.crossplane.io -o json 2>/dev/null || echo \'{"items":[]}\'',
        { silent: true },
      ),
    );
    for (const rev of revs.items) {
      const healthy = rev.status?.conditions?.find(
        (c: { type: string }) => c.type === "RevisionHealthy",
      );
      if (healthy?.status === "True") continue;
      const match = (healthy?.message || "").match(
        /cannot establish control of object: (\S+) is already controlled by/,
      );
      if (!match) continue;
      log(
        `   Clearing stale owner reference on CRD ${match[1]} for provider revision ${rev.metadata.name}...`,
      );
      exec(
        `kubectl patch crd ${match[1]} --type merge -p '{"metadata":{"ownerReferences":[]}}'`,
        { silent: true, ignoreErrors: true },
      );
    }
  } catch {
    // non-critical
  }

  await sleep(10000);
  log("   Verifying Crossplane providers...");
  await waitForProviders(60);
  log("   ✅ Post-deployment validation complete");
}

/**
 * Deploy the minimum modules to bootstrap ArgoCD on GKE, then let ArgoCD GitOps-sync
 * the rest. Synthesizes infra/providers, infra/crossplane, meta/argocd, meta/argocd-apps
 * from the cwd project layout.
 */
async function deployToGke(): Promise<void> {
  log("");
  log("📦 Step 6: Deploying workloads to GKE");
  log("─".repeat(50));

  const modules = ["infra/providers", "infra/crossplane", "meta/argocd", "meta/argocd-apps"];

  if (fs.existsSync("dist")) fs.rmSync("dist", { recursive: true, force: true });
  fs.mkdirSync("dist", { recursive: true });

  log("   Synthesizing GKE modules...");
  for (const mod of modules) {
    const entry = fs.existsSync(`${mod}/index.ts`)
      ? `${mod}/index.ts`
      : fs.existsSync(`${mod}/dev.ts`)
        ? `${mod}/dev.ts`
        : null;
    if (!entry) continue;
    log(`   - ${entry}`);
    exec(`npx cdk8s synth -o "dist/${mod}" --app "npx tsx ${entry}"`, { silent: true });
  }

  // Fail fast on unresolved secret references rather than applying broken manifests.
  log("   Validating secrets resolution...");
  for (const mod of modules) {
    const dir = `dist/${mod}`;
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
      const match = fs.readFileSync(path.join(dir, file), "utf-8").match(/ref\+\S+/);
      if (match) {
        throw new Error(
          `Unresolved secret reference in ${mod}/${file}: ${match[0]}\n` +
            `Ensure 'vals' CLI is installed and SOPS decryption keys are accessible.\n` +
            `Test manually: vals get "${match[0]}"`,
        );
      }
    }
  }
  log("   ✅ All secrets resolved");

  log("   Phase 1: Applying Crossplane infrastructure...");
  for (const mod of ["infra/providers", "infra/crossplane"]) {
    if (fs.existsSync(`dist/${mod}`)) {
      exec(`npx nebula apply --file "dist/${mod}/*.k8s.yaml"`, { silent: true });
    }
  }
  log("   Waiting for Crossplane providers to be healthy...");
  await waitForProviders(300);
  log("   Waiting for Crossplane functions to be healthy...");
  await waitForCrossplaneFunctions(120);

  log("   Phase 2: Applying ArgoCD...");
  for (const mod of ["meta/argocd", "meta/argocd-apps"]) {
    if (fs.existsSync(`dist/${mod}`)) {
      exec(`npx nebula apply --file "dist/${mod}/*.k8s.yaml"`, { silent: true });
    }
  }
  log(`   ✅ Bootstrap modules deployed to GKE`);

  log("");
  log("🔄 Step 7: Syncing ArgoCD apps");
  log("─".repeat(50));
  await syncCriticalApps();

  log("");
  log("🔧 Step 8: Post-deployment validation");
  log("─".repeat(50));
  await postDeploymentValidation();
}

/** Read the GCP project id from config.ts in the cwd, if present. */
function readProjectFromConfig(): string | null {
  const configPath = path.join(process.cwd(), "config.ts");
  if (!fs.existsSync(configPath)) return null;
  try {
    const match = fs
      .readFileSync(configPath, "utf-8")
      .match(/project:\s*["']([^"']+)["']/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

async function bootstrapGcp(options: BootstrapOptions): Promise<void> {
  const clusterName = options.name || "nebula";
  const project = options.project || readProjectFromConfig();
  if (!project) {
    throw new Error(
      "GCP project ID is required. Use --project <id> or run 'nebula init' first.",
    );
  }

  log("");
  log("🚀 Nebula GCP Bootstrap");
  log("═".repeat(50));
  log(`   Kind cluster: ${clusterName}`);
  log(`   GCP project:  ${project}`);

  if (!commandExists("kubectl")) throw new Error("kubectl is not installed");
  if (!commandExists("gcloud")) throw new Error("gcloud is not installed");

  if (!options.skipKind) await createKindCluster(clusterName);
  if (!options.skipCredentials) await setupGcpCredentials(project, options.credentials);
  await deployToKind();

  let gke: GkeClusterInfo | null = null;
  if (!options.skipGke) {
    gke = await waitForGkeClusterResource(60);
    await waitForGke(gke.project || project, gke.name, gke.location, 900);
    await switchToGke(gke.project || project, gke.name, gke.location);
    await deployToGke();
  }

  log("");
  log("═".repeat(50));
  log("✨ Bootstrap complete!");
  log("");
  log("📋 Clusters:");
  log(`   Kind (management): kind-${clusterName}`);
  if (gke) log(`   GKE (workloads):   ${gke.name}`);
  log("");
  log("📋 Switch contexts:");
  log(`   Kind: kubectl config use-context kind-${clusterName}`);
  if (gke) {
    log(
      `   GKE:  gcloud container clusters get-credentials ${gke.name} --zone ${gke.location} --project ${gke.project || project}`,
    );
  }
  log("");
}

export const gcpProvider: BootstrapProvider = {
  name: "gcp",
  bootstrap: bootstrapGcp,
};
