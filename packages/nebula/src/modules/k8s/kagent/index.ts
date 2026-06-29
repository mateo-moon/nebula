/**
 * Kagent - Kubernetes-native agentic AI framework (CNCF Sandbox).
 *
 * Deploys the kagent CRDs chart and the kagent controller chart (which also
 * brings up the web UI, a bundled Postgres, kmcp and the built-in tools MCP
 * server). Agents/ModelConfigs themselves are normal `kagent.dev` custom
 * resources that you declare in your app, so this module only owns the platform
 * install.
 *
 * Charts are published as OCI artifacts at
 * `oci://ghcr.io/kagent-dev/kagent/helm/{kagent-crds,kagent}`. cdk8s renders
 * them with `helm template`; if your local helm/cdk8s cannot pull OCI charts,
 * vendor them with `helm pull <oci> --version <v> --untar` and pass
 * `localChartPath` / `localCrdsChartPath`.
 *
 * This module extends `BaseConstruct` (not `HelmModule`) because kagent uses OCI
 * charts — `HelmModule.createHelmRelease` requires a non-optional `repo` field
 * and always emits `helm template --repo`, which is incompatible with `oci://`
 * URLs. Same intentional pattern as `confidential-containers`.
 *
 * @example
 * ```typescript
 * new Kagent(chart, 'kagent', {
 *   namespace: 'kagent',
 *   provider: 'anthropic',
 *   apiKey: process.env.ANTHROPIC_API_KEY!, // or 'ref+sops://.secrets/secrets.yaml#kagent/anthropic_api_key'
 *   tolerations: [{ key: 'node-role.kubernetes.io/control-plane', operator: 'Exists', effect: 'NoSchedule' }],
 *   externalPostgres: { url: 'postgresql://kagent:kagent@kagent-pg.kagent:5432/kagent' },
 *   ingress: { enabled: true, host: 'kagent.example.com' },
 * });
 * ```
 */
import { Construct } from "constructs";
import { ApiObject, Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import {
  BaseConstruct,
  type Toleration,
  ARGOCD_KEEP_ON_DELETE,
  syncWave,
} from "../../../core";

/** Model provider key as understood by the kagent Helm chart (`providers.<key>`). */
export type KagentProvider =
  | "anthropic"
  | "openAI"
  | "ollama"
  | "gemini"
  | "azureOpenAI";

/** HA / scaling configuration for the kagent control-plane pods. */
export interface KagentHaConfig {
  /** Controller replicas (default: 1; kagent auto-enables leader election >1). */
  controllerReplicas?: number;
  /** UI replicas (default: 1). */
  uiReplicas?: number;
  /** Tool server replica count (default: 1). */
  toolsReplicas?: number;
  /** Resource requests/limits for controller/ui/tools. */
  resources?: {
    controller?: kplus.ResourceProps;
    ui?: kplus.ResourceProps;
    tools?: kplus.ResourceProps;
  };
  /** Node selector applied to controller + UI. */
  nodeSelector?: Record<string, string>;
  /** Tolerations applied to controller + UI. */
  tolerations?: Toleration[];
  /** Restrict controller RBAC + reconciliation to these namespaces (empty = cluster-wide). */
  watchNamespaces?: string[];
}

/** External Postgres configuration (replaces the bundled dev/eval Postgres). */
export interface KagentExternalPostgresConfig {
  /** External Postgres connection URL. Takes precedence over bundled. */
  url?: string;
  /** Path to a file containing the database URL (takes precedence over `url`). */
  urlFileSecret?: { name: string; key?: string };
  /** Enable pgvector migration (required for kagent long-term memory). */
  vectorEnabled?: boolean;
  /** Disable the bundled Postgres entirely (default: true when any field is set). */
  bundled?: boolean;
}

/** Ingress configuration for the kagent UI + A2A endpoint. */
export interface KagentIngressConfig {
  /** Enable ingress (creates Ingress resources for UI + optionally A2A). */
  enabled: boolean;
  /** Ingress class name (default: "nginx"). */
  className?: string;
  /** Hostname for the UI (e.g. "kagent.example.com"). Env fallback: `KAGENT_UI_HOST`. */
  host?: string;
  /**
   * Hostname for the A2A (:8083 controller) endpoint when `expose` includes
   * "a2a". Defaults to `host`; use a dedicated hostname when exposing both UI
   * and A2A (they each serve at `/`). Env fallback: `KAGENT_A2A_HOST`.
   */
  a2aHost?: string;
  /** TLS configuration (if omitted, ingress is HTTP-only). Env issuer fallback: `KAGENT_TLS_ISSUER`. */
  tls?: { issuer?: string; host?: string };
  /** Which endpoints to expose: "ui" (default), "a2a" (the :8083 controller endpoint). */
  expose?: ("ui" | "a2a")[];
  /** Extra annotations. */
  annotations?: Record<string, string>;
}

/** RBAC scope for the kagent-tools ServiceAccount (the MCP tool server the agents drive). */
export interface KagentRbacConfig {
  /**
   * "cluster-admin" (default — the chart's built-in role; NOT recommended for production).
   * "scoped" — the module creates a least-privilege ClusterRole (read-everything +
   *   workload-write only; NO ClusterRoleBindings, node writes, secret writes, or PV writes).
   *   The chart's cluster-admin binding is deleted and replaced.
   */
  scope?: "cluster-admin" | "scoped";
  /** When scope="scoped", restrict write to these namespaces (empty = all). */
  writeNamespaces?: string[];
}

export interface KagentConfig {
  /** Namespace for kagent (default: "kagent"). */
  namespace?: string;
  /** kagent controller chart version (default: "0.9.9"). */
  version?: string;
  /** kagent-crds chart version (default: same as `version`). */
  crdsVersion?: string;
  /**
   * OCI registry base for the charts
   * (default: "oci://ghcr.io/kagent-dev/kagent/helm").
   */
  registry?: string;
  /** Default model provider wired into `providers.default` (default: "anthropic"). */
  provider?: KagentProvider;
  /**
   * Model-provider API key. The chart creates the provider Secret from it
   * (e.g. `kagent-anthropic` / `ANTHROPIC_API_KEY`). Supports `ref+...` secret
   * refs (auto-resolved by BaseConstruct). Omit for the `ollama` provider.
   */
  apiKey?: string;
  /** Override the provider's default model (e.g. "claude-sonnet-4-5", "gpt-4.1-mini"). */
  model?: string;
  /**
   * Install the chart's bundled example agents (k8s-agent, istio-agent, …) and
   * extra tool servers (grafana-mcp, querydoc). Default `false` keeps the
   * install lean. Set `true` for the full set.
   */
  bundledAgents?: boolean;
  /** HA / scaling configuration for production deployments. */
  ha?: KagentHaConfig;
  /** External Postgres (use this instead of the bundled dev Postgres for production). */
  externalPostgres?: KagentExternalPostgresConfig;
  /** Ingress for the kagent UI + optionally the A2A endpoint. */
  ingress?: KagentIngressConfig;
  /**
   * RBAC scope for the kagent-tools ServiceAccount. Default "cluster-admin" (chart
   * default). Set scope="scoped" for least-privilege (recommended for production).
   */
  rbac?: KagentRbacConfig;
  /** Tolerations applied to all kagent pods (useful for control-plane taints). */
  tolerations?: Toleration[];
  /** Extra Helm values for the kagent controller chart (deep-merged last). */
  values?: Record<string, unknown>;
  /** Extra Helm values for the kagent-crds chart. */
  crdsValues?: Record<string, unknown>;
  /** Local path to a vendored kagent chart (OCI fallback; overrides `registry`/`version`). */
  localChartPath?: string;
  /** Local path to a vendored kagent-crds chart (OCI fallback). */
  localCrdsChartPath?: string;
}

/** Subchart keys gated by `<name>.enabled` that we turn off in lean mode. */
const BUNDLED_AGENT_KEYS = [
  "k8s-agent",
  "kgateway-agent",
  "istio-agent",
  "promql-agent",
  "observability-agent",
  "argo-rollouts-agent",
  "helm-agent",
  "cilium-policy-agent",
  "cilium-manager-agent",
  "cilium-debug-agent",
  "grafana-mcp",
  "querydoc",
] as const;

export class Kagent extends BaseConstruct<KagentConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly crds: Helm;
  public readonly helm: Helm;
  public readonly namespaceName: string;

  constructor(scope: Construct, id: string, config: KagentConfig = {}) {
    super(scope, id, config);

    const ns = this.config.namespace ?? "kagent";
    this.namespaceName = ns;
    const registry =
      this.config.registry ?? "oci://ghcr.io/kagent-dev/kagent/helm";
    const version = this.config.version ?? "0.9.9";
    const crdsVersion = this.config.crdsVersion ?? version;
    const provider = this.config.provider ?? "anthropic";

    // Namespace (helm template does not create it).
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: ns },
    });

    // 1) CRDs chart (applied first by `nebula apply` phase 1).
    this.crds = new Helm(this, "crds", {
      chart: this.config.localCrdsChartPath ?? `${registry}/kagent-crds`,
      releaseName: "kagent-crds",
      ...(this.config.localCrdsChartPath ? {} : { version: crdsVersion }),
      namespace: ns,
      values: this.config.crdsValues ?? {},
    });

    // Provider config -> the chart provisions the Secret + a `default-model-config`.
    const providerBlock: Record<string, unknown> = {};
    if (this.config.apiKey) providerBlock.apiKey = this.config.apiKey;
    if (this.config.model) providerBlock.model = this.config.model;
    const providerValues: Record<string, unknown> = { default: provider };
    if (Object.keys(providerBlock).length > 0) {
      providerValues[provider] = providerBlock;
    }

    // Lean mode: disable bundled example agents + extra tool servers.
    const leanValues: Record<string, unknown> = {};
    if (this.config.bundledAgents !== true) {
      for (const key of BUNDLED_AGENT_KEYS) {
        leanValues[key] = { enabled: false };
      }
    }

    // Tolerations (global — applied to all kagent pods).
    const tolerationValues: Record<string, unknown> = {};
    if (this.config.tolerations?.length || this.config.ha?.tolerations?.length) {
      const allTolerations = [
        ...(this.config.tolerations ?? []),
        ...(this.config.ha?.tolerations ?? []),
      ];
      tolerationValues.globalTolerations = allTolerations;
    }

    // HA configuration.
    const haValues: Record<string, unknown> = {};
    if (this.config.ha) {
      const ha = this.config.ha;
      if (ha.controllerReplicas !== undefined)
        haValues.controller = { replicas: ha.controllerReplicas };
      if (ha.uiReplicas !== undefined)
        haValues.ui = { replicas: ha.uiReplicas };
      if (ha.toolsReplicas !== undefined)
        haValues["kagent-tools"] = { replicaCount: ha.toolsReplicas };
      if (ha.nodeSelector)
        haValues.globalNodeSelector = ha.nodeSelector;
      if (ha.watchNamespaces) {
        haValues.rbac = { namespaces: ha.watchNamespaces };
        haValues.controller = {
          ...(haValues.controller as object),
          watchNamespaces: ha.watchNamespaces,
        };
      }
      if (ha.resources) {
        if (ha.resources.controller)
          haValues.controller = {
            ...(haValues.controller as object),
            resources: ha.resources.controller,
          };
        if (ha.resources.ui)
          haValues.ui = { ...(haValues.ui as object), resources: ha.resources.ui };
        if (ha.resources.tools)
          haValues["kagent-tools"] = {
            ...(haValues["kagent-tools"] as object),
            resources: ha.resources.tools,
          };
      }
    }

    // External Postgres (replaces the bundled dev Postgres).
    const dbValues: Record<string, unknown> = {};
    if (this.config.externalPostgres) {
      const pg = this.config.externalPostgres;
      dbValues.database = {
        postgres: {
          bundled: { enabled: pg.bundled ?? false },
          ...(pg.url ? { url: pg.url } : {}),
          ...(pg.urlFileSecret
            ? {
                urlFile: pg.urlFileSecret.key
                  ? `${pg.urlFileSecret.name}/${pg.urlFileSecret.key}`
                  : pg.urlFileSecret.name,
              }
            : {}),
          ...(pg.vectorEnabled !== undefined
            ? { vectorEnabled: pg.vectorEnabled }
            : {}),
        },
      };
    }

    const baseValues = deepmerge(
      { providers: providerValues },
      leanValues,
      tolerationValues,
      haValues,
      dbValues,
    );
    const chartValues = deepmerge(baseValues, this.config.values ?? {});

    // 2) Controller chart (UI, controller, bundled Postgres, kmcp, tools).
    this.helm = new Helm(this, "helm", {
      chart: this.config.localChartPath ?? `${registry}/kagent`,
      releaseName: "kagent",
      ...(this.config.localChartPath ? {} : { version }),
      namespace: ns,
      values: chartValues,
    });

    // Ingress (the chart has no built-in ingress — we build it).
    if (this.config.ingress?.enabled) {
      this.createIngress(ns);
    }

    // RBAC scoping (replace the chart's cluster-admin with a scoped role).
    if (this.config.rbac?.scope === "scoped") {
      this.createScopedRbac(ns);
    }
  }

  /**
   * Create Ingress resources for the UI (and optionally the A2A :8083 endpoint).
   * The chart does not provide ingress configuration — we build it as raw
   * `networking.k8s.io/v1` Ingress objects with ArgoCD sync-wave + cert-manager
   * annotations. external-dns (configured with `--source=ingress`, the nebula
   * module default) reads each host from `spec.rules[].host`, so it auto-creates
   * the DNS records without any per-Ingress hostname annotation.
   *
   * Hosts are configurable via {@link KagentIngressConfig} fields or env vars
   * (`KAGENT_UI_HOST`, `KAGENT_A2A_HOST`, `KAGENT_TLS_ISSUER`).
   */
  private createIngress(ns: string): void {
    const cfg = this.config.ingress!;
    const className = cfg.className ?? "nginx";
    const host = cfg.host ?? process.env.KAGENT_UI_HOST ?? "kagent.local";
    const expose = cfg.expose ?? ["ui"];

    // Base annotations shared by the UI + A2A ingresses.
    const annotations: Record<string, string> = {
      ...cfg.annotations,
      ...syncWave(2),
    };
    if (cfg.tls) {
      annotations["cert-manager.io/cluster-issuer"] =
        cfg.tls.issuer ??
        process.env.KAGENT_TLS_ISSUER ??
        "letsencrypt-prod";
    }

    if (expose.includes("ui")) {
      new ApiObject(this, "ingress-ui", {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
          name: "kagent-ui",
          namespace: ns,
          annotations,
          labels: { "app.kubernetes.io/managed-by": "nebula" },
        },
        spec: {
          ingressClassName: className,
          rules: [
            {
              host,
              http: {
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backend: {
                      service: { name: "kagent-ui", port: { number: 8080 } },
                    },
                  },
                ],
              },
            },
          ],
          ...(cfg.tls
            ? {
                tls: [
                  {
                    hosts: [cfg.tls.host ?? host],
                    secretName: "kagent-ui-tls",
                  },
                ],
              }
            : {}),
        },
      });
    }

    // A2A (controller :8083) endpoint. A dedicated hostname is recommended when
    // the UI is also exposed — both serve at `/`.
    if (expose.includes("a2a")) {
      const a2aHost =
        cfg.a2aHost ?? process.env.KAGENT_A2A_HOST ?? host;
      new ApiObject(this, "ingress-a2a", {
        apiVersion: "networking.k8s.io/v1",
        kind: "Ingress",
        metadata: {
          name: "kagent-a2a",
          namespace: ns,
          annotations,
          labels: { "app.kubernetes.io/managed-by": "nebula" },
        },
        spec: {
          ingressClassName: className,
          rules: [
            {
              host: a2aHost,
              http: {
                paths: [
                  {
                    path: "/",
                    pathType: "Prefix",
                    backend: {
                      service: {
                        name: "kagent-controller",
                        port: { number: 8083 },
                      },
                    },
                  },
                ],
              },
            },
          ],
          ...(cfg.tls
            ? {
                tls: [
                  {
                    hosts: [cfg.tls.host ?? a2aHost],
                    secretName: "kagent-a2a-tls",
                  },
                ],
              }
            : {}),
        },
      });
    }
  }

  /**
   * Create a scoped ClusterRole + binding for the kagent-tools ServiceAccount,
   * replacing the chart's default cluster-admin binding.
   *
   * Scope: read-everything (get/list/watch) + workload-write (pods, deployments,
   * services, configmaps, namespaces). Explicitly DENIED: ClusterRoleBindings
   * (privilege escalation), node writes (cordon/drain), secret writes,
   * persistentvolume writes.
   */
  private createScopedRbac(ns: string): void {
    const writeNs = this.config.rbac?.writeNamespaces?.length
      ? this.config.rbac.writeNamespaces
      : undefined;

    // Scoped ClusterRole (read-everything + workload-write).
    new ApiObject(this, "scoped-role", {
      apiVersion: "rbac.authorization.k8s.io/v1",
      kind: "ClusterRole",
      metadata: {
        name: "kagent-tools-scoped",
        labels: {
          "app.kubernetes.io/name": "kagent-tools",
          "nebula.sh/managed-by": "nebula",
        },
        annotations: ARGOCD_KEEP_ON_DELETE,
      },
      rules: [
        // Broad read (the inspector needs get/list/watch on everything).
        {
          apiGroups: ["*"],
          resources: ["*"],
          verbs: ["get", "list", "watch"],
        },
        // Pod logs.
        { apiGroups: [""], resources: ["pods/log"], verbs: ["get"] },
        // Workload write — for gated apply/delete/scale.
        {
          apiGroups: ["", "apps", "batch"],
          resources: [
            "pods",
            "deployments",
            "daemonsets",
            "statefulsets",
            "replicasets",
            "services",
            "configmaps",
            "namespaces",
            "jobs",
            "cronjobs",
          ],
          verbs: ["create", "update", "patch", "delete"],
        },
        // Explicitly NOT granted: clusterrolebindings, clusterroles, nodes (write),
        // persistentvolumes (write), secrets (write) — defense-in-depth.
      ],
    });

    // Binding (cluster-wide or namespace-scoped).
    if (writeNs) {
      for (const wns of writeNs) {
        new ApiObject(this, `scoped-binding-${wns}`, {
          apiVersion: "rbac.authorization.k8s.io/v1",
          kind: "RoleBinding",
          metadata: {
            name: `kagent-tools-scoped-${wns}`,
            namespace: wns,
            annotations: ARGOCD_KEEP_ON_DELETE,
          },
          subjects: [
            {
              kind: "ServiceAccount",
              name: "kagent-tools",
              namespace: ns,
            },
          ],
          roleRef: {
            kind: "ClusterRole",
            name: "kagent-tools-scoped",
            apiGroup: "rbac.authorization.k8s.io",
          },
        });
      }
    } else {
      new ApiObject(this, "scoped-binding", {
        apiVersion: "rbac.authorization.k8s.io/v1",
        kind: "ClusterRoleBinding",
        metadata: {
          name: "kagent-tools-scoped",
          annotations: ARGOCD_KEEP_ON_DELETE,
        },
        subjects: [
          {
            kind: "ServiceAccount",
            name: "kagent-tools",
            namespace: ns,
          },
        ],
        roleRef: {
          kind: "ClusterRole",
          name: "kagent-tools-scoped",
          apiGroup: "rbac.authorization.k8s.io",
        },
      });
    }
  }
}
