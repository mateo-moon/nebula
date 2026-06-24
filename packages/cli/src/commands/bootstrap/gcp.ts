/**
 * GCP provider — Kind → Crossplane provisions GKE → hand the control-plane stack
 * off to GKE, where ArgoCD inherits and GitOps-syncs the rest from git. Consumes a
 * project layout in the cwd (bootstrap.ts + infra/* + meta/argocd*).
 *
 * All shell execution is no-shell (run/kubectl → execFileSync, argv only); the
 * project id read from a committed config.ts and every K8s API value is passed
 * as an argv element, never interpreted by /bin/sh.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  run,
  kubectl,
  log,
  sleep,
  commandExists,
  createKindCluster,
  waitForProviders,
  waitFor,
  ensureNamespace,
} from "./shared";
import type { BootstrapOptions, BootstrapProvider } from "./types";

interface GkeClusterInfo {
  name: string;
  location: string;
  project: string;
}

/**
 * GKE accepts either a zone or a region for `--zone`/`--region`. Zones end in a
 * letter (e.g. `us-central1-a`); regions end in a digit (e.g. `europe-west3`).
 * Returns the matching flag pair so regional clusters don't abort bootstrap.
 */
function gkeLocationArgs(location: string): string[] {
  const isZone = /[a-z0-9]-[a-z]$/i.test(location);
  return [isZone ? "--zone" : "--region", location];
}

async function setupGcpCredentials(
  _project: string,
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
  ensureNamespace("crossplane-system");
  kubectl(["delete", "secret", "gcp-creds", "-n", "crossplane-system", "--ignore-not-found"], {
    silent: true,
    ignoreErrors: true,
  });
  kubectl(
    ["create", "secret", "generic", "gcp-creds", `--from-file=creds=${credsPath}`, "-n", "crossplane-system"],
  );
  log(`   ✅ GCP credentials secret created`);
}

async function deployToKind(): Promise<void> {
  log("");
  log("📦 Step 3: Deploying bootstrap to Kind");
  log("─".repeat(50));
  log("   Synthesizing bootstrap.ts...");
  run("npx", ["cdk8s", "synth", "--app", "npx tsx bootstrap.ts"]);
  log("   Applying manifests...");
  run("npx", ["nebula", "apply"]);
  log("   Waiting for Crossplane providers...");
  await waitForProviders(300);
  log(`   ✅ Bootstrap deployed to Kind`);
}

/** Discover GKE cluster info from the Crossplane managed resource in the Kind cluster. */
function discoverGkeCluster(): GkeClusterInfo | null {
  const get = (jsonpath: string): string =>
    kubectl(
      ["get", "cluster.container.gcp.upbound.io", "-o", `jsonpath=${jsonpath}`],
      { silent: true, ignoreErrors: true },
    ).trim();
  const name = get("{.items[0].metadata.name}");
  if (!name) return null;
  const location = get("{.items[0].spec.forProvider.location}");
  const project = get("{.items[0].spec.forProvider.project}");
  return name && location ? { name, location, project } : null;
}

async function waitForGkeClusterResource(timeoutSeconds: number): Promise<GkeClusterInfo> {
  log("");
  log("🔍 Discovering GKE cluster from Crossplane...");
  log("─".repeat(50));
  let found: GkeClusterInfo | null = null;
  await waitFor(
    { label: "GKE cluster resource", timeoutMs: timeoutSeconds * 1000, onTimeout: "throw" },
    () => {
      found = discoverGkeCluster();
      if (found) log(`   Found cluster: ${found.name} in ${found.location}`);
      return found !== null;
    },
  );
  return found!;
}

async function waitForGke(
  project: string,
  clusterName: string,
  location: string,
  timeoutSeconds: number,
): Promise<void> {
  log("");
  log("⏳ Step 4: Waiting for GKE cluster");
  log("─".repeat(50));
  log(`   Cluster: ${clusterName} in ${location}`);
  const start = Date.now();
  await waitFor(
    { label: "GKE cluster ready", timeoutMs: timeoutSeconds * 1000, onTimeout: "throw", intervalMs: 30000 },
    () => {
      const status = kubectl(
        [
          "get",
          "cluster.container.gcp.upbound.io",
          clusterName,
          "-o",
          "jsonpath={.status.conditions[?(@.type=='Ready')].status}",
        ],
        { silent: true, ignoreErrors: true },
      ).trim();
      if (status === "True") {
        log(`   ✅ GKE cluster is ready`);
        return true;
      }
      const gcloudStatus = run(
        "gcloud",
        [
          "container",
          "clusters",
          "describe",
          clusterName,
          ...gkeLocationArgs(location),
          "--project",
          project,
          "--format=value(status)",
        ],
        { silent: true, ignoreErrors: true },
      ).trim();
      if (gcloudStatus === "RUNNING") {
        log(`   ✅ GKE cluster is running`);
        return true;
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      log(`   Waiting... (${elapsed}s elapsed, status: ${gcloudStatus || "PROVISIONING"})`);
      return false;
    },
  );
}

async function switchToGke(
  project: string,
  clusterName: string,
  location: string,
): Promise<void> {
  log("");
  log("🔄 Step 5: Switching to GKE cluster");
  log("─".repeat(50));
  run("gcloud", [
    "container",
    "clusters",
    "get-credentials",
    clusterName,
    ...gkeLocationArgs(location),
    "--project",
    project,
  ]);
  log(`   ✅ Now using GKE cluster: ${clusterName}`);
}

/** Wait for all Crossplane Functions to become healthy (needed before XRs using Compositions). */
async function waitForCrossplaneFunctions(timeoutSeconds: number): Promise<void> {
  await waitFor(
    { label: "Crossplane functions", timeoutMs: timeoutSeconds * 1000, onTimeout: "warn" },
    () => {
      const functionsJson = kubectl(["get", "functions.pkg.crossplane.io", "-o", "json"], {
        silent: true,
        ignoreErrors: true,
      });
      const functions = JSON.parse(functionsJson || '{"items":[]}');
      if (functions.items.length === 0) {
        log("   No Crossplane functions found, skipping wait");
        return true;
      }
      const allHealthy = functions.items.every((fn: any) => {
        const cond = (t: string) =>
          fn.status?.conditions?.find((c: { type: string }) => c.type === t)?.status ===
          "True";
        return cond("Installed") && cond("Healthy");
      });
      if (allHealthy) {
        log(`   ✅ All ${functions.items.length} Crossplane functions healthy`);
        return true;
      }
      return false;
    },
  );
}

/** Trigger an ArgoCD sync on an app and retry until it reaches Synced or timeout. */
async function syncAppWithRetry(appName: string, timeoutSeconds: number): Promise<void> {
  const exists = kubectl(["get", "app", appName, "-n", "argocd", "-o", "name"], {
    silent: true,
    ignoreErrors: true,
  }).trim();
  if (!exists) {
    log(`   ⚠️  App ${appName} not found, skipping`);
    return;
  }
  log(`   Syncing ${appName}...`);
  let synced = false;
  await waitFor(
    { label: `${appName} sync`, timeoutMs: timeoutSeconds * 1000, onTimeout: "warn", intervalMs: 10000 },
    () => {
      const syncStatus = kubectl(
        ["get", "app", appName, "-n", "argocd", "jsonpath={.status.sync.status}"],
        { silent: true, ignoreErrors: true },
      ).trim();
      if (syncStatus === "Synced") {
        log(`   ✅ ${appName} synced`);
        synced = true;
        return true;
      }
      const opPhase = kubectl(
        ["get", "app", appName, "-n", "argocd", "jsonpath={.status.operationState.phase}"],
        { silent: true, ignoreErrors: true },
      ).trim();
      if (opPhase !== "Running") {
        kubectl(
          ["patch", "app", appName, "-n", "argocd", "--type", "json", "-p", JSON.stringify([{ op: "remove", path: "/status/operationState" }])],
          { silent: true, ignoreErrors: true },
        );
        kubectl(
          ["patch", "app", appName, "-n", "argocd", "--type", "merge", "-p", JSON.stringify({ metadata: { annotations: { "argocd.argoproj.io/refresh": "hard" } } })],
          { silent: true, ignoreErrors: true },
        );
        sleep(3000);
        kubectl(
          [
            "patch",
            "app",
            appName,
            "-n",
            "argocd",
            "--type",
            "merge",
            "-p",
            JSON.stringify({
              operation: {
                initiatedBy: { username: "nebula-bootstrap" },
                sync: {
                  syncOptions: [
                    "CreateNamespace=true",
                    "ServerSideApply=true",
                    "SkipDryRunOnMissingResource=true",
                    "RespectIgnoreDifferences=true",
                  ],
                },
              },
            }),
          ],
          { silent: true, ignoreErrors: true },
        );
      }
      return false;
    },
  );
  if (!synced) log(`   ⚠️  ${appName} did not reach Synced within ${timeoutSeconds}s`);
}

/** Wait for ArgoCD then sync the app-of-apps; ArgoCD auto-syncs everything else from git. */
async function syncCriticalApps(): Promise<void> {
  log("   Waiting for ArgoCD to be ready...");
  await waitFor(
    { label: "ArgoCD ready", timeoutMs: 120_000, onTimeout: "continue" },
    () => {
      const ready = kubectl(
        [
          "get",
          "statefulset",
          "argocd-application-controller",
          "-n",
          "argocd",
          "jsonpath={.status.readyReplicas}",
        ],
        { silent: true, ignoreErrors: true },
      ).trim();
      return !!(ready && parseInt(ready) > 0);
    },
  );
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
      kubectl(["get", "jobs", "-n", "argocd", "-o", "json"], { silent: true, ignoreErrors: true }) ||
        '{"items":[]}',
    );
    for (const job of jobs.items) {
      const failed = job.status?.conditions?.find(
        (c: { type: string; status: string }) => c.type === "Failed" && c.status === "True",
      );
      if (failed) {
        log(`   Deleting failed job ${job.metadata.name} (ArgoCD will recreate it)...`);
        kubectl(["delete", "job", job.metadata.name, "-n", "argocd"], {
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
      kubectl(["get", "crds", "-o", "json"], { silent: true, ignoreErrors: true }) ||
        '{"items":[]}',
    );
    for (const crd of crds.items) {
      if (!crd.metadata.deletionTimestamp) continue;
      const crdName = crd.metadata.name as string;
      if (!crdName.includes("crossplane.io")) continue;
      log(`   Found terminating Crossplane CRD: ${crdName}`);
      const instances = JSON.parse(
        kubectl(["get", crdName, "-A", "-o", "json"], { silent: true, ignoreErrors: true }) ||
          '{"items":[]}',
      );
      for (const inst of instances.items) {
        if ((inst.metadata.finalizers || []).length === 0) continue;
        const ns = inst.metadata.namespace as string | undefined;
        log(`   Removing finalizers from ${crdName}/${inst.metadata.name}...`);
        kubectl(
          [
            "patch",
            crdName,
            inst.metadata.name,
            ...(ns ? ["-n", ns] : []),
            "--type",
            "merge",
            "-p",
            JSON.stringify({ metadata: { finalizers: [] } }),
          ],
          { silent: true, ignoreErrors: true },
        );
      }
    }
  } catch {
    // non-critical
  }

  try {
    const revs = JSON.parse(
      kubectl(["get", "providerrevisions.pkg.crossplane.io", "-o", "json"], {
        silent: true,
        ignoreErrors: true,
      }) || '{"items":[]}',
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
      const target = match[1];
      // Defense-in-depth: only patch things that look like CRD names (<plural>.<group>).
      if (!/^[a-z0-9.-]+\.[a-z]+$/i.test(target)) continue;
      log(
        `   Clearing stale owner reference on CRD ${target} for provider revision ${rev.metadata.name}...`,
      );
      kubectl(
        ["patch", "crd", target, "--type", "merge", "-p", JSON.stringify({ metadata: { ownerReferences: [] } })],
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
    run("npx", ["cdk8s", "synth", "-o", `dist/${mod}`, "--app", `npx tsx ${entry}`], {
      silent: true,
      ignoreErrors: true,
    });
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
      run("npx", ["nebula", "apply", "--file", `dist/${mod}/*.k8s.yaml`], {
        silent: true,
        ignoreErrors: true,
      });
    }
  }
  log("   Waiting for Crossplane providers to be healthy...");
  await waitForProviders(300);
  log("   Waiting for Crossplane functions to be healthy...");
  await waitForCrossplaneFunctions(120);

  log("   Phase 2: Applying ArgoCD...");
  for (const mod of ["meta/argocd", "meta/argocd-apps"]) {
    if (fs.existsSync(`dist/${mod}`)) {
      run("npx", ["nebula", "apply", "--file", `dist/${mod}/*.k8s.yaml`], {
        silent: true,
        ignoreErrors: true,
      });
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
    const match = fs.readFileSync(configPath, "utf-8").match(/project:\s*["']([^"']+)["']/);
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
      `   GKE:  gcloud container clusters get-credentials ${gke.name} ${gkeLocationArgs(gke.location).join(" ")} --project ${gke.project || project}`,
    );
  }
  log("");
}

export const gcpProvider: BootstrapProvider = {
  name: "gcp",
  bootstrap: bootstrapGcp,
};
