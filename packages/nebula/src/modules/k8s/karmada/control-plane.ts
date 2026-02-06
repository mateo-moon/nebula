/**
 * Karmada Control Plane - Helm-based installation of Karmada.
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import type { KarmadaConfig } from "./types";

/** Default Karmada version */
export const KARMADA_VERSION = "1.16.0";

/** Karmada Helm repository URL */
export const KARMADA_HELM_REPO =
  "https://raw.githubusercontent.com/karmada-io/karmada/master/charts";

/**
 * KarmadaControlPlane - Installs the Karmada control plane using Helm.
 *
 * This creates:
 * - Karmada API Server
 * - Karmada Controller Manager
 * - Karmada Scheduler
 * - Karmada Webhook
 * - ETCD (embedded or external)
 */
export class KarmadaControlPlane extends Construct {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly apiServerService: string;

  constructor(scope: Construct, id: string, config: KarmadaConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace ?? "karmada-system";

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // Build default values
    const defaultValues: Record<string, unknown> = {
      installMode: config.installMode ?? "host",
      apiServer: {
        replicaCount: config.apiServerReplicas ?? 1,
      },
      controllerManager: {
        replicaCount: config.controllerManagerReplicas ?? 1,
      },
      scheduler: {
        replicaCount: config.schedulerReplicas ?? 1,
      },
      webhook: {
        replicaCount: 1,
      },
      // Use embedded etcd by default
      etcd: {
        mode: config.externalEtcd ? "external" : "internal",
        ...(config.externalEtcd && {
          external: {
            endpoints: config.externalEtcd.endpoints,
            secretRef: {
              name: config.externalEtcd.secretName,
              namespace: config.externalEtcd.secretNamespace ?? namespaceName,
            },
          },
        }),
      },
    };

    const chartValues = deepmerge(defaultValues, config.values ?? {});

    this.helm = new Helm(this, "helm", {
      chart: "karmada",
      releaseName: "karmada",
      repo: config.repository ?? KARMADA_HELM_REPO,
      version: config.version ?? KARMADA_VERSION,
      namespace: namespaceName,
      values: chartValues,
    });

    // API server service name for ArgoCD registration
    this.apiServerService = `karmada-apiserver.${namespaceName}.svc.cluster.local`;
  }
}
