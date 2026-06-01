/**
 * init command - Initialize a new Nebula project
 *
 * Scaffolds the full directory structure with centralized config,
 * mandatory and optional infrastructure modules, meta modules,
 * and bootstrap files.
 */
import * as fs from "fs";
import * as path from "path";
import chalk from "chalk";
import { input, checkbox } from "@inquirer/prompts";

export interface InitOptions {
  project?: string;
  region?: string;
  domain?: string;
  acmeEmail?: string;
  gkeName?: string;
  gkeZone?: string;
  gitRepo?: string;
  addons?: string;
  outputDir?: string;
}

interface ResolvedConfig {
  project: string;
  region: string;
  domain: string;
  acmeEmail: string;
  gkeName: string;
  gkeZone: string;
  gitRepo: string;
  optionalModules: Record<string, boolean>;
}

const OPTIONAL_ADDONS = [
  { name: "cnpg", value: "cnpg", description: "CloudNativePG operator" },
  { name: "longhorn", value: "longhorn", description: "Distributed storage" },
  { name: "piraeus", value: "piraeus", description: "LINSTOR storage" },
  { name: "calico", value: "calico", description: "Network policies" },
  {
    name: "confidential-containers",
    value: "confidential-containers",
    description: "TEE support",
  },
  {
    name: "argocd-image-updater",
    value: "argocd-image-updater",
    description: "Auto image updates",
  },
  {
    name: "wireguard-mesh",
    value: "wireguard-mesh",
    description: "VPN mesh networking",
  },
  {
    name: "blackbox-exporter",
    value: "blackbox-exporter",
    description: "Endpoint probing",
  },
];

async function promptConfig(opts: InitOptions): Promise<ResolvedConfig> {
  const project =
    opts.project ||
    (await input({ message: "GCP project ID:", required: true }));

  const region =
    opts.region ||
    (await input({
      message: "GCP region:",
      default: "europe-west3",
      required: true,
    }));

  const domain =
    opts.domain ||
    (await input({
      message: "Domain (e.g. dev.example.com):",
      required: true,
    }));

  const acmeEmail =
    opts.acmeEmail ||
    (await input({
      message: "ACME email (for Let's Encrypt):",
      required: true,
    }));

  const gkeName =
    opts.gkeName ||
    (await input({ message: "GKE cluster name:", default: "mgmt" }));

  const gkeZone =
    opts.gkeZone ||
    (await input({
      message: "GKE zone:",
      default: `${region}-a`,
    }));

  const gitRepo =
    opts.gitRepo ||
    (await input({
      message: "Git repo URL (SSH):",
      required: true,
    }));

  let selectedAddons: string[];
  if (opts.addons) {
    selectedAddons = opts.addons.split(",").map((s) => s.trim());
  } else {
    selectedAddons = await checkbox({
      message: "Optional addons:",
      choices: OPTIONAL_ADDONS.map((a) => ({
        name: `${a.name} — ${a.description}`,
        value: a.value,
      })),
    });
  }

  const optionalModules: Record<string, boolean> = {};
  for (const addon of OPTIONAL_ADDONS) {
    optionalModules[addon.value] = selectedAddons.includes(addon.value);
  }

  return {
    project,
    region,
    domain,
    acmeEmail,
    gkeName,
    gkeZone,
    gitRepo,
    optionalModules,
  };
}

function writeFile(filePath: string, content: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, content);
  console.log(chalk.green(`  + ${path.relative(process.cwd(), filePath)}`));
}

// ─── File generators ────────────────────────────────────────────────────────

function generateConfig(cfg: ResolvedConfig): string {
  const modulesEntries = Object.entries(cfg.optionalModules)
    .map(([k, v]) => `    "${k}": ${v},`)
    .join("\n");

  return `/**
 * Shared configuration for all modules
 */
export const config = {
  // GCP
  project: "${cfg.project}",
  region: "${cfg.region}",

  // Domain
  domain: "${cfg.domain}",

  // ACME
  acmeEmail: "${cfg.acmeEmail}",

  // GKE
  gke: {
    name: "${cfg.gkeName}",
    zone: "${cfg.gkeZone}",
  },

  // Git
  git: {
    repoUrl: "${cfg.gitRepo}",
  },

  // Optional modules
  optionalModules: {
${modulesEntries}
  } as Record<string, boolean>,
};
`;
}

function generatePackageJson(cfg: ResolvedConfig): string {
  const name = cfg.project.replace(/[^a-z0-9-]/g, "-");
  return JSON.stringify(
    {
      name: `${name}-infra`,
      version: "1.0.0",
      private: true,
      type: "module",
      scripts: {
        synth: "cdk8s synth",
        import: "cdk8s import",
        bootstrap: "nebula bootstrap",
        apply: "nebula apply",
        destroy: "nebula destroy",
      },
      engines: { node: ">=20" },
      dependencies: {
        "cdk8s": "2.70.46",
        "cdk8s-plus-33": "2.4.23",
        constructs: "10.4.5",
        "nebula-cdk8s": "github:mateo-moon/nebula#path:/packages/nebula",
      },
      devDependencies: {
        "@nebula/cli": "github:mateo-moon/nebula#path:/packages/cli",
        "@types/node": "^22.19.8",
        "cdk8s-cli": "github:mateo-moon/cdk8s-cli#combined-fixes",
        tsx: "^4.21.0",
        typescript: "^5.9.3",
      },
    },
    null,
    2,
  );
}

function generateTsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        outDir: "./dist",
        rootDir: ".",
        noEmit: true,
        paths: {
          "nebula-cdk8s/imports/*": ["./node_modules/nebula-cdk8s/imports/*"],
          "#imports/*": ["./node_modules/nebula-cdk8s/imports/*"],
        },
      },
      include: [
        "*.ts",
        "**/index.ts",
        "**/dev.ts",
        "**/stage.ts",
        "**/prod.ts",
      ],
      exclude: ["node_modules", "dist"],
    },
    null,
    2,
  );
}

function generateGitignore(): string {
  return `node_modules/
dist/
imports/
`;
}

function generateBootstrap(cfg: ResolvedConfig): string {
  return `/**
 * Bootstrap - Local Kind cluster manifests
 *
 * Generates:
 *   - providers-local (secret-based credentials)
 *   - crossplane
 *   - infra (creates GKE)
 */
import { App, Chart } from "cdk8s";
import { GcpProvider } from "nebula-cdk8s";
import { config } from "./config";

const app = new App();
const chart = new Chart(app, "providers-local");

const crossplaneGsa = \`crossplane-provider@\${config.project}.iam.gserviceaccount.com\`;

new GcpProvider(chart, "gcp-provider", {
  projectId: config.project,
  families: ["compute", "container", "cloudplatform", "dns", "storage"],
  credentials: {
    type: "secret",
    secretRef: {
      name: "gcp-creds",
      namespace: "crossplane-system",
      key: "creds",
    },
  },
  enableDeterministicServiceAccounts: true,
  workloadIdentityServiceAccount: crossplaneGsa,
  createWorkloadIdentityBindings: true,
});

app.synth();

import "./infra/crossplane/index";
import "./infra/gke/index";
`;
}

// ─── Meta modules ───────────────────────────────────────────────────────────

function generateMetaArgocd(): string {
  return `/**
 * ArgoCd - GitOps continuous delivery
 */
import { App, Chart } from "cdk8s";
import { ArgoCd } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "argocd");

new ArgoCd(chart, "argocd", {
  nebulaPlugin: {
    enabled: true,
    gcpProject: config.project,
  },
  crossplaneUser: {
    enabled: true,
    password: "ref+sops://.secrets/secrets.yaml#argocd/crossplane_password",
    targetNamespace: "crossplane-system",
    credentialsSecretName: "argocd-crossplane-creds",
    credentialsSecretKey: "authToken",
    skipNamespaceCreation: true,
  },
  extraSecretData: {
    clientID: "ref+sops://.secrets/secrets.yaml#github/oidc/client_id",
    clientSecret: "ref+sops://.secrets/secrets.yaml#github/oidc/client_secret",
  },
  project: {
    name: "default",
    description: "Default project",
    sourceRepos: ["*"],
    destinations: [
      { server: "https://kubernetes.default.svc", namespace: "*" },
    ],
  },
  values: {
    crds: { install: true },
    extraObjects: [
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: "repo-devops",
          namespace: "argocd",
          labels: { "argocd.argoproj.io/secret-type": "repository" },
        },
        type: "Opaque",
        stringData: {
          type: "git",
          url: config.git.repoUrl,
          sshPrivateKey: "ref+sops://.secrets/secrets.yaml#github/ssh_private_key",
        },
      },
    ],
    repoServer: {
      env: [{ name: "ARGOCD_EXEC_TIMEOUT", value: "5m" }],
    },
    configs: {
      params: { server: { insecure: true } },
      rbac: {
        "policy.csv": \`g, crossplane, role:admin\`,
      },
      cm: {
        url: \`https://argocd.\${config.domain}\`,
        admin: { enabled: "false" },
        exec: { enabled: "true" },
      },
    },
    server: {
      ingress: {
        enabled: true,
        hostname: \`argocd.\${config.domain}\`,
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt-prod",
          "external-dns.alpha.kubernetes.io/hostname": \`argocd.\${config.domain}\`,
        },
        ingressClassName: "nginx",
        tls: [
          {
            secretName: "argocd-tls",
            hosts: [\`argocd.\${config.domain}\`],
          },
        ],
      },
    },
  },
});

app.synth();
`;
}

function generateMetaArgocdApps(cfg: ResolvedConfig): string {
  return `/**
 * ArgoCD Applications - top-level app-of-apps
 *
 * Defines Application objects that ArgoCD uses to self-manage:
 *   argocd        -> meta/argocd        (ArgoCD itself)
 *   argocd-apps   -> meta/argocd-apps   (this file)
 *   infra-apps    -> infra/             (all infra modules)
 *   cluster-apps  -> clusters/          (per-cluster services)
 *   workload-apps -> applications/      (developer workloads)
 */
import { App, Chart } from "cdk8s";
import { argoproj } from "nebula-cdk8s/imports";
import { config } from "../../config";

const { AppProject, Application } = argoproj;

const app = new App();
const chart = new Chart(app, "argocd-apps");

const PROJECT_NAME = "devops";
const repoUrl = config.git.repoUrl;

const managedPlugin = {
  name: "nebula-v1.0",
  env: [{ name: "ENTRY_FILE", value: "index.ts" }],
};

const metaSyncPolicy = {
  automated: { selfHeal: true, prune: false },
  retry: {
    limit: 10,
    backoff: { duration: "10s", factor: 2, maxDuration: "3m" },
  },
  syncOptions: [
    "CreateNamespace=true",
    "ServerSideApply=true",
    "SkipDryRunOnMissingResource=true",
    "RespectIgnoreDifferences=true",
    "Delete=false",
  ],
};

const appOfAppsSyncPolicy = {
  automated: { selfHeal: true, prune: true },
  retry: {
    limit: 10,
    backoff: { duration: "10s", factor: 2, maxDuration: "3m" },
  },
  syncOptions: [
    "CreateNamespace=true",
    "ServerSideApply=true",
    "SkipDryRunOnMissingResource=true",
    "RespectIgnoreDifferences=true",
  ],
};

// Project
new AppProject(chart, "devops-project", {
  metadata: { name: PROJECT_NAME, namespace: "argocd" },
  spec: {
    description: "DevOps - infrastructure and platform services",
    sourceRepos: ["*"],
    destinations: [{ namespace: "*", server: "*" }],
    clusterResourceWhitelist: [{ group: "*", kind: "*" }],
  },
});

// Meta - ArgoCD self-management
new Application(chart, "argocd-app", {
  metadata: {
    name: "argocd",
    namespace: "argocd",
    labels: { "nebula/tier": "meta", "nebula/env": "managed" },
  },
  spec: {
    project: PROJECT_NAME,
    source: {
      repoUrl,
      targetRevision: "HEAD",
      path: "meta/argocd",
      plugin: managedPlugin,
    },
    destination: { server: "https://kubernetes.default.svc" },
    syncPolicy: metaSyncPolicy,
    ignoreDifferences: [
      {
        kind: "Secret",
        name: "argocd-secret",
        jqPathExpressions: [
          ".data.clientID",
          ".data.clientSecret",
          '.data."server.secretkey"',
        ],
      },
    ],
  },
});

new Application(chart, "argocd-apps-app", {
  metadata: {
    name: "argocd-apps",
    namespace: "argocd",
    labels: { "nebula/tier": "meta", "nebula/env": "managed" },
  },
  spec: {
    project: PROJECT_NAME,
    source: {
      repoUrl,
      targetRevision: "HEAD",
      path: "meta/argocd-apps",
      plugin: managedPlugin,
    },
    destination: { server: "https://kubernetes.default.svc" },
    syncPolicy: metaSyncPolicy,
  },
});

// App-of-apps
new Application(chart, "infra-apps", {
  metadata: {
    name: "infra-apps",
    namespace: "argocd",
    labels: { "nebula/tier": "meta", "nebula/env": "managed" },
  },
  spec: {
    project: PROJECT_NAME,
    source: {
      repoUrl,
      targetRevision: "HEAD",
      path: "infra",
      plugin: managedPlugin,
    },
    destination: { server: "https://kubernetes.default.svc" },
    syncPolicy: appOfAppsSyncPolicy,
  },
});

new Application(chart, "cluster-apps", {
  metadata: {
    name: "cluster-apps",
    namespace: "argocd",
    labels: { "nebula/tier": "meta", "nebula/env": "managed" },
  },
  spec: {
    project: PROJECT_NAME,
    source: {
      repoUrl,
      targetRevision: "HEAD",
      path: "clusters",
      plugin: managedPlugin,
    },
    destination: { server: "https://kubernetes.default.svc" },
    syncPolicy: appOfAppsSyncPolicy,
  },
});

new Application(chart, "workload-apps", {
  metadata: {
    name: "workload-apps",
    namespace: "argocd",
    labels: { "nebula/tier": "meta", "nebula/env": "managed" },
  },
  spec: {
    project: PROJECT_NAME,
    source: {
      repoUrl,
      targetRevision: "HEAD",
      path: "applications",
      plugin: managedPlugin,
    },
    destination: { server: "https://kubernetes.default.svc" },
    syncPolicy: appOfAppsSyncPolicy,
  },
});

app.synth();
`;
}

// ─── Infra modules ──────────────────────────────────────────────────────────

function generateInfraIndex(cfg: ResolvedConfig): string {
  const optionalLines = Object.entries(cfg.optionalModules)
    .filter(([, enabled]) => enabled)
    .map(([name]) => `  "${name}",`)
    .join("\n");

  const optionalBlock = optionalLines
    ? `

// Optional modules (enabled in config)
const optionalApps = [
${optionalLines}
];

for (const name of optionalApps) {
  infraApp(name, {
    ignoreDifferences: [
      { group: "batch", kind: "Job", jsonPointers: ["/"] },
    ],
  });
}`
    : "";

  return `/**
 * Infrastructure Applications - management cluster services
 *
 * Defines ArgoCD Application objects for all infrastructure modules
 * deployed to the GKE management cluster.
 */
import { App, Chart } from "cdk8s";
import { argoproj } from "nebula-cdk8s/imports";
import { config } from "../config";

const { Application } = argoproj;

const app = new App();
const chart = new Chart(app, "infra-apps");

const PROJECT_NAME = "devops";
const repoUrl = config.git.repoUrl;

const managedPlugin = {
  name: "nebula-v1.0",
  env: [{ name: "ENTRY_FILE", value: "index.ts" }],
};

const criticalSyncPolicy = {
  automated: { selfHeal: true, prune: false },
  retry: {
    limit: 10,
    backoff: { duration: "10s", factor: 2, maxDuration: "3m" },
  },
  syncOptions: [
    "CreateNamespace=true",
    "ServerSideApply=true",
    "SkipDryRunOnMissingResource=true",
    "RespectIgnoreDifferences=true",
    "Delete=false",
  ],
};

const platformSyncPolicy = {
  automated: { selfHeal: true, prune: false },
  retry: {
    limit: 5,
    backoff: { duration: "10s", factor: 2, maxDuration: "3m" },
  },
  syncOptions: [
    "CreateNamespace=true",
    "ServerSideApply=true",
    "SkipDryRunOnMissingResource=true",
    "RespectIgnoreDifferences=true",
    "Delete=false",
  ],
};

const mgmtCluster = { server: "https://kubernetes.default.svc" };

function infraApp(
  name: string,
  opts?: {
    syncPolicy?: typeof criticalSyncPolicy;
    ignoreDifferences?: Array<{
      group?: string;
      kind?: string;
      jqPathExpressions?: string[];
      jsonPointers?: string[];
    }>;
    destination?: { server?: string } | { name?: string };
  },
) {
  const spec: Record<string, unknown> = {
    project: PROJECT_NAME,
    source: {
      repoUrl,
      targetRevision: "HEAD",
      path: \`infra/\${name}\`,
      plugin: managedPlugin,
    },
    destination: opts?.destination ?? mgmtCluster,
    syncPolicy: opts?.syncPolicy ?? platformSyncPolicy,
  };
  if (opts?.ignoreDifferences) {
    spec.ignoreDifferences = opts.ignoreDifferences;
  }
  new Application(chart, \`\${name}-app\`, {
    metadata: {
      name,
      namespace: "argocd",
      labels: { "nebula/tier": "infra", "nebula/env": "managed" },
    },
    spec: spec as any,
  });
}

// Bootstrap infrastructure (critical)
infraApp("providers", { syncPolicy: criticalSyncPolicy });
infraApp("crossplane", { syncPolicy: criticalSyncPolicy });
infraApp("gke", { syncPolicy: criticalSyncPolicy });

// Mandatory platform services
const managedApps = [
  "cert-manager",
  "cluster-api",
  "descheduler",
  "dns",
  "external-dns",
  "karmada",
  "monitoring",
];

for (const name of managedApps) {
  infraApp(name, {
    ignoreDifferences: [
      { group: "batch", kind: "Job", jsonPointers: ["/"] },
    ],
  });
}${optionalBlock}

app.synth();
`;
}

function generateInfraProviders(): string {
  return `/**
 * Crossplane Providers - GKE cluster with Workload Identity
 */
import { App, Chart } from "cdk8s";
import { GcpProvider } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "providers");

new GcpProvider(chart, "gcp-provider", {
  projectId: config.project,
  families: ["compute", "container", "cloudplatform", "dns", "storage"],
  credentials: {
    type: "injectedIdentity",
  },
  enableDeterministicServiceAccounts: true,
  workloadIdentityServiceAccount: \`crossplane-provider@\${config.project}.iam.gserviceaccount.com\`,
});

app.synth();
`;
}

function generateInfraCrossplane(): string {
  return `/**
 * Crossplane - Universal control plane
 */
import { App, Chart } from "cdk8s";
import { Crossplane } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "crossplane");

new Crossplane(chart, "crossplane", {
  argoCdProvider: {},
});

app.synth();
`;
}

function generateInfraGke(cfg: ResolvedConfig): string {
  return `/**
 * GCP Infrastructure - Network, GKE, IAM
 */
import { App, Chart } from "cdk8s";
import { Gcp, NetworkSpecDeletionPolicy } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "infra");

new Gcp(chart, "gcp", {
  project: config.project,
  region: config.region,
  providerConfigRef: "default",
  deletionPolicy: NetworkSpecDeletionPolicy.ORPHAN,

  network: {
    cidr: "10.10.0.0/16",
    podsSecondaryCidr: "10.20.0.0/16",
    podsRangeName: "pods",
    servicesSecondaryCidr: "10.30.0.0/16",
    servicesRangeName: "services",
  },

  gke: {
    name: config.gke.name,
    location: config.gke.zone,
    releaseChannel: "REGULAR",
    deletionProtection: true,
    createSystemNodePool: true,
    systemNodePoolConfig: {
      imageType: "UBUNTU_CONTAINERD",
      machineType: "n2-standard-4",
      diskSizeGb: 50,
      minNodes: 2,
      maxNodes: 4,
      spot: true,
    },
  },

  iam: {
    externalDns: {
      enabled: true,
      namespace: "external-dns",
      ksaName: "external-dns",
      roles: ["roles/dns.admin"],
    },
    certManager: {
      enabled: true,
      namespace: "cert-manager",
      ksaName: "cert-manager",
      roles: ["roles/dns.admin"],
    },
  },
});

app.synth();
`;
}

function generateInfraCertManager(): string {
  return `/**
 * CertManager - TLS certificate management
 */
import { App, Chart } from "cdk8s";
import { CertManager } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "cert-manager");

new CertManager(chart, "cert-manager", {
  acmeEmail: config.acmeEmail,
});

app.synth();
`;
}

function generateInfraClusterApi(): string {
  return `/**
 * ClusterApiOperator - Cluster lifecycle management
 */
import { App, Chart } from "cdk8s";
import { ClusterApiOperator } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "cluster-api");

new ClusterApiOperator(chart, "capi", {
  gcp: {
    projectId: config.project,
  },
});

app.synth();
`;
}

function generateInfraDns(): string {
  return `/**
 * DNS - Cloud DNS zones
 */
import { App, Chart } from "cdk8s";
import { Dns, ManagedZoneSpecDeletionPolicy } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "dns");

new Dns(chart, "dns", {
  project: config.project,
  providerConfigRef: "default",
  deletionPolicy: ManagedZoneSpecDeletionPolicy.ORPHAN,
  zones: [
    {
      name: config.domain.split(".")[0],
      dnsName: config.domain,
      description: \`DNS zone for \${config.domain}\`,
      delegation: {
        provider: "manual",
      },
    },
  ],
});

app.synth();
`;
}

function generateInfraExternalDns(): string {
  return `/**
 * ExternalDns - DNS record management
 */
import { App, Chart } from "cdk8s";
import { ExternalDns } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "external-dns");

new ExternalDns(chart, "external-dns", {
  project: config.project,
  domainFilters: [config.domain],
  policy: "sync",
  txtOwnerId: config.domain.replace(/\\./g, "-"),
  logLevel: "info",
  providerConfigRef: "default",
});

app.synth();
`;
}

function generateInfraDescheduler(): string {
  return `/**
 * Descheduler - Pod rebalancing across nodes
 */
import { App, Chart } from "cdk8s";
import { Descheduler } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "descheduler");

new Descheduler(chart, "descheduler", {
  excludeNamespaces: ["kube-system", "karmada-system"],
});

app.synth();
`;
}

function generateInfraMonitoring(): string {
  return `/**
 * Monitoring - Prometheus, Grafana, Loki, Promtail
 */
import { App, Chart } from "cdk8s";
import { PrometheusOperator } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "monitoring");

new PrometheusOperator(chart, "monitoring", {
  storageClassName: "standard",
  grafanaAdminPassword: "ref+sops://.secrets/secrets.yaml#monitoring/grafana_password",
  loki: { enabled: true },
  promtail: { enabled: true },
  values: {
    crds: { enabled: false },
    grafana: {
      ingress: {
        enabled: true,
        ingressClassName: "nginx",
        hosts: [\`grafana.\${config.domain}\`],
        tls: [
          {
            secretName: "grafana-tls",
            hosts: [\`grafana.\${config.domain}\`],
          },
        ],
        annotations: {
          "cert-manager.io/cluster-issuer": "letsencrypt-prod",
          "external-dns.alpha.kubernetes.io/hostname": \`grafana.\${config.domain}\`,
        },
      },
    },
  },
});

app.synth();
`;
}

function generateInfraKarmada(): string {
  return `/**
 * Karmada - Multi-cluster orchestration
 */
import { App, Chart } from "cdk8s";
import { Karmada } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "karmada");

new Karmada(chart, "karmada", {
  registerWithArgoCD: true,
  argoCdNamespace: "argocd",
  values: {
    operator: {
      replicaCount: 1,
    },
  },
});

app.synth();
`;
}

// ─── Optional module generators ─────────────────────────────────────────────

function generateOptionalModule(name: string, cfg: ResolvedConfig): string | null {
  switch (name) {
    case "cnpg":
      return `/**
 * CNPG - CloudNativePG operator
 */
import { App, Chart } from "cdk8s";
import { CloudNativePg } from "nebula-cdk8s";
import { config } from "../../config";

const app = new App();
const chart = new Chart(app, "cnpg");

new CloudNativePg(chart, "cnpg", {
  mode: "backup-infra",
  gcpProjectId: config.project,
  bucketName: \`\${config.project}-cnpg-backups\`,
});

app.synth();
`;
    case "longhorn":
      return `/**
 * Longhorn - Distributed storage
 */
import { App, Chart } from "cdk8s";
import { Longhorn } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "longhorn");

new Longhorn(chart, "longhorn", {});

app.synth();
`;
    case "piraeus":
      return `/**
 * Piraeus - LINSTOR storage
 */
import { App, Chart } from "cdk8s";
import { Piraeus } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "piraeus");

new Piraeus(chart, "piraeus", {});

app.synth();
`;
    case "calico":
      return `/**
 * Calico - Network policies
 */
import { App, Chart } from "cdk8s";
import { Calico } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "calico");

new Calico(chart, "calico", {});

app.synth();
`;
    case "confidential-containers":
      return `/**
 * Confidential Containers - TEE support
 */
import { App, Chart } from "cdk8s";
import { ConfidentialContainers } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "confidential-containers");

new ConfidentialContainers(chart, "cc", {});

app.synth();
`;
    case "argocd-image-updater":
      return `/**
 * ArgoCD Image Updater - Automatic image updates
 */
import { App, Chart } from "cdk8s";
import { ArgocdImageUpdater } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "argocd-image-updater");

new ArgocdImageUpdater(chart, "image-updater", {});

app.synth();
`;
    case "wireguard-mesh":
      return `/**
 * WireGuard Mesh - VPN mesh networking
 */
import { App, Chart } from "cdk8s";
import { WireGuardMesh } from "nebula-cdk8s";

const app = new App();
const chart = new Chart(app, "wireguard-mesh");

new WireGuardMesh(chart, "wireguard", {
  peers: [],
});

app.synth();
`;
    case "blackbox-exporter":
      return `/**
 * Blackbox Exporter - Endpoint probing
 */
import { App, Chart } from "cdk8s";
import { Helm } from "cdk8s";

const app = new App();
const chart = new Chart(app, "blackbox-exporter");

new Helm(chart, "blackbox-exporter", {
  chart: "prometheus-blackbox-exporter",
  repo: "https://prometheus-community.github.io/helm-charts",
  namespace: "monitoring",
  values: {},
});

app.synth();
`;
    default:
      return null;
  }
}

// ─── Placeholder modules ────────────────────────────────────────────────────

function generateClustersIndex(): string {
  return `/**
 * Cluster Applications - per-cluster services
 *
 * Add cluster-specific ArgoCD Applications here.
 * Each cluster gets its own subdirectory (e.g., clusters/dev/).
 */
import { App, Chart } from "cdk8s";

const app = new App();
const chart = new Chart(app, "cluster-apps");

// Example: add cluster apps here
// import { argoproj } from "nebula-cdk8s/imports";
// const { Application } = argoproj;

app.synth();
`;
}

function generateApplicationsIndex(): string {
  return `/**
 * Workload Applications - developer applications
 *
 * Add workload ArgoCD Applications here.
 * Each application gets its own subdirectory (e.g., applications/dev/my-app/).
 */
import { App, Chart } from "cdk8s";

const app = new App();
const chart = new Chart(app, "workload-apps");

// Example: add workload apps here
// import { argoproj } from "nebula-cdk8s/imports";
// const { Application } = argoproj;

app.synth();
`;
}

// ─── Main init function ─────────────────────────────────────────────────────

export async function init(options: InitOptions): Promise<void> {
  const outputDir = options.outputDir ?? process.cwd();

  console.log(chalk.blue("\nNebula Init - Project Scaffolding\n"));

  // Check if already initialized
  if (fs.existsSync(path.join(outputDir, "config.ts"))) {
    throw new Error(
      "config.ts already exists in this directory. Remove it to re-initialize.",
    );
  }

  // Gather config via prompts or flags
  const cfg = await promptConfig(options);

  console.log(chalk.blue("\nScaffolding project...\n"));

  // Root files
  writeFile(path.join(outputDir, "config.ts"), generateConfig(cfg));
  writeFile(path.join(outputDir, "bootstrap.ts"), generateBootstrap(cfg));
  writeFile(path.join(outputDir, "package.json"), generatePackageJson(cfg));
  writeFile(path.join(outputDir, "tsconfig.json"), generateTsconfig());
  writeFile(path.join(outputDir, ".gitignore"), generateGitignore());

  // Meta modules
  writeFile(
    path.join(outputDir, "meta/argocd/index.ts"),
    generateMetaArgocd(),
  );
  writeFile(
    path.join(outputDir, "meta/argocd-apps/index.ts"),
    generateMetaArgocdApps(cfg),
  );

  // Infra index (ArgoCD Applications)
  writeFile(
    path.join(outputDir, "infra/index.ts"),
    generateInfraIndex(cfg),
  );

  // Mandatory infra modules
  writeFile(
    path.join(outputDir, "infra/providers/index.ts"),
    generateInfraProviders(),
  );
  writeFile(
    path.join(outputDir, "infra/crossplane/index.ts"),
    generateInfraCrossplane(),
  );
  writeFile(
    path.join(outputDir, "infra/gke/index.ts"),
    generateInfraGke(cfg),
  );
  writeFile(
    path.join(outputDir, "infra/cert-manager/index.ts"),
    generateInfraCertManager(),
  );
  writeFile(
    path.join(outputDir, "infra/cluster-api/index.ts"),
    generateInfraClusterApi(),
  );
  writeFile(
    path.join(outputDir, "infra/dns/index.ts"),
    generateInfraDns(),
  );
  writeFile(
    path.join(outputDir, "infra/external-dns/index.ts"),
    generateInfraExternalDns(),
  );
  writeFile(
    path.join(outputDir, "infra/descheduler/index.ts"),
    generateInfraDescheduler(),
  );
  writeFile(
    path.join(outputDir, "infra/monitoring/index.ts"),
    generateInfraMonitoring(),
  );
  writeFile(
    path.join(outputDir, "infra/karmada/index.ts"),
    generateInfraKarmada(),
  );

  // Optional modules
  for (const [name, enabled] of Object.entries(cfg.optionalModules)) {
    if (!enabled) continue;
    const content = generateOptionalModule(name, cfg);
    if (content) {
      writeFile(path.join(outputDir, `infra/${name}/index.ts`), content);
    }
  }

  // Placeholder directories
  writeFile(
    path.join(outputDir, "clusters/index.ts"),
    generateClustersIndex(),
  );
  writeFile(
    path.join(outputDir, "applications/index.ts"),
    generateApplicationsIndex(),
  );

  // Summary
  const enabledAddons = Object.entries(cfg.optionalModules)
    .filter(([, v]) => v)
    .map(([k]) => k);

  console.log(
    chalk.green(`
Nebula project initialized!
`),
  );

  console.log(`${chalk.bold("Configuration:")}
  Project:  ${cfg.project}
  Region:   ${cfg.region}
  Domain:   ${cfg.domain}
  GKE:      ${cfg.gkeName} (${cfg.gkeZone})
  Git:      ${cfg.gitRepo}
  Addons:   ${enabledAddons.length > 0 ? enabledAddons.join(", ") : "none"}
`);

  console.log(`${chalk.bold("Next steps:")}
  1. ${chalk.cyan("pnpm install")}
  2. ${chalk.cyan("nebula init-sops --gcp-project " + cfg.project)}
  3. Edit ${chalk.cyan(".secrets/secrets.yaml")} with your secrets
  4. ${chalk.cyan("nebula bootstrap --project " + cfg.project)}
`);
}
