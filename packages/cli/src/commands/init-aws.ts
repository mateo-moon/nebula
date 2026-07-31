/**
 * `nebula init --provider aws` — scaffold the `aws/` GitOps subtree.
 *
 * Generates the single-source-of-truth repo the thin AWS bootstrap and ArgoCD
 * both consume, in the RECURSIVE-OWNERSHIP layout: every directory level is
 * owned by exactly one index.ts, and discovery never descends past a directory
 * that has its own owner.
 *
 *   config.ts                      shared configuration (the single source)
 *   meta/argocd                    ArgoCD itself
 *   meta/argocd-apps               the root tier: argocd, argocd-apps, clusters-apps
 *   clusters/index.ts              ONE-level walker: each clusters/<name>/ dir
 *                                  becomes an app-of-apps `<name>-apps`
 *   clusters/mgmt/index.ts         the management cluster: a dependency-ordered
 *                                  REGISTRY tier over its module directories
 *   clusters/mgmt/<module>/        the platform fundamentals (6 modules)
 *
 * Adding a workload cluster = adding a `clusters/<name>/` directory with its
 * own index.ts — no registry edits anywhere else. Mirrors the proven layout in
 * DevOps/aws.
 */
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import type { InitOptions } from "./init";

// ── Packaging pins (single source so package.json and pnpm-workspace agree) ──────
// nebula-cdk8s + @nebula/cli come from this branch.
const NEBULA_BRANCH = "main";
// The cdk8s-cli fork commit. MUST match the allowBuilds tarball URL below, or
// pnpm 11 silently skips its build and `cdk8s synth` fails.
const CDK8S_CLI_COMMIT = "ef8da23a33eecab4fe7cfcbcee911c374e20ca6f";
// Multi-arch nebula-cmp image (the ArgoCD ConfigManagementPlugin); → :latest after merge.
const CMP_IMAGE = "ghcr.io/mateo-moon/nebula-cmp:b690209";

interface AwsCfg {
  region: string;
  clusterName: string;
  instanceType: string;
  amiId: string;
  cpReplicas: number;
  repoUrl: string;
  targetRevision: string;
  pathPrefix: string;
  knownHosts: string;
  argoProject: string;
  acmeEmail: string;
  cmpImage: string;
}

function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content);
  console.log(chalk.green(`  + ${path.relative(process.cwd(), filePath)}`));
}

export async function initAws(
  options: InitOptions,
  outputDir: string,
): Promise<void> {
  const c: AwsCfg = {
    region: options.region || "eu-central-1",
    clusterName: options.clusterName || "mgmt",
    instanceType: options.instanceType || "t4g.large",
    amiId: options.amiId || "",
    cpReplicas: options.cpReplicas ?? 3,
    repoUrl:
      options.gitRepo ||
      "ssh://git@gitea.example.com:2222/your-org/your-repo.git",
    targetRevision: options.targetRevision || "main",
    pathPrefix: options.pathPrefix || "aws",
    knownHosts: options.sshKnownHosts || "",
    argoProject: options.argoProject || "nebula-aws",
    acmeEmail: options.acmeEmail || "bootstrap@nebula.local",
    cmpImage: options.cmpImage || CMP_IMAGE,
  };

  console.log(chalk.blue("\nScaffolding the AWS GitOps tree...\n"));

  // Root
  writeFile(path.join(outputDir, "config.ts"), genConfig(c));
  writeFile(path.join(outputDir, "package.json"), genPackageJson(c));
  writeFile(path.join(outputDir, "pnpm-workspace.yaml"), genPnpmWorkspace());
  writeFile(path.join(outputDir, "tsconfig.json"), genTsconfig());
  writeFile(path.join(outputDir, ".gitignore"), genGitignore());
  writeFile(path.join(outputDir, ".sops.yaml"), genSops());
  writeFile(path.join(outputDir, ".secrets/secrets.yaml"), genSecretsTemplate());

  // Meta
  writeFile(path.join(outputDir, "meta/argocd/index.ts"), genMetaArgocd());
  writeFile(
    path.join(outputDir, "meta/argocd-apps/index.ts"),
    genMetaArgocdApps(),
  );

  // Clusters: the walker + the management cluster's registry + its modules
  writeFile(path.join(outputDir, "clusters/index.ts"), genClustersIndex());
  writeFile(path.join(outputDir, "clusters/mgmt/index.ts"), genMgmtIndex());
  writeFile(
    path.join(outputDir, "clusters/mgmt/crossplane/index.ts"),
    genMgmtCrossplane(),
  );
  writeFile(
    path.join(outputDir, "clusters/mgmt/cert-manager/index.ts"),
    genMgmtCertManager(),
  );
  writeFile(
    path.join(outputDir, "clusters/mgmt/providers/index.ts"),
    genMgmtProviders(),
  );
  writeFile(
    path.join(outputDir, "clusters/mgmt/cluster-api-operator/index.ts"),
    genMgmtClusterApiOperator(),
  );
  writeFile(
    path.join(outputDir, "clusters/mgmt/node-iam/index.ts"),
    genMgmtNodeIam(),
  );
  writeFile(
    path.join(outputDir, "clusters/mgmt/cluster-api/index.ts"),
    genMgmtClusterApi(),
  );

  console.log(
    chalk.green(`
AWS GitOps tree scaffolded.
`),
  );
  console.log("Next steps:");
  console.log(
    "  1. Edit config.ts — set aws.amiId (Ubuntu 22.04 in your region) and git.knownHosts",
  );
  console.log(`        (ssh-keyscan -p 2222 your-gitea-host).`);
  console.log("  2. Put your gitea deploy key in .secrets/secrets.yaml and encrypt:");
  console.log("        sops -e -i .secrets/secrets.yaml   (needs SOPS_AGE_KEY_FILE / a .sops.yaml recipient)");
  console.log("  3. Commit + push, then from this dir:  nebula bootstrap --provider aws --aws-profile <p>");
  console.log("");
}

// ── Generators ───────────────────────────────────────────────────────────────

function genConfig(c: AwsCfg): string {
  return `/**
 * Shared configuration for the AWS GitOps tree — the SINGLE SOURCE OF TRUTH.
 *
 * Both the thin bootstrap and ArgoCD read this: ArgoCD runs on the management
 * cluster and uses the nebula-cmp ConfigManagementPlugin to \`cdk8s synth\` the
 * TypeScript modules under this subtree straight out of the git repo.
 */
export const config = {
  /** Git repo ArgoCD pulls from (the nebula-cmp plugin synths paths under \`${c.pathPrefix}/\`). */
  git: {
    repoUrl: ${JSON.stringify(c.repoUrl)},
    targetRevision: ${JSON.stringify(c.targetRevision)},
    /** Path prefix of this subtree inside the repo. */
    pathPrefix: ${JSON.stringify(c.pathPrefix)},
    /**
     * The git server's SSH host key (ssh-keyscan -p 2222 <host>). ArgoCD's
     * repo-server verifies it before cloning; without it the clone fails with
     * "knownhosts: key is unknown". Appended to ArgoCD's known_hosts defaults.
     */
    knownHosts: ${JSON.stringify(c.knownHosts)},
    /**
     * manifest-generate-paths shared by every Application: a commit only
     * re-renders apps whose watched paths changed. Modules read only their own
     * directory, these files and .secrets — any other out-of-dir read needs an
     * extraGeneratePaths entry on its tier.
     */
    sharedGeneratePaths: [
      "/${c.pathPrefix}/config.ts",
      "/${c.pathPrefix}/package.json",
      "/${c.pathPrefix}/pnpm-lock.yaml",
      "/${c.pathPrefix}/pnpm-workspace.yaml",
      "/${c.pathPrefix}/tsconfig.json",
      "/${c.pathPrefix}/.secrets",
    ] as string[],
  },

  /** AWS management cluster. */
  aws: {
    region: ${JSON.stringify(c.region)},
    /** Cluster name — drives CAPI cluster name, AWS resource tags, node IAM names. */
    clusterName: ${JSON.stringify(c.clusterName)},
    /** arm64 Graviton control plane; pair with an arm64 AMI. */
    instanceType: ${JSON.stringify(c.instanceType)},
    /** Ubuntu 22.04 AMI in \`region\` (rotates — keep current). REQUIRED. */
    amiId: ${JSON.stringify(c.amiId)},
    /** HA control-plane node count (odd; 3 = HA). */
    cpReplicas: ${c.cpReplicas},
  },

  /** ArgoCD project that owns every Application in this tree. */
  argoProject: ${JSON.stringify(c.argoProject)},

  /** ACME contact for cert-manager (no public issuers wired yet — placeholder). */
  acmeEmail: ${JSON.stringify(c.acmeEmail)},

  /** The nebula-cmp ConfigManagementPlugin image ArgoCD's repo-server runs. */
  cmpImage: ${JSON.stringify(c.cmpImage)},
} as const;
`;
}

function genPackageJson(c: AwsCfg): string {
  const pkg = {
    name: c.argoProject,
    version: "1.0.0",
    private: true,
    type: "module",
    dependencies: {
      cdk8s: "2.70.46",
      "cdk8s-plus-33": "2.4.23",
      constructs: "10.4.5",
      "nebula-cdk8s": `github:mateo-moon/nebula#${NEBULA_BRANCH}&path:/packages/nebula`,
    },
    devDependencies: {
      "cdk8s-cli": `github:mateo-moon/cdk8s-cli#${CDK8S_CLI_COMMIT}`,
      tsx: "^4.21.0",
      typescript: "^5.9.3",
    },
  };
  return JSON.stringify(pkg, null, 2) + "\n";
}

function genPnpmWorkspace(): string {
  return `# pnpm 11 blocks build scripts unless allowlisted. The nebula-cmp sidecar needs:
#  - cdk8s-cli (git-hosted fork) to run its prepare/build — git deps require the
#    FULL resolved tarball URL in allowBuilds (bare name is ignored), so cdk8s-cli
#    is pinned to a fixed commit to keep this URL stable.
#  - esbuild (pulled in by tsx) to build its native binary.
onlyBuiltDependencies:
  - cdk8s-cli
  - esbuild
allowBuilds:
  esbuild: true
  cdk8s-cli@https://codeload.github.com/mateo-moon/cdk8s-cli/tar.gz/${CDK8S_CLI_COMMIT}: true
`;
}

function genTsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "#imports/*": ["node_modules/nebula-cdk8s/imports/*"]
    }
  },
  "include": ["**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
`;
}

function genGitignore(): string {
  return `node_modules/
dist/
.nebula-synth/
.nebula-readconfig.ts
.pnpm-store/
*.log
# never commit private key material
.secrets/*.key
.secrets/age-key.txt
keys.txt
*.agekey
`;
}

function genSops(): string {
  return `# Encrypt everything under .secrets/ with age. Replace <AGE_RECIPIENT> with your
# public key (age-keygen) so 'sops -e -i .secrets/secrets.yaml' targets it.
creation_rules:
  - path_regex: \\.secrets/.*
    age: <AGE_RECIPIENT>
`;
}

function genSecretsTemplate(): string {
  return `# PLAINTEXT TEMPLATE — encrypt before committing:  sops -e -i .secrets/secrets.yaml
# (requires a .sops.yaml age recipient and SOPS_AGE_KEY_FILE for decryption).
gitea:
  deploy_key:
    # A read-only deploy key for this repo. ArgoCD's repo-server clones with it.
    ssh_private_key: |
      -----BEGIN OPENSSH PRIVATE KEY-----
      REPLACE_WITH_YOUR_DEPLOY_KEY
      -----END OPENSSH PRIVATE KEY-----
`;
}

function genMetaArgocd(): string {
  return `/**
 * meta/argocd — ArgoCD on the management cluster (the GitOps engine).
 *
 * Installs ArgoCD with the nebula-cmp ConfigManagementPlugin (so ArgoCD can
 * \`cdk8s synth\` the in-repo TypeScript) and registers the git repo it pulls from.
 * SOPS secrets are decrypted with age (vendor-neutral) via the sopsAge plugin
 * branch: the nebula-sops-age Secret (created by the bootstrap) is mounted into
 * the repo-server sidecar.
 */
import { App, Chart } from "cdk8s";
import { ArgoCd } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "argocd");

new ArgoCd(chart, "argocd", {
  // Teach ArgoCD's repo-server the git server's SSH host key so it can clone.
  sshKnownHosts: config.git.knownHosts,
  nebulaPlugin: {
    enabled: true,
    image: config.cmpImage,
    // Vendor-neutral SOPS decryption: mount the age key Secret into the sidecar.
    sopsAge: { secretName: "nebula-sops-age" },
    resources: {
      requests: { memory: "2Gi", cpu: "500m" },
      limits: { memory: "4Gi", cpu: "2" },
    },
  },
  project: {
    name: config.argoProject,
    description: "AWS — infrastructure and platform",
    sourceRepos: ["*"],
    destinations: [{ server: "https://kubernetes.default.svc", namespace: "*" }],
    clusterResourceWhitelist: [{ group: "*", kind: "*" }],
  },
  values: {
    crds: { install: true },
    extraObjects: [
      // The git repo ArgoCD clones (referenced by every Application's source).
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: "repo-gitops",
          namespace: "argocd",
          labels: { "argocd.argoproj.io/secret-type": "repository" },
        },
        type: "Opaque",
        stringData: {
          type: "git",
          url: config.git.repoUrl,
          // ref+sops paths are anchored to the git repo ROOT, so include the
          // pathPrefix to reach this subtree's age-encrypted secrets.
          sshPrivateKey:
            \`ref+sops://\${config.git.pathPrefix}/.secrets/secrets.yaml#gitea/deploy_key/ssh_private_key\`,
        },
      },
    ],
    configs: {
      // Minimal handoff: run the API server insecure (in-cluster); no OIDC/dex yet.
      params: { server: { insecure: true } },
    },
  },
});

app.synth();
`;
}

function genMetaArgocdApps(): string {
  return `/**
 * meta/argocd-apps — the app-of-apps that drives the GitOps handoff.
 *
 * The bootstrap applies this once and syncs the \`argocd-apps\` Application;
 * ArgoCD then self-heals everything from git. Each Application uses the
 * \`nebula-v1.0\` ConfigManagementPlugin, which runs \`cdk8s synth\` on the
 * in-repo TypeScript at its \`path\`.
 *
 * Rendered via the nebula ArgoCdAppTier factory. Three roots, recursive
 * ownership below them: \`clusters-apps\` renders clusters/index.ts, which owns
 * one app-of-apps per cluster directory, and each cluster's own index.ts owns
 * its Applications. Sync-policy presets:
 *  - \`meta\`    (no prune + Delete=false) — ArgoCD self-management: never
 *               prune/delete the platform out from under itself.
 *  - \`service\` + { prune: false }        — the clusters walker: a mistaken
 *               directory rename/removal must never cascade-delete a cluster.
 */
import { App, Chart } from "cdk8s";
import { ArgoCdAppTier } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "argocd-apps");

new ArgoCdAppTier(chart, "tier", {
  repoUrl: config.git.repoUrl,
  targetRevision: config.git.targetRevision,
  pathPrefix: config.git.pathPrefix,
  sharedGeneratePaths: config.git.sharedGeneratePaths,
  project: config.argoProject,
  createProject: {
    description: "AWS — infrastructure and platform services",
  },
  syncPolicyPreset: "meta",
  discovery: {
    mode: "registry",
    modules: [
      // ArgoCD self-management + the app-of-apps self-reference.
      { mod: "argocd", path: "meta/argocd" },
      { mod: "argocd-apps", path: "meta/argocd-apps" },
      // clusters/*: ONE app-of-apps per cluster via the cluster-dirs walker
      // (each cluster's own index.ts). See clusters/index.ts.
      {
        mod: "clusters-apps",
        path: "clusters",
        syncPolicyPreset: "service",
        syncPolicy: { prune: false },
      },
    ],
  },
});

app.synth();
`;
}

function genClustersIndex(): string {
  return `/**
 * clusters/index.ts — ONE-level walker over the clusters tree: every
 * \`clusters/<name>/\` is a cluster owning its own Applications through its own
 * index.ts, and this tier emits exactly one app-of-apps \`<name>-apps\` per
 * cluster, rendered from that directory. The recursion rule: discovery never
 * descends past a directory that has its own owner — what a cluster contains
 * (a dependency-ordered registry for mgmt, a service walk for workload
 * clusters) is that cluster's business. Synced by \`clusters-apps\` in
 * meta/argocd-apps. Adding a cluster = adding a directory; no registry edits.
 */
import { App, Chart } from "cdk8s";
import { ArgoCdAppTier } from "nebula-cdk8s";
import { config } from "../config";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

const app = new App();
const chart = new Chart(app, "clusters");

new ArgoCdAppTier(chart, "tier", {
  repoUrl: config.git.repoUrl,
  targetRevision: config.git.targetRevision,
  pathPrefix: config.git.pathPrefix,
  sharedGeneratePaths: config.git.sharedGeneratePaths,
  project: config.argoProject,
  syncPolicyPreset: "service",
  // Cluster deletion is never an accident to automate: removing a cluster
  // directory must not cascade-prune its app tree.
  syncPolicy: { prune: false },
  discovery: { mode: "cluster-dirs", dir: here },
});

app.synth();
`;
}

function genMgmtIndex(): string {
  return `/**
 * clusters/mgmt — everything that runs ON (or is reconciled BY) the management
 * cluster, as one dependency-ordered registry tier (Applications \`mgmt-<mod>\`).
 *
 * ArgoCD retries until healthy, but since ArgoCD (not the bootstrap) installs
 * this onto a bare management cluster, explicit sync-waves make the first sync
 * deterministic: CRDs/controllers (crossplane, cert-manager) before the things
 * that need them (providers, the CAPI operator), then node-iam, then the
 * cluster itself — \`cluster-api\` is the management cluster's own CAPI
 * definition; reconciling it here is how the cluster inherits its own
 * lifecycle from git.
 *
 * Add operational apps below the fundamentals with
 * \`syncPolicyPreset: "service"\` (prune stale resources) — one line per app,
 * module directory next to the others. Emitted as the \`mgmt-apps\`
 * app-of-apps by the clusters/index.ts walker.
 */
import { App, Chart } from "cdk8s";
import { ArgoCdAppTier, type ArgoCdAppTierModule } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "mgmt");

const modules: ArgoCdAppTierModule[] = [
  // --- fundamentals (dependency-ordered, \`meta\` preset: never pruned) -------
  { mod: "crossplane", wave: -2 },
  { mod: "cert-manager", wave: -2 },
  { mod: "providers", wave: -1 },
  { mod: "cluster-api-operator", wave: -1 },
  { mod: "node-iam", wave: 0 },
  { mod: "cluster-api", wave: 1 },
  // --- operational apps (\`service\` preset: prune stale resources) -----------
  // { mod: "monitoring", syncPolicyPreset: "service" },
];

new ArgoCdAppTier(chart, "tier", {
  repoUrl: config.git.repoUrl,
  targetRevision: config.git.targetRevision,
  pathPrefix: config.git.pathPrefix,
  sharedGeneratePaths: config.git.sharedGeneratePaths,
  project: config.argoProject,
  namePrefix: "mgmt-",
  syncPolicyPreset: "meta",
  discovery: { mode: "registry", dir: "clusters/mgmt", modules },
});

app.synth();
`;
}

function genMgmtCrossplane(): string {
  return `/**
 * clusters/mgmt/crossplane — Crossplane control plane on the management cluster.
 */
import { App, Chart } from "cdk8s";
import { Crossplane } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "crossplane");

new Crossplane(chart, "crossplane", {
  namespace: "crossplane-system",
  argoCdProvider: false,
});

app.synth();
`;
}

function genMgmtCertManager(): string {
  return `/**
 * clusters/mgmt/cert-manager — cert-manager on the management cluster. Required
 * by the cluster-api-operator (its webhook serving cert is issued by
 * cert-manager).
 */
import { App, Chart } from "cdk8s";
import { CertManager } from "nebula-cdk8s";
import { config } from "../../../config";

const app = new App();
const chart = new Chart(app, "cert-manager");

new CertManager(chart, "cert-manager", {
  acmeEmail: config.acmeEmail ?? "bootstrap@nebula.local",
  createClusterIssuers: false,
});

app.synth();
`;
}

function genMgmtProviders(): string {
  return `/**
 * clusters/mgmt/providers — the Crossplane AWS provider on the management
 * cluster. Credentials come from the aws-creds Secret in crossplane-system
 * (created by the bootstrap; rotate to a long-lived IAM user key for
 * steady-state).
 */
import { App, Chart } from "cdk8s";
import { AwsProvider } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "providers");

new AwsProvider(chart, "aws-provider", {
  families: ["ec2", "iam", "route53", "kms"],
  credentials: {
    type: "secret",
    secretRef: { name: "aws-creds", namespace: "crossplane-system", key: "creds" },
  },
});

app.synth();
`;
}

function genMgmtClusterApiOperator(): string {
  return `/**
 * clusters/mgmt/cluster-api-operator — Cluster API operator (CAPA + k0smotron)
 * on the management cluster, so it runs its OWN Cluster API and adopts the AWS
 * resources the bootstrap (Kind's CAPA) created. References the
 * aws-capa-credentials Secret.
 *
 * NOTE: directory \`cluster-api-operator\` (the OPERATOR), distinct from
 * \`cluster-api\` (the K0sCluster CRs). Do not merge them.
 */
import { App, Chart } from "cdk8s";
import { ClusterApiOperator } from "nebula-cdk8s";
import { config } from "../../../config";

const app = new App();
const chart = new Chart(app, "cluster-api-operator");

new ClusterApiOperator(chart, "capi", {
  aws: {
    region: config.aws.region,
    secretName: "aws-capa-credentials",
    secretNamespace: "capa-system",
  },
});

app.synth();
`;
}

function genMgmtNodeIam(): string {
  return `/**
 * clusters/mgmt/node-iam — the CAPA node IAM (role + instance profile) the EC2
 * instances assume. CAPA requires the instance profile to pre-exist before
 * launching machines.
 */
import { App, Chart } from "cdk8s";
import { Aws } from "nebula-cdk8s";
import { config } from "../../../config";

const app = new App();
const chart = new Chart(app, "node-iam");

new Aws(chart, "aws", {
  name: config.aws.clusterName,
  region: config.aws.region,
  instanceProfileName: \`\${config.aws.clusterName}-node-profile\`,
});

app.synth();
`;
}

function genMgmtClusterApi(): string {
  return `/**
 * clusters/mgmt/cluster-api — the management cluster's own CAPI definition (the
 * cluster CRs). Reconciling this from git is what makes Kind disposable: the
 * cluster's own CAPA adopts the AWS resources the bootstrap created rather
 * than recreating them.
 */
import { App, Chart } from "cdk8s";
import { K0sCluster, AwsK0sProvider } from "nebula-cdk8s";
import { AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme } from "nebula-cdk8s";
import { config } from "../../../config";

const app = new App();
const chart = new Chart(app, "cluster-api");

// Provider-agnostic standalone k0s cluster; the AWS adapter (CAPA) supplies the
// infra CRs. This is the single, reusable way nebula defines a cluster.
new K0sCluster(chart, "mgmt", {
  name: config.aws.clusterName,
  controlPlane: {
    replicas: config.aws.cpReplicas,
    machine: {
      instanceType: config.aws.instanceType,
      ami: { id: config.aws.amiId },
    },
  },
  provider: new AwsK0sProvider({
    region: config.aws.region,
    iamInstanceProfile: \`\${config.aws.clusterName}-node-profile\`,
    // Internet-facing so the API is reachable for reconciliation; mTLS guards it.
    controlPlaneLoadBalancerScheme:
      AwsClusterV1Beta2SpecControlPlaneLoadBalancerScheme.INTERNET_HYPHEN_FACING,
  }),
});

app.synth();
`;
}
