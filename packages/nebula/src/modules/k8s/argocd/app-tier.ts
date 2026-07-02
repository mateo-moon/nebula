/**
 * ArgoCdAppTier — a factory for app-of-apps tiers.
 *
 * Renders one ArgoCD `Application` per module of a GitOps repo tier (plus an
 * optional `AppProject`), replacing the hand-rolled loops deployment repos
 * copy between their meta/infra/apps/clusters/workloads app-of-apps files.
 * Each Application sources a path of the repo, typically via a
 * ConfigManagementPlugin that synthesizes in-repo cdk8s TypeScript
 * (`nebula-v1.0` with an `ENTRY_FILE` env).
 *
 * Sync policy presets (all share `selfHeal: true`, the retry policy, and the
 * CreateNamespace/ServerSideApply/SkipDryRunOnMissingResource/
 * RespectIgnoreDifferences sync options):
 *
 *  - `meta`    — no pruning + `Delete=false`: self-management tiers that must
 *                never be pruned/deleted out from under ArgoCD.
 *  - `capi`    — same policy as `meta`, plus the built-in CAPI
 *                ignoreDifferences list (controllers populate
 *                controlPlaneEndpoint/defaulted refs at runtime): CAPI cluster
 *                definitions ARE live infrastructure, double-gated against
 *                deletion.
 *  - `service` — `prune: true`: ordinary platform modules/workloads.
 *
 * NOTE: `prune: false` is NEVER rendered explicitly — false is the zero-value
 * ArgoCD omits from stored objects, so rendering it produces a permanent
 * phantom diff (git "adds" prune:false forever). Pruning is off by default;
 * `Delete=false` is the real protection guard.
 *
 * @example
 * ```typescript
 * import { ArgoCdAppTier } from 'nebula/modules/k8s/argocd/app-tier';
 *
 * // Fixed registry with sync waves (an infra tier):
 * new ArgoCdAppTier(chart, 'infra', {
 *   repoUrl, targetRevision, pathPrefix: 'aws',
 *   project: 'platform',
 *   namePrefix: 'infra-',
 *   syncPolicyPreset: 'meta',
 *   discovery: {
 *     mode: 'registry',
 *     dir: 'infra',
 *     modules: [
 *       { mod: 'crossplane', wave: -2 },
 *       { mod: 'cluster-api', wave: 1 },
 *     ],
 *   },
 * });
 *
 * // Auto-discovered subdirectories (an apps tier):
 * new ArgoCdAppTier(chart, 'apps', {
 *   repoUrl, targetRevision, pathPrefix: 'aws',
 *   namePrefix: 'app-',
 *   discovery: { mode: 'auto', dir: appsDir },
 * });
 *
 * // Per-cluster tree (clusters/<name>/{cluster,<services>}):
 * new ArgoCdAppTier(chart, 'clusters', {
 *   repoUrl, targetRevision, pathPrefix: 'aws',
 *   discovery: { mode: 'clusters', dir: clustersDir, clusterApp: {} },
 * });
 * ```
 */
import { Construct } from "constructs";
import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  Application,
  AppProject,
  ApplicationSpecDestination,
  ApplicationSpecIgnoreDifferences,
  ApplicationSpecSyncPolicy,
  ApplicationSpecSyncPolicyRetry,
  AppProjectSpecDestinations,
  AppProjectSpecClusterResourceWhitelist,
} from "#imports/argoproj.io";
import { ARGOCD_SYNC_WAVE_ANNOTATION, BaseConstruct } from "../../../core";

/**
 * Known CAPI runtime drift, ignored during diffing: controllers populate
 * controlPlaneEndpoint / defaulted refs at runtime, and MachineDeployments
 * accrue revision annotations + defaulted rollout fields. Built into the
 * `capi` sync policy preset.
 */
export const CAPI_IGNORE_DIFFERENCES: ApplicationSpecIgnoreDifferences[] = [
  {
    group: "cluster.x-k8s.io",
    kind: "Cluster",
    jqPathExpressions: [
      ".spec.controlPlaneEndpoint",
      ".spec.controlPlaneRef.namespace",
      ".spec.infrastructureRef.namespace",
      ".spec.topology",
    ],
  },
  {
    group: "cluster.x-k8s.io",
    kind: "MachineDeployment",
    jqPathExpressions: [
      '.metadata.annotations["machinedeployment.clusters.x-k8s.io/revision"]',
      ".metadata.labels",
      ".metadata.ownerReferences",
      ".spec.strategy",
      ".spec.minReadySeconds",
      ".spec.progressDeadlineSeconds",
      ".spec.revisionHistoryLimit",
      ".spec.selector",
      ".spec.template.metadata",
      ".spec.template.spec.bootstrap.configRef.namespace",
      ".spec.template.spec.infrastructureRef.namespace",
    ],
  },
  {
    group: "infrastructure.cluster.x-k8s.io",
    kind: "AWSCluster",
    // k0smotron publishes the hosted-CP Service endpoint here at runtime (the
    // AWSCluster's own LB is DISABLED for workload clusters).
    jqPathExpressions: [".spec.controlPlaneEndpoint"],
  },
];

/** The in-cluster API server destination. */
export const ARGOCD_IN_CLUSTER_SERVER = "https://kubernetes.default.svc";

export type ArgoCdSyncPolicyPreset = "meta" | "capi" | "service";

export interface ArgoCdAppTierSyncPolicyOverrides {
  /**
   * Automated pruning. `true` renders `automated.prune: true`; `false` OMITS
   * the field entirely (never rendered explicitly — see the phantom-diff note
   * on the class).
   */
  prune?: boolean;
  /** Include the `Delete=false` sync option (removing/cascading the Application cannot delete its resources). */
  deleteProtection?: boolean;
}

export interface ArgoCdAppTierPluginConfig {
  /** ConfigManagementPlugin name (defaults to nebula-v1.0) */
  name?: string;
  /** Entry file passed as the ENTRY_FILE plugin env (defaults to index.ts) */
  entryFile?: string;
}

/** Optional AppProject rendered alongside the tier (typically once, in the meta tier). */
export interface ArgoCdAppTierProjectConfig {
  /** Project description */
  description?: string;
  /** Allowed source repositories (defaults to ['*']) */
  sourceRepos?: string[];
  /** Allowed destinations (defaults to [{ namespace: '*', server: '*' }]) */
  destinations?: AppProjectSpecDestinations[];
  /** Allowed cluster-scoped resources (defaults to [{ group: '*', kind: '*' }]) */
  clusterResourceWhitelist?: AppProjectSpecClusterResourceWhitelist[];
}

/** One Application of a `registry` discovery tier. */
export interface ArgoCdAppTierModule {
  /** Module name — the Application is named `${namePrefix}${mod}` */
  mod: string;
  /** argocd.argoproj.io/sync-wave annotation (omitted when unset) */
  wave?: number;
  /**
   * Repo path relative to `pathPrefix` (defaults to `${discovery.dir}/${mod}`,
   * or `${mod}` when `discovery.dir` is unset)
   */
  path?: string;
  /** Sync policy preset for this Application (defaults to the tier's) */
  syncPolicyPreset?: ArgoCdSyncPolicyPreset;
  /** Per-app sync policy overrides on top of the preset */
  syncPolicy?: ArgoCdAppTierSyncPolicyOverrides;
  /** Destination override (defaults to the tier's destination) */
  destination?: ApplicationSpecDestination;
  /** Shorthand: override only the destination namespace */
  namespace?: string;
  /** Extra ignoreDifferences entries (appended to the preset's built-ins) */
  extraIgnoreDifferences?: ApplicationSpecIgnoreDifferences[];
  /** Extra labels on the Application */
  labels?: Record<string, string>;
}

export interface ArgoCdAppTierRegistryDiscovery {
  /** Fixed list of modules (deterministic ordering + per-app sync waves). */
  mode: "registry";
  /** Repo directory the modules live under — default per-module path is `${dir}/${mod}` */
  dir?: string;
  /** The modules, in render order */
  modules: ArgoCdAppTierModule[];
}

export interface ArgoCdAppTierAutoDiscovery {
  /** Every subdirectory of `dir` becomes an Application — drop a module in git, no registry edit. */
  mode: "auto";
  /** Filesystem directory to scan at synth time (dot-dirs and node_modules are skipped) */
  dir: string;
  /** Repo directory the modules live under (defaults to basename(dir)) — per-module path is `${pathDir}/${mod}` */
  pathDir?: string;
}

/** The special CAPI-definition Application of a `clusters` discovery tier. */
export interface ArgoCdAppTierClusterAppConfig {
  /** Subdirectory holding the cluster's CAPI CRs (defaults to 'cluster') */
  subdir?: string;
  /** Application name prefix — the Application is named `${namePrefix}${cluster}` (defaults to 'cluster-') */
  namePrefix?: string;
  /**
   * Destination — the CAPI object graph lives on the MANAGEMENT cluster
   * (defaults to `{ server: in-cluster, namespace: 'default' }`)
   */
  destination?: ApplicationSpecDestination;
  /** Sync policy preset (defaults to 'capi') */
  syncPolicyPreset?: ArgoCdSyncPolicyPreset;
  /** Per-app sync policy overrides on top of the preset */
  syncPolicy?: ArgoCdAppTierSyncPolicyOverrides;
  /** Extra ignoreDifferences entries (appended to the preset's built-ins) */
  extraIgnoreDifferences?: ApplicationSpecIgnoreDifferences[];
}

export interface ArgoCdAppTierClustersDiscovery {
  /**
   * Two-level per-cluster tree: `dir/<cluster>/<module>` becomes an
   * Application `<cluster>-<module>` with destination `{ name: '<cluster>' }`
   * (the ArgoCD cluster secret the cluster was registered under, e.g. via
   * ArgoCdClusterSync). With `clusterApp` set, the `<clusterApp.subdir>`
   * subdirectory is instead rendered as `cluster-<cluster>` targeting the
   * management cluster with the `capi` preset.
   */
  mode: "clusters";
  /** Filesystem directory to scan at synth time */
  dir: string;
  /** Repo directory the tree lives under (defaults to basename(dir)) */
  pathDir?: string;
  /**
   * Value of the `nebula/tier` label stamped on every Application
   * (`nebula/env` = the cluster directory name). Defaults to 'cluster' when
   * `clusterApp` is set, 'workload' otherwise.
   */
  tier?: string;
  /** Render the per-cluster CAPI-definition Application (defaults to off) */
  clusterApp?: ArgoCdAppTierClusterAppConfig;
  /** Sync policy preset for the per-cluster service Applications (defaults to 'service') */
  serviceSyncPolicyPreset?: ArgoCdSyncPolicyPreset;
  /** Per-app sync policy overrides for the service Applications */
  serviceSyncPolicy?: ArgoCdAppTierSyncPolicyOverrides;
}

export type ArgoCdAppTierDiscovery =
  | ArgoCdAppTierRegistryDiscovery
  | ArgoCdAppTierAutoDiscovery
  | ArgoCdAppTierClustersDiscovery;

export interface ArgoCdAppTierConfig {
  /** Git repository URL every Application sources */
  repoUrl: string;
  /** Git revision (branch/tag/SHA) */
  targetRevision: string;
  /** Path prefix prepended (with '/') to every Application path, e.g. the repo subdirectory holding the platform */
  pathPrefix?: string;
  /** ArgoCD control plane namespace the Applications live in (defaults to argocd) */
  argoCdNamespace?: string;
  /** AppProject the Applications belong to (defaults to default) */
  project?: string;
  /** Create the AppProject named `project` as part of this tier */
  createProject?: ArgoCdAppTierProjectConfig;
  /**
   * ConfigManagementPlugin rendering each path (defaults to nebula-v1.0 with
   * ENTRY_FILE=index.ts). Pass false for plain (non-plugin) sources.
   */
  plugin?: false | ArgoCdAppTierPluginConfig;
  /** Application name prefix for registry/auto discovery (e.g. 'infra-'; defaults to none) */
  namePrefix?: string;
  /** Default destination (defaults to `{ server: in-cluster, namespace: argoCdNamespace }`) */
  destination?: ApplicationSpecDestination;
  /** Default sync policy preset (defaults to 'service') */
  syncPolicyPreset?: ArgoCdSyncPolicyPreset;
  /** Tier-wide sync policy overrides on top of the preset */
  syncPolicy?: ArgoCdAppTierSyncPolicyOverrides;
  /** Retry policy (defaults to limit 10, backoff 10s x2 capped at 3m) */
  retry?: ApplicationSpecSyncPolicyRetry;
  /** How the tier's Applications are derived */
  discovery: ArgoCdAppTierDiscovery;
}

/** List subdirectories the same way the hand-rolled tiers do (sorted; dot-dirs and node_modules skipped). */
function listDirs(p: string): string[] {
  return readdirSync(p, { withFileTypes: true })
    .filter(
      (e) =>
        e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules",
    )
    .map((e) => e.name)
    .sort();
}

export class ArgoCdAppTier extends BaseConstruct<ArgoCdAppTierConfig> {
  public readonly appProject?: AppProject;
  public readonly applications: Application[] = [];

  private readonly argoCdNamespace: string;
  private readonly projectName: string;
  private readonly retry: ApplicationSpecSyncPolicyRetry;
  private readonly plugin?: { name: string; env: { name: string; value: string }[] };
  private readonly defaultDestination: ApplicationSpecDestination;

  constructor(scope: Construct, id: string, config: ArgoCdAppTierConfig) {
    super(scope, id, config);

    this.argoCdNamespace = this.config.argoCdNamespace ?? "argocd";
    this.projectName = this.config.project ?? "default";
    this.retry = this.config.retry ?? {
      limit: 10,
      backoff: { duration: "10s", factor: 2, maxDuration: "3m" },
    };
    this.plugin =
      this.config.plugin === false
        ? undefined
        : {
            name: this.config.plugin?.name ?? "nebula-v1.0",
            env: [
              {
                name: "ENTRY_FILE",
                value: this.config.plugin?.entryFile ?? "index.ts",
              },
            ],
          };
    this.defaultDestination = this.config.destination ?? {
      server: ARGOCD_IN_CLUSTER_SERVER,
      namespace: this.argoCdNamespace,
    };

    if (this.config.createProject) {
      const proj = this.config.createProject;
      this.appProject = new AppProject(this, "project", {
        metadata: { name: this.projectName, namespace: this.argoCdNamespace },
        spec: {
          description: proj.description,
          sourceRepos: proj.sourceRepos ?? ["*"],
          destinations: proj.destinations ?? [{ namespace: "*", server: "*" }],
          clusterResourceWhitelist: proj.clusterResourceWhitelist ?? [
            { group: "*", kind: "*" },
          ],
        },
      });
    }

    const discovery = this.config.discovery;
    switch (discovery.mode) {
      case "registry":
        this.createRegistryApps(discovery);
        break;
      case "auto":
        this.createAutoApps(discovery);
        break;
      case "clusters":
        this.createClusterApps(discovery);
        break;
    }
  }

  private createRegistryApps(discovery: ArgoCdAppTierRegistryDiscovery): void {
    for (const entry of discovery.modules) {
      const path =
        entry.path ??
        (discovery.dir ? `${discovery.dir}/${entry.mod}` : entry.mod);
      const destination = entry.destination ?? this.defaultDestination;
      this.createApplication({
        name: `${this.config.namePrefix ?? ""}${entry.mod}`,
        path,
        wave: entry.wave,
        labels: entry.labels,
        destination: entry.namespace
          ? { ...destination, namespace: entry.namespace }
          : destination,
        preset: entry.syncPolicyPreset ?? this.config.syncPolicyPreset,
        overrides: entry.syncPolicy ?? this.config.syncPolicy,
        extraIgnoreDifferences: entry.extraIgnoreDifferences,
      });
    }
  }

  private createAutoApps(discovery: ArgoCdAppTierAutoDiscovery): void {
    const pathDir = discovery.pathDir ?? basename(discovery.dir);
    for (const mod of listDirs(discovery.dir)) {
      this.createApplication({
        name: `${this.config.namePrefix ?? ""}${mod}`,
        path: `${pathDir}/${mod}`,
        destination: this.defaultDestination,
        preset: this.config.syncPolicyPreset,
        overrides: this.config.syncPolicy,
      });
    }
  }

  private createClusterApps(discovery: ArgoCdAppTierClustersDiscovery): void {
    const pathDir = discovery.pathDir ?? basename(discovery.dir);
    const tier = discovery.tier ?? (discovery.clusterApp ? "cluster" : "workload");
    const clusterSubdir = discovery.clusterApp
      ? (discovery.clusterApp.subdir ?? "cluster")
      : undefined;

    for (const cluster of listDirs(discovery.dir)) {
      const labels = { "nebula/tier": tier, "nebula/env": cluster };
      for (const mod of listDirs(join(discovery.dir, cluster))) {
        if (discovery.clusterApp && mod === clusterSubdir) {
          // The cluster's CAPI definition → the MANAGEMENT cluster, where
          // CAPA/k0smotron reconcile the object graph.
          this.createApplication({
            name: `${discovery.clusterApp.namePrefix ?? "cluster-"}${cluster}`,
            path: `${pathDir}/${cluster}/${mod}`,
            labels,
            destination: discovery.clusterApp.destination ?? {
              server: ARGOCD_IN_CLUSTER_SERVER,
              namespace: "default",
            },
            preset: discovery.clusterApp.syncPolicyPreset ?? "capi",
            overrides: discovery.clusterApp.syncPolicy,
            extraIgnoreDifferences: discovery.clusterApp.extraIgnoreDifferences,
          });
        } else {
          // In-cluster service → the workload cluster itself, via the ArgoCD
          // cluster secret it was registered under (e.g. ArgoCdClusterSync).
          this.createApplication({
            name: `${cluster}-${mod}`,
            path: `${pathDir}/${cluster}/${mod}`,
            labels,
            destination: { name: cluster },
            preset:
              discovery.serviceSyncPolicyPreset ??
              this.config.syncPolicyPreset ??
              "service",
            overrides: discovery.serviceSyncPolicy ?? this.config.syncPolicy,
          });
        }
      }
    }
  }

  private createApplication(app: {
    name: string;
    path: string;
    wave?: number;
    labels?: Record<string, string>;
    destination: ApplicationSpecDestination;
    preset?: ArgoCdSyncPolicyPreset;
    overrides?: ArgoCdAppTierSyncPolicyOverrides;
    extraIgnoreDifferences?: ApplicationSpecIgnoreDifferences[];
  }): void {
    const preset = app.preset ?? "service";
    const ignoreDifferences = [
      ...(preset === "capi" ? CAPI_IGNORE_DIFFERENCES : []),
      ...(app.extraIgnoreDifferences ?? []),
    ];
    const path = this.config.pathPrefix
      ? `${this.config.pathPrefix}/${app.path}`
      : app.path;

    this.applications.push(
      new Application(this, app.name, {
        metadata: {
          name: app.name,
          namespace: this.argoCdNamespace,
          ...(app.labels ? { labels: app.labels } : {}),
          ...(app.wave !== undefined
            ? { annotations: { [ARGOCD_SYNC_WAVE_ANNOTATION]: String(app.wave) } }
            : {}),
        },
        spec: {
          project: this.projectName,
          source: {
            repoUrl: this.config.repoUrl,
            targetRevision: this.config.targetRevision,
            path,
            ...(this.plugin ? { plugin: this.plugin } : {}),
          },
          destination: app.destination,
          syncPolicy: this.buildSyncPolicy(preset, app.overrides),
          ...(ignoreDifferences.length > 0 ? { ignoreDifferences } : {}),
        },
      }),
    );
  }

  private buildSyncPolicy(
    preset: ArgoCdSyncPolicyPreset,
    overrides?: ArgoCdAppTierSyncPolicyOverrides,
  ): ApplicationSpecSyncPolicy {
    const defaults = {
      meta: { prune: false, deleteProtection: true },
      capi: { prune: false, deleteProtection: true },
      service: { prune: true, deleteProtection: false },
    }[preset];
    const prune = overrides?.prune ?? defaults.prune;
    const deleteProtection =
      overrides?.deleteProtection ?? defaults.deleteProtection;

    return {
      // NEVER render `prune: false` — see the phantom-diff note on the class.
      automated: prune ? { selfHeal: true, prune: true } : { selfHeal: true },
      retry: this.retry,
      syncOptions: [
        "CreateNamespace=true",
        "ServerSideApply=true",
        "SkipDryRunOnMissingResource=true",
        "RespectIgnoreDifferences=true",
        ...(deleteProtection ? ["Delete=false"] : []),
      ],
    };
  }
}
