/**
 * AWS provider — vendor-free: a self-managed HA k0s management cluster on EC2 via
 * Cluster API (CAPA), with no EKS. The Kind cluster only bootstraps; the standalone
 * k0s control plane is self-contained, so the platform is redeployed onto the new
 * cluster and Kind is discarded. With --gitops-dir, ArgoCD on the management
 * cluster inherits the platform (incl. infra/cluster-api) from git, so the cluster
 * owns its own lifecycle and Kind — the bootstrap scaffold — is simply deleted.
 *
 * All shell execution is no-shell (run/kubectl → execFileSync, argv only). AWS
 * credentials are never placed on the process argv: the CAPA base64 blob and the
 * Crossplane INI are both passed to kubectl via `--from-file=<tempfile>` (0600,
 * created in a private mkdtemp dir, removed in a `finally`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  run,
  kubectl,
  log,
  commandExists,
  createKindCluster,
  waitForProviders,
  waitForCrds,
  waitForManagedReady,
  waitFor,
  ensureNamespace,
  sleep,
} from "./shared";
import type { BootstrapOptions, BootstrapProvider } from "./types";
import { buildCapaCredentialsIni, toCapaB64 } from "nebula-cdk8s";
import { apply } from "../apply";

const MGMT_NAMESPACE = "default";

/** CRDs the cluster-api-operator installs at runtime that the cluster CRs depend on. */
const CAPI_CLUSTER_CRDS = [
  "clusters.cluster.x-k8s.io",
  "awsclusters.infrastructure.cluster.x-k8s.io",
  "awsmachinetemplates.infrastructure.cluster.x-k8s.io",
  "k0scontrolplanes.controlplane.cluster.x-k8s.io",
];

/**
 * Node IAM managed resources (created by the `Aws`/`AwsIam` module) that must be
 * fully Ready before any machine launches — see the gate in {@link bootstrapAws}.
 */
const NODE_IAM_KINDS = [
  "roles.iam.aws.upbound.io",
  "instanceprofiles.iam.aws.upbound.io",
  "rolepolicyattachments.iam.aws.upbound.io",
];

/**
 * Per-cluster directory for bootstrap artifacts (the management cluster's
 * kubeconfig and transient synth output). Lives under the user's home —
 * `~/.nebula/<cluster>/` — NOT the current working directory, so running the CLI
 * from anywhere (incl. inside a source tree) never litters it.
 */
function stateDir(clusterName: string): string {
  const dir = path.join(os.homedir(), ".nebula", clusterName);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/** Resolve AWS credentials from a named profile (handles static keys and SSO). */
function awsExportCredentials(profile?: string): AwsCreds {
  let out: string;
  try {
    out = run(
      "aws",
      [
        "configure",
        "export-credentials",
        ...(profile ? ["--profile", profile] : []),
        "--format",
        "env-no-export",
      ],
      { silent: true },
    );
  } catch (error: any) {
    throw new Error(
      `Failed to resolve AWS credentials${profile ? ` for profile '${profile}'` : ""}.\n` +
        `${error.message}\n` +
        `Run: aws sso login (SSO) or aws configure (static key). Requires AWS CLI v2.`,
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

  const { accessKeyId, secretAccessKey, sessionToken } =
    awsExportCredentials(profile);
  if (sessionToken && !kubeconfig) {
    log(
      "   ⚠️  Using temporary credentials (session token); they expire — prefer a static IAM user key for long bootstraps.",
    );
  }

  const ini = buildCapaCredentialsIni({
    accessKeyId,
    secretAccessKey,
    region,
    sessionToken,
  });
  const b64 = toCapaB64(ini);

  // Private temp dir (fresh, so no symlink-planting risk); 0600 files with O_EXCL
  // (`wx`); removed in a `finally` so creds never persist, even on throw/SIGKILL
  // of the kubectl calls below.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-aws-"));
  const iniPath = path.join(tmpDir, "creds.ini");
  const b64Path = path.join(tmpDir, "capa-creds.b64");
  try {
    fs.writeFileSync(iniPath, ini, { mode: 0o600, flag: "wx" });
    fs.writeFileSync(b64Path, b64, { mode: 0o600, flag: "wx" });

    // Crossplane provider-aws credentials (secretRef key 'creds') — via file, not argv.
    ensureNamespace("crossplane-system", kubeconfig);
    kubectl(["delete", "secret", "aws-creds", "-n", "crossplane-system", "--ignore-not-found"], {
      kubeconfig,
      silent: true,
      ignoreErrors: true,
    });
    kubectl(
      ["create", "secret", "generic", "aws-creds", `--from-file=creds=${iniPath}`, "-n", "crossplane-system"],
      { kubeconfig },
    );

    // CAPA credentials — AWS_B64ENCODED_CREDENTIALS via file (never on argv), AWS_REGION via literal.
    ensureNamespace("capa-system", kubeconfig);
    kubectl(["delete", "secret", "aws-capa-credentials", "-n", "capa-system", "--ignore-not-found"], {
      kubeconfig,
      silent: true,
      ignoreErrors: true,
    });
    kubectl(
      [
        "create",
        "secret",
        "generic",
        "aws-capa-credentials",
        `--from-file=AWS_B64ENCODED_CREDENTIALS=${b64Path}`,
        `--from-literal=AWS_REGION=${region}`,
        "-n",
        "capa-system",
      ],
      { kubeconfig },
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  log(
    `   ✅ Created secrets: aws-creds (crossplane-system), aws-capa-credentials (capa-system)${kubeconfig ? " on the management cluster" : ""}`,
  );
}

/** Install the repo deps once (the modules import nebula-cdk8s via a github ref). */
function ensureRepoDeps(gitopsDir: string): void {
  if (!fs.existsSync(path.join(gitopsDir, "node_modules"))) {
    log("   Installing repo dependencies (pnpm install)...");
    run("pnpm", ["install"], { cwd: gitopsDir });
  }
}

/**
 * Read the repo's `config.ts` — the single source of truth — by evaluating it with
 * tsx and printing the resolved object. Avoids brittle regex-scraping and keeps the
 * bootstrap's imperative values (region, cluster name) identical to what the cdk8s
 * modules (and ArgoCD) use.
 */
function readAwsRepoConfig(gitopsDir: string): {
  region: string;
  clusterName: string;
} {
  // Run a throwaway reader IN the repo dir so `import "./config"` resolves exactly
  // like the cdk8s modules do (tsx -e has ESM eval quirks; a real file does not).
  const reader = path.join(gitopsDir, ".nebula-readconfig.ts");
  fs.writeFileSync(
    reader,
    'import { config } from "./config";\nprocess.stdout.write(JSON.stringify(config));\n',
  );
  let out = "";
  try {
    out = run("npx", ["tsx", ".nebula-readconfig.ts"], {
      cwd: gitopsDir,
      silent: true,
    });
  } finally {
    fs.rmSync(reader, { force: true });
  }
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  let cfg: { aws?: { region?: string; clusterName?: string } } = {};
  try {
    cfg = JSON.parse(out.slice(start, end + 1));
  } catch {
    throw new Error(
      `Could not read config.ts from ${gitopsDir} (expected 'export const config').`,
    );
  }
  if (!cfg.aws?.region || !cfg.aws?.clusterName) {
    throw new Error("config.ts must define aws.region and aws.clusterName.");
  }
  return { region: cfg.aws.region, clusterName: cfg.aws.clusterName };
}

/**
 * Synth one in-repo cdk8s module (`<mod>/index.ts`, e.g. `infra/crossplane`) to a
 * per-module dir and assert it left no unresolved `ref+` secrets. This is the same
 * machinery ArgoCD's nebula-cmp sidecar runs — the bootstrap just applies the
 * modules imperatively first so the management cluster exists.
 */
function synthRepoModule(
  gitopsDir: string,
  mod: string,
  clusterName: string,
  ageKeyFile?: string,
): string {
  const outdir = path.join(
    stateDir(clusterName),
    "synth-repo",
    mod.replace(/\//g, "_"),
  );
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
  run("npx", ["tsx", `${mod}/index.ts`], {
    cwd: gitopsDir,
    env: {
      ...process.env,
      CDK8S_OUTDIR: outdir,
      ...(ageKeyFile ? { SOPS_AGE_KEY_FILE: ageKeyFile } : {}),
    },
  });
  assertNoUnresolvedRefs(outdir);
  return outdir;
}

/** Synth a repo module and apply it (optionally to another cluster's kubeconfig). */
async function applyRepoModule(
  gitopsDir: string,
  mod: string,
  clusterName: string,
  opts: { kubeconfig?: string; ageKeyFile?: string } = {},
): Promise<void> {
  const outdir = synthRepoModule(gitopsDir, mod, clusterName, opts.ageKeyFile);
  const prev = process.env.KUBECONFIG;
  if (opts.kubeconfig) process.env.KUBECONFIG = opts.kubeconfig;
  try {
    await apply({ file: `${outdir}/*.k8s.yaml` });
  } finally {
    if (opts.kubeconfig) {
      if (prev === undefined) delete process.env.KUBECONFIG;
      else process.env.KUBECONFIG = prev;
    }
  }
}

/**
 * Install the platform on a cluster by applying the repo's `infra/*` modules in
 * dependency order. Used ONLY for Kind (the minimum to run CAPA and create the
 * management cluster); on the management cluster ArgoCD installs the platform.
 * Per-module applies mean cross-module ordering is ours: CRD/controller modules
 * (crossplane, cert-manager) before the things that need them.
 */
async function deployPlatform(
  gitopsDir: string,
  clusterName: string,
  kubeconfig?: string,
): Promise<void> {
  const opts = { kubeconfig };
  // Crossplane controller + the Provider CRD the provider CRs depend on.
  await applyRepoModule(gitopsDir, "infra/crossplane", clusterName, opts);
  // cert-manager — its webhook must be up before the CAPA operator's Certificate.
  await applyRepoModule(gitopsDir, "infra/cert-manager", clusterName, opts);
  log("   Waiting for cert-manager webhook...");
  kubectl(
    ["-n", "cert-manager", "rollout", "status", "deploy/cert-manager-webhook", "--timeout=240s"],
    { kubeconfig },
  );
  // Crossplane provider-aws (ec2/iam/route53/kms) — wait until Healthy before the
  // node-IAM module (which manages IAM via provider-aws-iam).
  await applyRepoModule(gitopsDir, "infra/providers", clusterName, opts);
  log("   Waiting for Crossplane providers...");
  await waitForProviders(300, kubeconfig);
  // Re-apply: the ProviderConfig's CRD (providerconfigs.aws.upbound.io) only
  // registers once the provider is Healthy, so the first apply skipped it. Now the
  // CRD exists, this lands the ProviderConfig the IAM/CR modules reference.
  await applyRepoModule(gitopsDir, "infra/providers", clusterName, opts);
  // CAPA operator — cert-manager is up, so its Certificate is admitted first pass.
  // One idempotent re-apply as a safety net for webhook/CRD timing.
  await applyRepoModule(gitopsDir, "infra/cluster-api-operator", clusterName, opts);
  await applyRepoModule(gitopsDir, "infra/cluster-api-operator", clusterName, opts);
  // Node IAM (role + instance profile CAPA requires before launching machines).
  await applyRepoModule(gitopsDir, "infra/node-iam", clusterName, opts);
  await waitForProviders(300, kubeconfig);
}

/** Apply the management cluster CRs (after the operator installs the CAPA/k0s CRDs). */
async function deployCluster(
  gitopsDir: string,
  clusterName: string,
): Promise<void> {
  await applyRepoModule(gitopsDir, "infra/cluster-api", clusterName);
}

/** Wait until the CAPI cluster's control plane is ready and its kubeconfig secret exists. */
/**
 * Grace before "no control-plane Machine exists yet" becomes a failure. The
 * k0smotron controller churns on the (not-yet-reachable) control-plane NLB for
 * several minutes — "Error deleting old control nodes" / "Failed to update
 * status" i/o timeouts — before it creates the first machine (~4-5 min observed
 * live), so this must comfortably exceed that or it aborts a healthy bootstrap.
 */
const NO_MACHINE_GRACE_MS = 480_000; // 8 min
/** Grace after a node is Running before "k0s never initialized" becomes a failure (cloud-init/bootstrap died). */
const STUCK_RUNNING_GRACE_MS = 420_000; // 7 min

/** kubectl jsonpath read against the kind (management) cluster, trimmed. */
function kget(args: string[]): string {
  return kubectl(args, { silent: true, ignoreErrors: true }).trim();
}

/**
 * Scan AWSMachines for a TERMINAL provision failure (e.g. InstanceProvisionFailed:
 * InvalidKeyPair / UnauthorizedOperation). Returns a human message, or "" if none.
 * Transient not-ready reasons (InstanceProvisionStarted, …) are ignored.
 */
function awsMachineProvisionFailure(): string {
  const raw = kget([
    "get", "awsmachine", "-n", MGMT_NAMESPACE,
    "-o", `jsonpath={range .items[*]}{.metadata.name}|{.status.conditions[?(@.type=='InstanceReady')].status}|{.status.conditions[?(@.type=='InstanceReady')].reason}|{.status.conditions[?(@.type=='InstanceReady')].message}{'\\n'}{end}`,
  ]);
  for (const line of raw.split("\n").filter(Boolean)) {
    const [name, status, reason, message] = line.split("|");
    if (status === "False" && /fail|invalid|unauthor|denied/i.test(reason || "")) {
      return `${name}: ${reason}${message ? ` — ${message}` : ""}`;
    }
  }
  return "";
}

/**
 * Wait until the CAPI control plane is ready — but FAIL FAST on the failure modes
 * we've hit live, instead of blindly polling for the full timeout:
 *  1. an AWSMachine reports a terminal provision failure (seconds);
 *  2. no control-plane Machine exists after a grace period (the K0sControlPlane CR
 *     never got applied / never spawned machines — e.g. the webhook race);
 *  3. a node has been Running for a while but k0s never initialized (the node's
 *     cloud-init/bootstrap failed — surfaced with the instance id so the serial
 *     console can be read), rather than waiting out 30 minutes.
 */
async function waitForClusterReady(
  timeoutSeconds: number,
  clusterName: string,
): Promise<void> {
  log("");
  log("⏳ Step 4: Waiting for the management cluster (CAPI)");
  log("─".repeat(50));
  log(`   Cluster: ${clusterName} (ns ${MGMT_NAMESPACE})`);

  const start = Date.now();
  let firstRunningAt: number | null = null;
  let everSawMachine = false;

  while (Date.now() - start < timeoutSeconds * 1000) {
    const sinceStart = Date.now() - start;
    // Fully-qualify: once Crossplane's provider-argocd is installed, a bare
    // `cluster` is ambiguous (cluster.argocd.crossplane.io / k0smotron.io also
    // define `clusters`) and resolves to the wrong CRD → empty status forever.
    const cpReady = kget(["get", "cluster.cluster.x-k8s.io", clusterName, "-n", MGMT_NAMESPACE, "-o", "jsonpath={.status.controlPlaneReady}"]);
    const phase = kget(["get", "cluster.cluster.x-k8s.io", clusterName, "-n", MGMT_NAMESPACE, "-o", "jsonpath={.status.phase}"]);
    const kubeconfigExists = kget(["get", "secret", `${clusterName}-kubeconfig`, "-n", MGMT_NAMESPACE, "-o", "name"]);

    // Success.
    if (cpReady === "true" && kubeconfigExists) {
      log("   ✅ Management cluster control plane is ready");
      return;
    }

    // (1) Terminal AWSMachine provision failure — abort immediately.
    const failure = awsMachineProvisionFailure();
    if (failure) {
      throw new Error(`Control-plane node failed to provision: ${failure}`);
    }

    // Track control-plane machines and whether any has reached an EC2-running phase.
    const machines = kget([
      "get", "machine", "-n", MGMT_NAMESPACE,
      "-o", `jsonpath={range .items[*]}{.metadata.name}={.status.phase};{end}`,
    ]).split(";").filter(Boolean).map((s) => { const [n, p] = s.split("="); return { n, p }; })
      .filter((m) => m.p !== "Deleting");
    const anyRunning = machines.some((m) => m.p === "Running" || m.p === "Provisioned");
    if (anyRunning && firstRunningAt === null) firstRunningAt = Date.now();
    if (machines.length > 0) everSawMachine = true;

    // (2) No control-plane Machine after the grace period → K0sControlPlane never spawned one.
    // Only a TERMINAL "never created" condition: once any machine has appeared,
    // a transient 0-count (k0smotron recreating replicas) must not trip this.
    if (!everSawMachine && machines.length === 0 && sinceStart > NO_MACHINE_GRACE_MS) {
      throw new Error(
        `No control-plane Machine exists after ${Math.round(sinceStart / 1000)}s — the K0sControlPlane did not ` +
          `spawn one (likely the cluster CR was not applied, or the k0smotron control-plane webhook never came up). ` +
          `Check: kubectl get k0scontrolplane,machine -n ${MGMT_NAMESPACE}`,
      );
    }

    // (3) Node Running but k0s never initialized → node bootstrap/cloud-init failed.
    const cpInitialized = kget(["get", "k0scontrolplane", "-n", MGMT_NAMESPACE, "-o", "jsonpath={.items[0].status.initialization.controlPlaneInitialized}"]);
    if (firstRunningAt !== null && cpInitialized !== "true" && Date.now() - firstRunningAt > STUCK_RUNNING_GRACE_MS) {
      const instanceId = kget([
        "get", "awsmachine", "-n", MGMT_NAMESPACE,
        "-o", "jsonpath={.items[0].spec.providerID}",
      ]).replace(/^.*\//, "");
      throw new Error(
        `Control-plane node has been running for >${Math.round((Date.now() - firstRunningAt) / 1000)}s but k0s never ` +
          `initialized (controlPlaneInitialized=false). The node's bootstrap (cloud-init) almost certainly failed. ` +
          `Inspect the serial console: aws ec2 get-console-output --instance-id ${instanceId || "<id>"} --latest. ` +
          `Aborting early instead of waiting out the full timeout.`,
      );
    }

    log(
      `   Waiting... (${Math.round(sinceStart / 1000)}s, phase: ${phase || "Pending"}, ` +
        `cpReady: ${cpReady || "false"}, machines: ${machines.length}${anyRunning ? " running" : ""})`,
    );
    await sleep(20000);
  }
  throw new Error(`Timed out after ${timeoutSeconds}s waiting for management cluster ${clusterName}`);
}

/** Write the CAPI-generated kubeconfig for the management cluster to a local file. */
function fetchKubeconfig(clusterName: string): string {
  const b64 = kubectl(
    ["get", "secret", `${clusterName}-kubeconfig`, "-n", MGMT_NAMESPACE, "-o", "jsonpath={.data.value}"],
    { silent: true, ignoreErrors: true },
  ).trim();
  if (!b64) {
    throw new Error(
      `kubeconfig secret ${clusterName}-kubeconfig not found in ${MGMT_NAMESPACE}`,
    );
  }
  const kubeconfig = Buffer.from(b64, "base64").toString("utf-8");
  const kPath = path.join(stateDir(clusterName), "kubeconfig");
  fs.writeFileSync(kPath, kubeconfig, { mode: 0o600 });
  return kPath;
}

/** Throw if any synthed manifest still contains an unresolved `ref+` secret. */
function assertNoUnresolvedRefs(dir: string): void {
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
    const m = fs.readFileSync(path.join(dir, f), "utf-8").match(/ref\+[^\s"']+/);
    if (m) {
      throw new Error(
        `Unresolved secret reference in ${f}: ${m[0]} — ensure 'vals' and the ` +
          `SOPS age key are available where this runs, or set the value directly.`,
      );
    }
  }
}

/**
 * GitOps handoff (opt-in via --gitops-dir). Installs ArgoCD + the app-of-apps
 * from the repo subtree onto the management cluster and syncs the root app, so
 * ArgoCD reconciles the platform from git thereafter. Mirrors the GCP
 * deployToGke handoff. `gitopsDir` is a checked-out `aws/`-style layout
 * (meta/argocd, meta/argocd-apps); deps are installed if missing.
 */
async function deployGitopsHandoff(
  gitopsDir: string,
  kubeconfig: string,
  clusterName: string,
): Promise<void> {
  log("");
  log("📦 Step 7: GitOps handoff — ArgoCD ← git");
  log("─".repeat(50));

  ensureRepoDeps(gitopsDir);

  // The age key resolves ref+sops:// at synth time (here) and is mounted into the
  // repo-server CMP sidecar (as the nebula-sops-age Secret) for ArgoCD's own syncs.
  const ageKeyFile =
    process.env.SOPS_AGE_KEY_FILE ||
    path.join(process.env.HOME || "", ".config/sops/age/keys.txt");
  if (!fs.existsSync(ageKeyFile)) {
    throw new Error(
      `SOPS age key not found at ${ageKeyFile}. Set SOPS_AGE_KEY_FILE or place the ` +
        `key there so the GitOps handoff can resolve ref+sops:// and seed nebula-sops-age.`,
    );
  }
  log("   Creating the nebula-sops-age Secret (CMP SOPS decryption)...");
  ensureNamespace("argocd", kubeconfig);
  kubectl(["-n", "argocd", "delete", "secret", "nebula-sops-age", "--ignore-not-found"], {
    kubeconfig,
    silent: true,
  });
  kubectl(
    ["-n", "argocd", "create", "secret", "generic", "nebula-sops-age", `--from-file=keys.txt=${ageKeyFile}`],
    { kubeconfig },
  );

  // Install ArgoCD + the root app-of-apps. ArgoCD then reconciles infra/* (the full
  // platform) and apps/* onto the management cluster from git — the bootstrap does
  // NOT install the platform on mgmt; ArgoCD owns it.
  for (const mod of ["meta/argocd", "meta/argocd-apps"]) {
    log(`   Applying ${mod}...`);
    await applyRepoModule(gitopsDir, mod, clusterName, { kubeconfig, ageKeyFile });
  }

  // Wait for the ArgoCD application controller, then sync the root app-of-apps;
  // ArgoCD self-heals everything else from git.
  log("   Waiting for the ArgoCD application controller...");
  kubectl(
    [
      "-n", "argocd", "rollout", "status",
      "statefulset/argocd-application-controller", "--timeout=300s",
    ],
    { kubeconfig, ignoreErrors: true },
  );
  log("   Triggering the initial sync of argocd-apps...");
  kubectl(
    [
      "-n", "argocd", "patch", "app", "argocd-apps", "--type", "merge", "-p",
      '{"operation":{"initiatedBy":{"username":"nebula-bootstrap"},"sync":{}}}',
    ],
    { kubeconfig, ignoreErrors: true },
  );
  log("   ✅ ArgoCD will reconcile the platform from git (self-heal).");
}

/**
 * Wait until the management cluster API is STABLY reachable. As HA control-plane
 * replicas join, the internet-facing NLB adds/removes targets and the kubeconfig
 * endpoint flaps, so a single probe can spuriously fail mid-apply. Require several
 * consecutive successful health checks before installing the platform on it.
 */
async function waitForMgmtApiStable(
  kubeconfig: string,
  timeoutSeconds: number,
): Promise<void> {
  log("   Waiting for the management cluster API to stabilize...");
  const start = Date.now();
  const need = 3;
  let consecutive = 0;
  while (Date.now() - start < timeoutSeconds * 1000) {
    const ok =
      kubectl(["get", "--raw=/healthz"], {
        kubeconfig,
        silent: true,
        ignoreErrors: true,
      }).trim() === "ok";
    consecutive = ok ? consecutive + 1 : 0;
    if (consecutive >= need) {
      log("   ✅ Management cluster API is stable");
      return;
    }
    await sleep(5000);
  }
  throw new Error(
    `Management cluster API did not stabilize within ${timeoutSeconds}s`,
  );
}

async function bootstrapAws(options: BootstrapOptions): Promise<void> {
  const kindName = options.name || "nebula";

  // The repo is the single source of truth: everything configurable (cluster name,
  // region, AMI, replicas, instance type, …) lives in its config.ts and cdk8s
  // modules, NOT in CLI flags. The bootstrap just needs the path to that repo.
  const gitopsDir = path.resolve(options.gitopsDir || process.cwd());
  if (!fs.existsSync(path.join(gitopsDir, "config.ts"))) {
    throw new Error(
      `No config.ts in ${gitopsDir}. Run from your aws/ repo subtree or pass ` +
        `--gitops-dir <path>. Scaffold one with: nebula init --provider aws`,
    );
  }

  for (const tool of ["kubectl", "aws", "kind", "pnpm", "helm"]) {
    if (!commandExists(tool)) throw new Error(`${tool} is not installed`);
  }

  ensureRepoDeps(gitopsDir);
  const { region, clusterName } = readAwsRepoConfig(gitopsDir);

  log("");
  log("🚀 Nebula AWS Bootstrap (thin — ArgoCD reconciles the platform from git)");
  log("═".repeat(50));
  log(`   Repo (config):     ${gitopsDir}`);
  log(`   Kind (bootstrap):  ${kindName}`);
  log(`   Region:            ${region}`);
  log(`   Mgmt cluster:      ${clusterName}`);

  // Step 1: Kind bootstrap cluster (ephemeral — only runs CAPA to create mgmt).
  if (!options.skipKind) await createKindCluster(kindName);

  // Step 2: AWS credentials (Crossplane + CAPA secrets).
  if (!options.skipCredentials) await setupAwsCredentials(region, options.awsProfile);

  // Step 3: Platform on Kind ONLY — the minimum to run CAPA and create the mgmt
  // cluster. (On mgmt, ArgoCD installs the platform.) Then wait for the operator
  // to install the CAPA/k0s CRDs.
  log("");
  log("📦 Step 3: Bootstrapping the platform on Kind (to run CAPA)");
  log("─".repeat(50));
  await deployPlatform(gitopsDir, clusterName);
  log("   Waiting for the cluster-api-operator to install CAPA/k0s CRDs...");
  await waitForCrds(CAPI_CLUSTER_CRDS, 600);

  // Gate cluster creation on the node IAM being fully provisioned. CAPA launches
  // the EC2 instance as soon as its instance profile exists and won't wait for
  // Crossplane to finish attaching the role's policies. Wait for the role +
  // instance profile + policy attachments to be Ready, then let the IAM change
  // propagate to EC2's view before any machine launches.
  log("   Waiting for the node IAM (role + instance profile + policies) to be ready...");
  await waitForManagedReady(NODE_IAM_KINDS, 600);
  await sleep(20000); // IAM is eventually consistent — let it propagate to EC2

  // Step 4: Create the management cluster, then wait for its control plane.
  log("");
  log("📦 Step 4: Creating the management cluster (CAPA + k0s)");
  log("─".repeat(50));
  await deployCluster(gitopsDir, clusterName);
  await waitForClusterReady(1800, clusterName);

  // Step 5: Fetch the management cluster kubeconfig.
  log("");
  log("🔄 Step 5: Fetching the management cluster kubeconfig");
  log("─".repeat(50));
  const mgmtKubeconfig = fetchKubeconfig(clusterName);
  log(`   ✅ Wrote ${mgmtKubeconfig}`);
  await waitForMgmtApiStable(mgmtKubeconfig, 300);

  // Step 6: Hand off to ArgoCD. The bootstrap installs ONLY the credential secrets
  // and ArgoCD on the management cluster — ArgoCD then reconciles the full platform
  // (infra/*) and all apps (apps/*) from git, including the cluster's own CAPI
  // definition (it adopts the AWS resources Kind's CAPA created).
  await setupAwsCredentials(region, options.awsProfile, mgmtKubeconfig);
  await deployGitopsHandoff(gitopsDir, mgmtKubeconfig, clusterName);

  log("");
  log("═".repeat(50));
  log("✨ AWS bootstrap complete!");
  log("");
  log(`   Kind (bootstrap):  kind-${kindName}`);
  log(`   k0s (management):  ${clusterName}  →  KUBECONFIG="${mgmtKubeconfig}"`);
  log("");
  log("   ArgoCD now reconciles the whole platform and all apps from git — including");
  log("   infra/cluster-api, so the management cluster owns its own CAPI lifecycle.");
  log("   Kind was only the bootstrap scaffold — delete it freely once ArgoCD is green:");
  log(`     kind delete cluster --name ${kindName}`);
  log("");
  log(`   export KUBECONFIG="${mgmtKubeconfig}"`);
  log("   kubectl get nodes");
  log("");
}

export const awsProvider: BootstrapProvider = {
  name: "aws",
  bootstrap: bootstrapAws,
};
