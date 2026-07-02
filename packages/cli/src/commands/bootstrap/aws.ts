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
 * cluster-api-operator provider CRs that must report Ready=True on the move TARGET
 * (the management cluster) before {@link pivotToMgmt} runs `clusterctl move`. A
 * missing provider Kind makes move fail mid-graph with a `NoKindMatchError`, so all
 * of them — CAPI core, the AWS + k0smotron infra providers, and k0smotron's
 * bootstrap/control-plane providers — must be installed and Ready first.
 */
const CAPI_OPERATOR_PROVIDERS = [
  "coreproviders.operator.cluster.x-k8s.io",
  "infrastructureproviders.operator.cluster.x-k8s.io",
  "bootstrapproviders.operator.cluster.x-k8s.io",
  "controlplaneproviders.operator.cluster.x-k8s.io",
];

/**
 * clusterctl version pinned to the CAPI CORE contract the cluster-api-operator
 * installs (CoreProvider v1.12.9 → the v1beta2 contract). `clusterctl move` runs
 * `CheckCAPIContract` against BOTH the Kind source and the mgmt target; clusterctl
 * and the core provider must agree on the contract (a v1beta2 clusterctl refuses a
 * v1beta1 cluster and vice-versa). The host's clusterctl is whatever happens to be
 * on PATH, so the pivot fetches + caches a matching binary under ~/.nebula/bin
 * instead of depending on it. MUST stay in lockstep with the operator's CoreProvider
 * version (nebula k8s/cluster-api-operator: `cluster-api` v1.12.9) — match the
 * clusterctl MINOR to the core minor for move/upgrade.
 */
const CLUSTERCTL_VERSION = "v1.12.9";

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

/**
 * Create the Crossplane (`aws-creds`) and CAPA (`aws-capa-credentials`) secrets with
 * real exported keys. Always used on the KIND bootstrap cluster (it has no instance
 * profile, so it needs real keys to provision the node role + AWS resources). Also
 * baked on the MANAGEMENT cluster (pass `kubeconfig`) ONLY for a SECRET-mode
 * (non-keyless) cluster — a keyless cluster authenticates via the node instance
 * profile and never gets credential secrets baked here.
 */
async function setupAwsCredentials(
  region: string,
  profile?: string,
  kubeconfig?: string,
): Promise<void> {
  if (!kubeconfig) {
    log("");
    log("🔐 Step 2: Setting up AWS credentials (Kind bootstrap cluster)");
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
interface OidcConfig {
  accountId: string;
  bucket: string;
  issuerUrl: string;
  providerRoleArn: string;
}

function readAwsRepoConfig(gitopsDir: string): {
  region: string;
  clusterName: string;
  keyless: boolean;
  oidc?: OidcConfig;
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
  let cfg: {
    aws?: { region?: string; clusterName?: string; keyless?: boolean };
    oidc?: OidcConfig;
  } = {};
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
  return {
    region: cfg.aws.region,
    clusterName: cfg.aws.clusterName,
    keyless: cfg.aws.keyless === true,
    oidc: cfg.oidc,
  };
}

/** The coarse controller permission set (shared with AwsIam's node-role inline policy). */
const CONTROLLER_POLICY_JSON = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Sid: "NebulaControllers",
      Effect: "Allow",
      Resource: "*",
      Action: [
        "ec2:*",
        "elasticloadbalancing:*",
        "autoscaling:*",
        "iam:*",
        "route53:*",
        "kms:*",
        "ssm:GetParameter",
        "ssm:GetParameters",
        "secretsmanager:*",
        "tag:GetResources",
      ],
    },
  ],
});

/** True if an `aws`/`kubectl` invocation failed only because the resource already exists. */
function isAlreadyExists(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /EntityAlreadyExists|BucketAlreadyOwnedByYou|already exists/i.test(m);
}

/**
 * IRSA setup (keyless): make AWS STS able to validate this cluster's service-account
 * tokens and create the IAM role the Crossplane provider assumes. Runs on the live
 * management cluster with the BOOTSTRAP credentials (idempotent), BEFORE the GitOps
 * handoff — because the handoff's keyless auth probe needs the OIDC provider + role
 * to already exist. Steps: publish the cluster's real OIDC discovery + JWKS to a
 * public S3 bucket; register the IAM OIDC provider for that issuer; create the
 * provider role with a WebIdentity trust policy + the controller permissions inline.
 * CAPA is unaffected (it stays keyless via the node instance profile).
 */
async function setupIrsa(
  mgmtKubeconfig: string,
  region: string,
  clusterName: string,
  oidc: OidcConfig,
  profile?: string,
): Promise<void> {
  log("");
  log("🔑 Step 5.5: IRSA — self-hosted OIDC for the Crossplane provider (keyless)");
  log("─".repeat(50));
  const aws = (args: string[], opts: { ignoreErrors?: boolean } = {}) =>
    run("aws", [...(profile ? ["--profile", profile] : []), ...args], {
      silent: true,
      ignoreErrors: opts.ignoreErrors,
    });
  const oidcHost = oidc.issuerUrl.replace(/^https:\/\//, ""); // <bucket>.s3.<region>.amazonaws.com
  const providerArn = `arn:aws:iam::${oidc.accountId}:oidc-provider/${oidcHost}`;
  const roleName = `${clusterName}-crossplane-provider-aws`;

  // 1. Fetch the cluster's REAL OIDC discovery + JWKS (signed with k0s's sa.key, so
  //    the published JWKS matches the token signatures) and write the discovery doc.
  const jwks = kubectl(["get", "--raw", "/openid/v1/jwks"], {
    kubeconfig: mgmtKubeconfig,
    silent: true,
  });
  const discovery = JSON.stringify({
    issuer: oidc.issuerUrl,
    jwks_uri: `${oidc.issuerUrl}/keys.json`,
    authorization_endpoint: "urn:kubernetes:programmatic_authorization",
    response_types_supported: ["id_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    claims_supported: ["sub", "iss"],
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nebula-irsa-"));
  const jwksPath = path.join(tmpDir, "keys.json");
  const discPath = path.join(tmpDir, "openid-configuration");
  const trustPath = path.join(tmpDir, "trust.json");
  try {
    fs.writeFileSync(jwksPath, jwks, { mode: 0o600 });
    fs.writeFileSync(discPath, discovery, { mode: 0o600 });

    // 2. Public S3 bucket (ACLs disabled by default → public read via bucket POLICY,
    //    not --acl). Idempotent.
    log(`   Creating/configuring OIDC bucket ${oidc.bucket}...`);
    try {
      aws([
        "s3api", "create-bucket", "--bucket", oidc.bucket, "--region", region,
        "--create-bucket-configuration", `LocationConstraint=${region}`,
      ]);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
    aws(["s3api", "delete-public-access-block", "--bucket", oidc.bucket], { ignoreErrors: true });
    const bucketPolicy = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "PublicReadOidc",
          Effect: "Allow",
          Principal: "*",
          Action: "s3:GetObject",
          Resource: [
            `arn:aws:s3:::${oidc.bucket}/.well-known/openid-configuration`,
            `arn:aws:s3:::${oidc.bucket}/keys.json`,
          ],
        },
      ],
    });
    aws(["s3api", "put-bucket-policy", "--bucket", oidc.bucket, "--policy", bucketPolicy]);

    // 3. Upload discovery + JWKS (object key has NO extension for the discovery doc).
    log("   Publishing OIDC discovery + JWKS to S3...");
    aws(["s3api", "put-object", "--bucket", oidc.bucket, "--key", ".well-known/openid-configuration",
      "--body", discPath, "--content-type", "application/json"]);
    aws(["s3api", "put-object", "--bucket", oidc.bucket, "--key", "keys.json",
      "--body", jwksPath, "--content-type", "application/json"]);

    // 4. Verify both are publicly reachable over HTTPS before wiring IAM (AWS STS
    //    needs this). S3 is eventually consistent — retry briefly.
    log("   Verifying OIDC discovery is publicly reachable...");
    for (const suffix of ["/.well-known/openid-configuration", "/keys.json"]) {
      let ok = false;
      for (let i = 0; i < 12 && !ok; i++) {
        const code = run("curl", ["-s", "-o", "/dev/null", "-w", "%{http_code}", `${oidc.issuerUrl}${suffix}`],
          { silent: true, ignoreErrors: true }).trim();
        ok = code === "200";
        if (!ok) await sleep(5000);
      }
      if (!ok) throw new Error(`OIDC document not reachable: ${oidc.issuerUrl}${suffix} (S3 public access / region host?)`);
    }

    // 5. IAM OIDC provider (thumbprint is a required-but-ignored placeholder for the
    //    S3-hosted JWKS — AWS trusts the S3 CA). Idempotent.
    log("   Registering the IAM OIDC provider...");
    try {
      aws(["iam", "create-open-id-connect-provider", "--url", oidc.issuerUrl,
        "--client-id-list", "sts.amazonaws.com",
        "--thumbprint-list", "3fe05b486e3f0987130ba1d4ea0f299539a58243"]);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      log("   (OIDC provider already exists)");
    }

    // 6. Provider role with WebIdentity trust (scoped to the provider SAs) + the
    //    controller permissions inline. Idempotent.
    log(`   Creating the provider role ${roleName}...`);
    const trust = JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Federated: providerArn },
          Action: "sts:AssumeRoleWithWebIdentity",
          Condition: {
            StringEquals: { [`${oidcHost}:aud`]: "sts.amazonaws.com" },
            StringLike: {
              [`${oidcHost}:sub`]: "system:serviceaccount:crossplane-system:provider-aws-*",
            },
          },
        },
      ],
    });
    fs.writeFileSync(trustPath, trust, { mode: 0o600 });
    try {
      aws(["iam", "create-role", "--role-name", roleName,
        "--assume-role-policy-document", `file://${trustPath}`]);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
      // Keep the trust policy current on re-runs.
      aws(["iam", "update-assume-role-policy", "--role-name", roleName,
        "--policy-document", `file://${trustPath}`], { ignoreErrors: true });
    }
    // Attach the controller permissions as a CUSTOMER-MANAGED policy (iam:CreatePolicy
    // + iam:AttachRolePolicy — NOT iam:PutRolePolicy, which an SSO PowerUser
    // permission set may not grant). This is the SAME policy AwsIam creates on Kind
    // for the node role (`<cluster>-controllers`); create-if-missing keeps setupIrsa
    // self-sufficient and idempotent.
    const controllerPolicyName = `${clusterName}-controllers`;
    const controllerPolicyArn = `arn:aws:iam::${oidc.accountId}:policy/${controllerPolicyName}`;
    try {
      aws([
        "iam", "create-policy", "--policy-name", controllerPolicyName,
        "--policy-document", CONTROLLER_POLICY_JSON,
        "--description", "Nebula keyless mgmt controller permissions (CAPA + Crossplane)",
      ]);
    } catch (e) {
      if (!isAlreadyExists(e)) throw e;
    }
    aws(["iam", "attach-role-policy", "--role-name", roleName, "--policy-arn", controllerPolicyArn]);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  log(`   ✅ IRSA ready: issuer ${oidc.issuerUrl}, role ${oidc.providerRoleArn}`);
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
  opts: { ageKeyFile?: string; extraEnv?: Record<string, string> } = {},
): string {
  const outdir = path.join(
    stateDir(clusterName),
    "synth-repo",
    mod.replace(/\//g, "_"),
  );
  fs.rmSync(outdir, { recursive: true, force: true });
  fs.mkdirSync(outdir, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CDK8S_OUTDIR: outdir,
    ...(opts.ageKeyFile ? { SOPS_AGE_KEY_FILE: opts.ageKeyFile } : {}),
  };
  // The Kind-stage credential mode must be driven ONLY by an explicit per-call
  // override, never by whatever the operator happens to have exported in their
  // shell — a stray ambient NEBULA_AWS_CREDS_MODE=secret would otherwise leak into
  // the keyless mgmt/handoff synths and silently render secret-mode (referencing
  // creds that don't exist on the keyless cluster). Strip it, then apply extraEnv.
  delete env.NEBULA_AWS_CREDS_MODE;
  Object.assign(env, opts.extraEnv ?? {});
  log(
    `   synth ${mod} (creds mode: ${env.NEBULA_AWS_CREDS_MODE === "secret" ? "secret" : "keyless/default"})`,
  );
  run("npx", ["tsx", `${mod}/index.ts`], { cwd: gitopsDir, env });
  assertNoUnresolvedRefs(outdir);
  return outdir;
}

/** Synth a repo module and apply it (optionally to another cluster's kubeconfig). */
async function applyRepoModule(
  gitopsDir: string,
  mod: string,
  clusterName: string,
  opts: {
    kubeconfig?: string;
    ageKeyFile?: string;
    extraEnv?: Record<string, string>;
  } = {},
): Promise<void> {
  const outdir = synthRepoModule(gitopsDir, mod, clusterName, {
    ageKeyFile: opts.ageKeyFile,
    extraEnv: opts.extraEnv,
  });
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
  // Kind has no instance profile, so the credential-mode-aware modules
  // (infra/providers, infra/cluster-api-operator) must render SECRET creds here —
  // Crossplane provider-aws reads `aws-creds` and CAPA reads `aws-capa-credentials`
  // (both seeded by setupAwsCredentials). On the management cluster these same
  // modules default to keyless (instance profile). Only those two modules read the
  // var; the rest ignore it, so it's safe to set for every apply in this Kind-only
  // function.
  const opts = { kubeconfig, extraEnv: { NEBULA_AWS_CREDS_MODE: "secret" } };
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
    // CAPI v1beta2 removed the v1beta1 `status.controlPlaneReady` boolean; the
    // equivalent "CP API is up and the kubeconfig is valid" signal is
    // `status.initialization.controlPlaneInitialized` (set once, stays true). The
    // old field renders empty under v1beta2, so probing it waits out the full
    // timeout on a perfectly healthy cluster.
    const cpReady = kget(["get", "cluster.cluster.x-k8s.io", clusterName, "-n", MGMT_NAMESPACE, "-o", "jsonpath={.status.initialization.controlPlaneInitialized}"]);
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
 * Fetch + cache a {@link CLUSTERCTL_VERSION}-pinned clusterctl binary under
 * ~/.nebula/bin and return its path. We never trust the host's clusterctl: the pivot
 * needs a binary on the SAME CAPI contract the operator installs (v1beta1), and a
 * newer host clusterctl hard-refuses the move. Cached across runs; downloaded once.
 */
async function ensureClusterctl(): Promise<string> {
  const binDir = path.join(os.homedir(), ".nebula", "bin");
  const dest = path.join(binDir, `clusterctl-${CLUSTERCTL_VERSION}`);
  if (fs.existsSync(dest)) return dest;

  fs.mkdirSync(binDir, { recursive: true });
  const arch = os.arch() === "arm64" ? "arm64" : "amd64";
  const plat = os.platform() === "darwin" ? "darwin" : "linux";
  const url =
    `https://github.com/kubernetes-sigs/cluster-api/releases/download/` +
    `${CLUSTERCTL_VERSION}/clusterctl-${plat}-${arch}`;
  log(`   Fetching clusterctl ${CLUSTERCTL_VERSION} (${plat}/${arch})...`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download clusterctl ${CLUSTERCTL_VERSION} from ${url} (HTTP ${res.status}).`,
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  // Write to a private temp name then rename so a concurrent/aborted run never
  // leaves a half-written binary at the cached path.
  const tmp = path.join(binDir, `.clusterctl-${CLUSTERCTL_VERSION}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, buf, { mode: 0o755 });
  fs.renameSync(tmp, dest);
  const reported = run(dest, ["version", "--output", "short"], {
    silent: true,
    ignoreErrors: true,
  }).trim();
  if (!reported.includes(CLUSTERCTL_VERSION)) {
    log(`   ⚠️  clusterctl reports "${reported}", expected ${CLUSTERCTL_VERSION} (continuing).`);
  }
  return dest;
}

/** Wait until every {@link CAPI_OPERATOR_PROVIDERS} CR reports Ready=True on `kubeconfig`. */
async function waitForCapiProvidersReady(
  timeoutSeconds: number,
  kubeconfig: string,
): Promise<void> {
  await waitFor(
    {
      label: "CAPI providers Ready (core + aws + k0smotron)",
      timeoutMs: timeoutSeconds * 1000,
      intervalMs: 10000,
      onTimeout: "throw",
    },
    () => {
      for (const kind of CAPI_OPERATOR_PROVIDERS) {
        const opts = { kubeconfig, silent: true, ignoreErrors: true } as const;
        const items = kubectl(
          ["get", kind, "-A", "-o", "jsonpath={.items[*].metadata.name}"],
          opts,
        ).trim().split(" ").filter(Boolean);
        if (items.length === 0) return false; // provider CR not created yet
        const ready = kubectl(
          ["get", kind, "-A", "-o", "jsonpath={.items[*].status.conditions[?(@.type=='Ready')].status}"],
          opts,
        ).trim().split(" ").filter(Boolean);
        if (ready.length !== items.length || !ready.every((s) => s === "True")) return false;
      }
      log("   ✅ CAPI providers Ready on mgmt");
      return true;
    },
  );
}

/**
 * Verify the pivot landed cleanly: the management cluster now owns the control-plane
 * Machine (the adopted node — proof its k0smotron took over the MOVED object rather
 * than bootstrapping a duplicate) and the cluster CA secret is present (the SAME CA
 * was carried over, so no fresh-CA split-brain). More than one control-plane Machine
 * would mean a second CP node was minted — the exact failure this whole pivot exists
 * to prevent — so surface the count.
 */
async function verifyPivot(kubeconfig: string, clusterName: string): Promise<void> {
  log("   Verifying the pivot on mgmt (adopted CP Machine + reused CA)...");
  await waitFor(
    {
      label: "moved control-plane Machine adopted on mgmt",
      timeoutMs: 300_000,
      intervalMs: 10000,
      onTimeout: "throw",
    },
    () => {
      const cp = kubectl(
        ["get", "machines", "-n", MGMT_NAMESPACE, "-l", "cluster.x-k8s.io/control-plane",
          "-o", "jsonpath={.items[*].metadata.name}"],
        { kubeconfig, silent: true, ignoreErrors: true },
      ).trim().split(" ").filter(Boolean);
      return cp.length >= 1;
    },
  );
  const ca = kubectl(
    ["get", "secret", `${clusterName}-ca`, "-n", MGMT_NAMESPACE, "-o", "name"],
    { kubeconfig, silent: true, ignoreErrors: true },
  ).trim();
  if (!ca) {
    throw new Error(
      `Pivot verify: ${clusterName}-ca not found on mgmt — the cluster CA did not move ` +
        `(a fresh CA would mean split-brain). Aborting before the ArgoCD handoff.`,
    );
  }
  const cpCount = kubectl(
    ["get", "machines", "-n", MGMT_NAMESPACE, "-l", "cluster.x-k8s.io/control-plane",
      "-o", "jsonpath={.items[*].metadata.name}"],
    { kubeconfig, silent: true, ignoreErrors: true },
  ).trim().split(" ").filter(Boolean).length;
  log(`   ✅ Pivot verified: ${cpCount} control-plane Machine(s) on mgmt, CA reused.`);
  if (cpCount > 1) {
    log(`   ⚠️  More than one control-plane Machine on mgmt — investigate for a duplicate CP node.`);
  }
}

/**
 * One-time PIVOT: `clusterctl move` the CAPI object graph from the Kind bootstrap
 * cluster onto the management cluster, so the management cluster's OWN CAPA +
 * k0smotron adopt the existing control plane (Machine graph + cluster CA) instead of
 * bootstrapping a duplicate CP node. This is what makes the everything-in-git model
 * work for a self-managed (non-EKS) k0s control plane: k0smotron's K0sControlPlane has
 * NO machine-adoption logic, so simply re-applying its spec on a fresh cluster (what
 * ArgoCD would do) mints a SECOND CP node with a FRESH CA — the split-brain. `move`
 * instead transfers the live Machine/AWSMachine (with their providerID, so CAPA
 * re-adopts the running EC2 — no re-provision) and the CA/PKI secrets (owned up the
 * Cluster graph, so the SAME CA is reused), pausing the source and unpausing the
 * target. Runs ONCE at bootstrap; steady state is then 100% git/ArgoCD.
 *
 * MUST complete BEFORE ArgoCD reconciles infra/cluster-api — otherwise the mgmt
 * k0smotron reconciles the (un-adopted) K0sControlPlane spec and bootstraps the
 * duplicate. The move target therefore gets its providers installed here
 * (cert-manager + cluster-api-operator), but NO Cluster/K0sControlPlane CRs and NO
 * ArgoCD, until the move has landed.
 */
async function pivotToMgmt(
  gitopsDir: string,
  kindName: string,
  mgmtKubeconfig: string,
  clusterName: string,
  ageKeyFile: string,
): Promise<void> {
  log("");
  log("📦 Step 6.5: Pivot — clusterctl move (Kind → management cluster)");
  log("─".repeat(50));

  // 1. Install the move TARGET's providers on mgmt — cert-manager (the operator's
  //    webhook Certificate needs it) then the cluster-api-operator (CAPA + k0smotron).
  //    Mirrors deployPlatform's Kind sequence, but on mgmt and in the cluster's native
  //    creds mode (config.aws.keyless drives the module render — keyless = instance
  //    profile, no NEBULA_AWS_CREDS_MODE override here). NO Cluster/K0sControlPlane CRs
  //    and NO ArgoCD yet: the target must have the controllers but no CAPI objects
  //    before the move (pausing only sets Cluster.spec.paused; it does not stop a
  //    target controller that already has objects to reconcile).
  const opts = { kubeconfig: mgmtKubeconfig, ageKeyFile };
  log("   Installing cert-manager on mgmt (move-target prereq)...");
  await applyRepoModule(gitopsDir, "infra/cert-manager", clusterName, opts);
  kubectl(
    ["-n", "cert-manager", "rollout", "status", "deploy/cert-manager-webhook", "--timeout=240s"],
    { kubeconfig: mgmtKubeconfig },
  );
  log("   Installing cluster-api-operator (CAPA + k0smotron) on mgmt...");
  await applyRepoModule(gitopsDir, "infra/cluster-api-operator", clusterName, opts);
  await applyRepoModule(gitopsDir, "infra/cluster-api-operator", clusterName, opts);
  log("   Waiting for the CAPA/k0s CRDs + providers on mgmt...");
  await waitForCrds(CAPI_CLUSTER_CRDS, 600, mgmtKubeconfig);
  await waitForCapiProvidersReady(600, mgmtKubeconfig);

  // 2. clusterctl move (version-pinned to the operator's CAPI contract). Dry-run first
  //    as a preflight: it validates the object graph AND that BOTH source and target
  //    satisfy the contract, with no side effects, so a contract/provider mismatch
  //    fails fast and locally instead of half-moving the live graph.
  const clusterctl = await ensureClusterctl();
  const moveArgs = [
    "move",
    "--kubeconfig-context", `kind-${kindName}`,
    "--to-kubeconfig", mgmtKubeconfig,
    "-n", MGMT_NAMESPACE,
  ];
  log("   Preflight: clusterctl move --dry-run...");
  run(clusterctl, [...moveArgs, "--dry-run"]);
  log(`   Moving the CAPI object graph: kind-${kindName} → ${clusterName}...`);
  // On a half-failed move clusterctl leaves the SOURCE Cluster paused (CAPI #7407) and
  // does not auto-unpause it; surface that remediation rather than swallow the error.
  try {
    run(clusterctl, moveArgs);
  } catch (e: any) {
    throw new Error(
      `clusterctl move failed. The source (kind-${kindName}) Cluster may be left paused — ` +
        `if you retry/roll back, clear it with:\n` +
        `  kubectl --context kind-${kindName} patch cluster ${clusterName} -n ${MGMT_NAMESPACE} ` +
        `--type=merge -p '{"spec":{"paused":false}}'\n${e?.message ?? e}`,
    );
  }
  log("   ✅ Move complete — mgmt owns the Cluster / K0sControlPlane / Machine + CA.");

  // 3. Verify the pivot before handing off to ArgoCD.
  await verifyPivot(mgmtKubeconfig, clusterName);
}

/**
 * GitOps handoff (opt-in via --gitops-dir). Installs Crossplane + provider-aws,
 * performs the one-time {@link pivotToMgmt} (clusterctl move Kind → mgmt) so the
 * management cluster adopts its own control plane, and only THEN installs ArgoCD +
 * the app-of-apps and syncs the root app, so ArgoCD reconciles the platform — incl.
 * the now-adopted infra/cluster-api — from git thereafter. Mirrors the GCP deployToGke
 * handoff (Crossplane before ArgoCD). In KEYLESS mode the provider authenticates via
 * the node instance profile (`type: none`) with NO AWS keys baked on mgmt; in secret
 * mode the caller must bake `aws-creds`/`aws-capa-credentials` on mgmt FIRST.
 * `gitopsDir` is a checked-out `aws/`-style layout (infra/crossplane, infra/providers,
 * infra/node-iam, infra/cluster-api-operator, meta/argocd, meta/argocd-apps); deps are
 * installed if missing.
 */
async function deployGitopsHandoff(
  gitopsDir: string,
  kindName: string,
  kubeconfig: string,
  clusterName: string,
  keyless: boolean,
): Promise<void> {
  const mode = keyless ? "keyless" : "secret";
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

  // Phase 1: install Crossplane + provider-aws on the management cluster first —
  // mirrors the GCP deployToGke handoff (Crossplane before ArgoCD) and de-risks the
  // provider by bringing it up imperatively before ArgoCD reconciles node-iam /
  // cluster-api against it. In keyless mode infra/providers renders the `type: none`
  // ProviderConfig (instance-profile auth, no keys on mgmt); in secret mode it
  // renders `type: secret` and the caller baked aws-creds on mgmt first.
  log(`   Phase 1: installing Crossplane + provider-aws (${mode}) on mgmt...`);
  await applyRepoModule(gitopsDir, "infra/crossplane", clusterName, { kubeconfig, ageKeyFile });
  await applyRepoModule(gitopsDir, "infra/providers", clusterName, { kubeconfig, ageKeyFile });
  log("   Waiting for Crossplane providers to be healthy...");
  await waitForProviders(300, kubeconfig);
  // Re-apply providers: the ProviderConfig's CRD (providerconfigs.aws.upbound.io)
  // only registers once the provider is Healthy, so the first apply skipped the
  // ProviderConfig. Land it now (mirrors the Kind-stage double-apply).
  await applyRepoModule(gitopsDir, "infra/providers", clusterName, { kubeconfig, ageKeyFile });

  // REAL auth probe — fail fast, locally. waitForProviders only checks the provider
  // PACKAGE's Healthy condition (it makes no AWS API call), so a genuine auth failure
  // (in keyless mode: IMDS unreachable, wrong hop limit, missing role perms) passes
  // it green and would otherwise surface much later as an opaque ArgoCD sync error.
  // Instead: apply node IAM on mgmt and wait for the managed resources to be Ready.
  // The role + instance profile already exist (created on Kind), so the mgmt provider
  // only has to OBSERVE/adopt them — which REQUIRES a working credential chain (in
  // keyless mode: IMDS hop 2 + the controller inline policy). If auth is broken they
  // never reach Ready and this throws here.
  log(`   Verifying mgmt AWS auth (${mode}) by applying node IAM on mgmt...`);
  await applyRepoModule(gitopsDir, "infra/node-iam", clusterName, { kubeconfig, ageKeyFile });
  await waitForManagedReady(NODE_IAM_KINDS, 300, kubeconfig);

  // Phase 1.5: PIVOT — clusterctl move Kind → mgmt. MUST run BEFORE ArgoCD so the
  // management cluster's own k0smotron ADOPTS the moved control plane (the Machine
  // graph + the cluster CA) instead of bootstrapping a duplicate CP node with a fresh
  // CA (the split-brain). pivotToMgmt installs the move-target providers (cert-manager
  // + cluster-api-operator) on mgmt first; it creates NO Cluster/K0sControlPlane CRs
  // and starts NO ArgoCD until the move has landed and been verified.
  await pivotToMgmt(gitopsDir, kindName, kubeconfig, clusterName, ageKeyFile);

  // Phase 2: install ArgoCD + the root app-of-apps. ArgoCD then reconciles the full
  // platform (infra/*) and apps/* onto the management cluster from git — including
  // cert-manager, the CAPA operator, node IAM, and infra/cluster-api, which now
  // server-side-applies onto the MOVED Cluster/K0sControlPlane (same names) → adopts,
  // no duplicate CP.
  log("   Phase 2: installing ArgoCD (with Crossplane already present)...");
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

/**
 * Step 7: dispose of the Kind bootstrap cluster. The pivot (Step 6.5) already MOVED the
 * entire CAPI object graph off Kind onto the management cluster and verifyPivot confirmed
 * the adoption, so Kind now holds only the idle CAPA/k0smotron controllers with NO CRs to
 * reconcile — deleting it is safe and is the intended final step ("Kind is discarded").
 * Skipping this is exactly how a bootstrap leaves an orphan Kind cluster running forever.
 *
 * Last guard before the irreversible delete: re-confirm the management cluster OWNS the
 * moved Cluster CR. If it does not (a half-landed pivot), KEEP Kind and print the manual
 * command rather than delete the only place the CAPI graph might still live. `--keep-kind`
 * skips teardown entirely (debugging a failed/partial bootstrap).
 */
async function disposeKind(
  kindName: string,
  mgmtKubeconfig: string,
  clusterName: string,
): Promise<boolean> {
  const ownsCluster = kubectl(
    ["get", "cluster", clusterName, "-n", MGMT_NAMESPACE, "-o", "jsonpath={.metadata.name}"],
    { kubeconfig: mgmtKubeconfig, silent: true, ignoreErrors: true },
  ).trim();
  if (ownsCluster !== clusterName) {
    log(`   ⚠️  Keeping Kind: management cluster does not own Cluster/${clusterName} yet (pivot not confirmed).`);
    log(`      Verify, then delete manually: kind delete cluster --name ${kindName}`);
    return false;
  }
  log(`   🧹 Step 7: deleting the Kind bootstrap cluster (kind-${kindName})...`);
  // Best-effort: a delete hiccup must not fail an already-successful bootstrap.
  run("kind", ["delete", "cluster", "--name", kindName], { ignoreErrors: true });
  return true;
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
  const { region, clusterName, keyless, oidc } = readAwsRepoConfig(gitopsDir);

  log("");
  log("🚀 Nebula AWS Bootstrap (thin — ArgoCD reconciles the platform from git)");
  log("═".repeat(50));
  log(`   Repo (config):     ${gitopsDir}`);
  log(`   Kind (bootstrap):  ${kindName}`);
  log(`   Region:            ${region}`);
  log(`   Mgmt cluster:      ${clusterName}`);
  log(
    `   Credential mode:   ${keyless ? "KEYLESS (node instance profile / IMDS)" : "secret (static keys baked on mgmt)"}`,
  );

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

  // Step 5.5: IRSA (keyless only) — publish the cluster's OIDC discovery to S3 and
  // create the IAM OIDC provider + provider role, so the keyless Crossplane provider
  // can assume the role via WebIdentity. Must precede the handoff (its auth probe
  // exercises WebIdentity). The cluster was created with the matching OIDC issuer
  // flag (infra/cluster-api oidcIssuer). CAPA stays keyless via the instance profile.
  if (keyless) {
    if (!oidc) {
      throw new Error(
        "config.aws.keyless is true but config.oidc is missing — the keyless Crossplane " +
          "provider needs IRSA (oidc.{accountId,bucket,issuerUrl,providerRoleArn}).",
      );
    }
    await setupIrsa(mgmtKubeconfig, region, clusterName, oidc, options.awsProfile);
  }

  // Step 6: Hand off to ArgoCD. Installs Crossplane + provider-aws and ArgoCD on
  // mgmt, then ArgoCD reconciles the full platform (infra/*) and all apps (apps/*)
  // from git, including the cluster's own CAPI definition (it adopts the AWS
  // resources Kind's CAPA created). In KEYLESS mode no AWS credentials are baked on
  // mgmt — Crossplane and CAPA authenticate via the node instance profile (whose
  // controller permissions were provisioned on Kind, AwsIam controllerPolicies). In
  // secret mode the static keys must be baked on mgmt first (provider-aws/CAPA read
  // them), since config.aws.keyless=false renders the modules in secret mode.
  if (!keyless) {
    await setupAwsCredentials(region, options.awsProfile, mgmtKubeconfig);
  }
  await deployGitopsHandoff(gitopsDir, kindName, mgmtKubeconfig, clusterName, keyless);

  // Step 7: dispose of the Kind scaffold now that the pivot has handed the CAPI graph to
  // the management cluster. Default behavior (the CLI description already promises "Kind
  // is discarded"); --keep-kind opts out for debugging.
  let kindDeleted = false;
  if (options.keepKind) {
    log("   Keeping the Kind bootstrap cluster (--keep-kind).");
  } else {
    kindDeleted = await disposeKind(kindName, mgmtKubeconfig, clusterName);
  }

  log("");
  log("═".repeat(50));
  log("✨ AWS bootstrap complete!");
  log("");
  log(`   Kind (bootstrap):  ${kindDeleted ? "deleted ✅" : `kind-${kindName} (still present)`}`);
  log(`   k0s (management):  ${clusterName}  →  KUBECONFIG="${mgmtKubeconfig}"`);
  log("");
  log("   ArgoCD now reconciles the whole platform and all apps from git — including");
  log("   infra/cluster-api, so the management cluster owns its own CAPI lifecycle.");
  if (!kindDeleted) {
    log("   Kind was only the bootstrap scaffold — delete it once ArgoCD is green:");
    log(`     kind delete cluster --name ${kindName}`);
  }
  log("");
  log(`   export KUBECONFIG="${mgmtKubeconfig}"`);
  log("   kubectl get nodes");
  log("");
}

export const awsProvider: BootstrapProvider = {
  name: "aws",
  bootstrap: bootstrapAws,
};
