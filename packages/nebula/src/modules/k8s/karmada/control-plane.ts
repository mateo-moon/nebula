/**
 * Karmada Control Plane - Operator-based installation of Karmada.
 *
 * Uses the Karmada Operator to manage the control plane lifecycle,
 * including certificate generation and rotation.
 */
import { Construct } from "constructs";
import { Helm, ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import type { KarmadaConfig } from "./types";

/** Default Karmada version */
export const KARMADA_VERSION = "1.16.0";

/** Karmada Operator Helm repository URL */
export const KARMADA_OPERATOR_HELM_REPO =
  "https://raw.githubusercontent.com/karmada-io/karmada/master/charts";

/**
 * KarmadaControlPlane - Installs the Karmada control plane using the Karmada Operator.
 *
 * This creates:
 * - Karmada Operator (manages the control plane)
 * - Karmada CR (declares the desired control plane state)
 *
 * The operator handles:
 * - Certificate generation and rotation
 * - Component deployment (API Server, Controller Manager, Scheduler, etc.)
 * - ETCD management (embedded or external)
 */
export class KarmadaControlPlane extends Construct {
  public readonly operatorHelm: Helm;
  public readonly namespace: kplus.Namespace;
  public readonly karmadaCr: ApiObject;
  public readonly apiServerService: string;

  constructor(scope: Construct, id: string, config: KarmadaConfig = {}) {
    super(scope, id);

    const namespaceName = config.namespace ?? "karmada-system";
    const karmadaName = "karmada";

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // Install Karmada Operator via Helm
    const operatorValues: Record<string, unknown> = {
      installCRDs: true,
      operator: {
        replicaCount: 1,
      },
    };

    this.operatorHelm = new Helm(this, "operator", {
      chart: "karmada-operator",
      releaseName: "karmada-operator",
      repo: config.repository ?? KARMADA_OPERATOR_HELM_REPO,
      version: config.version ?? KARMADA_VERSION,
      namespace: namespaceName,
      values: deepmerge(operatorValues, config.values ?? {}),
      // Include CRDs so the Karmada CRD is installed
      helmFlags: ["--include-crds"],
    });

    // Build Karmada CR spec
    const karmadaSpec: Record<string, unknown> = {
      components: {
        etcd: config.externalEtcd
          ? {
              external: {
                endpoints: config.externalEtcd.endpoints,
                secretRef: {
                  name: config.externalEtcd.secretName,
                  namespace:
                    config.externalEtcd.secretNamespace ?? namespaceName,
                },
              },
            }
          : {
              local: {
                replicas: 1,
              },
            },
        karmadaAPIServer: {
          replicas: config.apiServerReplicas ?? 1,
          // Service type - can be changed to LoadBalancer or NodePort if needed
          serviceType: "ClusterIP",
        },
        karmadaControllerManager: {
          replicas: config.controllerManagerReplicas ?? 1,
        },
        karmadaScheduler: {
          replicas: config.schedulerReplicas ?? 1,
        },
        karmadaWebhook: {
          replicas: 1,
        },
        kubeControllerManager: {
          replicas: 1,
        },
        karmadaAggregatedAPIServer: {
          replicas: 1,
        },
      },
    };

    // Create Karmada CR
    this.karmadaCr = new ApiObject(this, "karmada-cr", {
      apiVersion: "operator.karmada.io/v1alpha1",
      kind: "Karmada",
      metadata: {
        name: karmadaName,
        namespace: namespaceName,
        annotations: {
          // Ensure operator is deployed before CR
          "argocd.argoproj.io/sync-wave": "1",
        },
      },
      spec: karmadaSpec,
    });

    // API server service name for ArgoCD registration
    // The operator creates the service with format: <karmada-name>-apiserver
    this.apiServerService = `${karmadaName}-apiserver.${namespaceName}.svc.cluster.local`;
  }
}
