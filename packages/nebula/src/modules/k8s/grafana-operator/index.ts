/**
 * Grafana Operator - manage a Grafana's datasources, folders and dashboards
 * as Kubernetes resources applied through Grafana's API.
 *
 * @example
 * ```typescript
 * const grafana = new GrafanaOperator(chart, "grafana-operator", {
 *   kubeAuthAudience: "operator.grafana.com",
 *   instance: {
 *     name: "main", namespace: "monitoring", labels: { grafana: "main" },
 *     url: "http://prometheus-grafana.monitoring.svc.cluster.local:80",
 *   },
 * });
 * grafana.folder("platform", "Platform");
 * grafana.dashboard("nodes", { folder: "platform", json });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import {
  Grafana, GrafanaDashboard, GrafanaDatasource, GrafanaFolder,
  type GrafanaDashboardSpec, type GrafanaDatasourceSpecDatasource,
} from "#imports/grafana.integreatly.org";
import { HelmModule } from "../../../core";

/** A datasource field filled from a Secret key; the field holds `${key}` where the value goes. */
export interface GrafanaDatasourceSecret {
  /** Field path inside the datasource, e.g. `secureJsonData.basicAuthPassword`. */
  path: string;
  secret: string;
  key: string;
}

export interface GrafanaDatasourceConfig {
  namespace: string;
  /** Labels of the operator's Grafana resource that receives the datasource. */
  instance: Record<string, string>;
  datasource: GrafanaDatasourceSpecDatasource & { name: string; type: string; uid: string; url: string };
  secrets?: GrafanaDatasourceSecret[];
  /** Set when another Argo CD application installs the operator's definitions. */
  definitionsInstalledElsewhere?: boolean;
}

/** A datasource the Grafana operator applies; proxy access and editable unless stated. */
export function grafanaDatasource(scope: Construct, c: GrafanaDatasourceConfig): GrafanaDatasource {
  return new GrafanaDatasource(scope, `grafana-datasource-${c.datasource.uid}`, {
    metadata: {
      name: c.datasource.uid, namespace: c.namespace,
      ...(c.definitionsInstalledElsewhere ? { annotations: { "argocd.argoproj.io/sync-options": "SkipDryRunOnMissingResource=true" } } : {}),
    },
    spec: {
      instanceSelector: { matchLabels: c.instance },
      datasource: { access: "proxy", editable: true, ...c.datasource },
      ...(c.secrets?.length ? { valuesFrom: c.secrets.map(({ path, secret, key }) => ({
        targetPath: path, valueFrom: { secretKeyRef: { name: secret, key } },
      })) } : {}),
    },
  });
}

export interface GrafanaOperatorInstance {
  name: string;
  namespace: string;
  /** Labels datasources, folders and dashboards select this Grafana by. */
  labels: Record<string, string>;
  /** In-cluster URL of an existing Grafana the operator manages through its API. */
  url: string;
}

export interface GrafanaOperatorConfig {
  /** Operator namespace (defaults to grafana-operator-system). */
  namespace?: string;
  /** Helm chart version (defaults to 5.24.0). */
  version?: string;
  /** Additional chart values. */
  values?: Record<string, unknown>;
  /**
   * Authenticate to Grafana with the operator's projected ServiceAccount token
   * for this audience. Pair with `grafanaOperatorKubeAuth` on the Grafana side.
   */
  kubeAuthAudience?: string;
  /** Lifetime of that token in seconds (defaults to 3600). */
  kubeAuthExpirationSeconds?: number;
  /** An existing Grafana to manage. */
  instance?: GrafanaOperatorInstance;
}

export class GrafanaOperator extends HelmModule<GrafanaOperatorConfig> {
  public readonly helm: Helm;
  public readonly grafana?: Grafana;

  constructor(scope: Construct, id: string, config: GrafanaOperatorConfig = {}) {
    super(scope, id, config);
    const namespace = config.namespace ?? "grafana-operator-system";
    this.createNamespace(namespace);
    this.helm = this.createHelmRelease({
      namespace,
      chart: "grafana-operator",
      releaseName: "grafana-operator",
      repo: "https://grafana.github.io/helm-charts",
      version: config.version ?? "5.24.0",
      defaultValues: config.kubeAuthAudience
        ? { kubeAuth: { audience: config.kubeAuthAudience, expirationSeconds: config.kubeAuthExpirationSeconds ?? 3600 } }
        : {},
      values: config.values,
      helmFlags: ["--include-crds"],
    });
    if (config.instance) {
      const { name, namespace: instanceNamespace, labels, url } = config.instance;
      this.grafana = new Grafana(this, "grafana", {
        metadata: { name, namespace: instanceNamespace, labels },
        spec: { ...(config.kubeAuthAudience ? { client: { useKubeAuth: true } } : {}), external: { url } },
      });
    }
  }

  private get instance(): GrafanaOperatorInstance {
    if (!this.config.instance) throw new Error("GrafanaOperator needs an instance to manage Grafana content");
    return this.config.instance;
  }

  public datasource(datasource: GrafanaDatasourceConfig["datasource"], secrets?: GrafanaDatasourceSecret[]): GrafanaDatasource {
    const { namespace, labels } = this.instance;
    return grafanaDatasource(this, { namespace, instance: labels, datasource, secrets });
  }

  /** `name` is the resource name dashboards reference through `folder`. */
  public folder(name: string, title: string): GrafanaFolder {
    const { namespace, labels } = this.instance;
    return new GrafanaFolder(this, `folder-${name}`, {
      metadata: { name, namespace },
      spec: { instanceSelector: { matchLabels: labels }, title },
    });
  }

  public dashboard(name: string, spec: Omit<GrafanaDashboardSpec, "instanceSelector">): GrafanaDashboard {
    const { namespace, labels } = this.instance;
    return new GrafanaDashboard(this, `dashboard-${name}`, {
      metadata: { name, namespace },
      spec: { instanceSelector: { matchLabels: labels }, ...spec },
    });
  }
}
