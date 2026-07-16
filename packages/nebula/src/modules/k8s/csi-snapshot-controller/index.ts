/**
 * CsiSnapshotController - the common Kubernetes CSI snapshot API/controller.
 *
 * Self-managed Kubernetes distributions do not necessarily install the CSI
 * snapshot CRDs or the external snapshot controller. This construct renders
 * the Piraeus snapshot-controller chart with the CRDs included and production
 * defaults for a highly available controller deployment.
 *
 * The construct deliberately exposes only the stable VolumeSnapshot v1 API.
 * The chart also bundles beta VolumeGroupSnapshot CRDs, but those CRDs depend
 * on a conversion webhook that is disabled here. Advertising them would expose
 * an API that cannot work, so they are removed from the rendered release.
 *
 * @example
 * ```typescript
 * import { CsiSnapshotController } from "nebula-cdk8s";
 *
 * new CsiSnapshotController(chart, "snapshot-controller");
 * ```
 */
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { Construct } from "constructs";
import { HelmModule } from "../../../core";

export interface CsiSnapshotControllerConfig {
  /** Namespace (defaults to kube-system). */
  namespace?: string;
  /** Helm chart version (defaults to the pinned 5.1.1 release). */
  version?: string;
  /** Helm repository URL (defaults to the Piraeus chart repository). */
  repository?: string;
  /** Helm release name (defaults to snapshot-controller). */
  releaseName?: string;
  /** Additional Helm values merged over the production defaults. */
  values?: Record<string, unknown>;
}

export class CsiSnapshotController extends HelmModule<CsiSnapshotControllerConfig> {
  public readonly helm: Helm;
  /** Created only when a namespace other than kube-system is requested. */
  public readonly namespace?: kplus.Namespace;

  constructor(
    scope: Construct,
    id: string,
    config: CsiSnapshotControllerConfig = {},
  ) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "kube-system";
    const releaseName = this.config.releaseName ?? "snapshot-controller";

    // kube-system is supplied by Kubernetes. A custom namespace, if selected,
    // remains part of the declarative object graph owned by this construct.
    if (namespaceName !== "kube-system") {
      this.namespace = this.createNamespace(namespaceName);
    }

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "snapshot-controller",
      releaseName,
      repo: this.config.repository ?? "https://piraeus.io/helm-charts/",
      version: this.config.version ?? "5.1.1",
      helmFlags: ["--include-crds"],
      defaultValues: {
        installCRDs: true,
        controller: {
          replicaCount: 2,
          args: {
            leaderElection: true,
            leaderElectionNamespace: "$(NAMESPACE)",
            httpEndpoint: ":8080",
            featureGates: "CSIVolumeGroupSnapshot=false",
          },
          pdb: { minAvailable: 1 },
          topologySpreadConstraints: [
            {
              maxSkew: 1,
              // Self-managed nodes are not guaranteed to carry a standard
              // topology zone label. Hostname spreading still prevents both
              // controller replicas from sharing a single node.
              topologyKey: "kubernetes.io/hostname",
              whenUnsatisfiable: "DoNotSchedule",
              labelSelector: {
                matchLabels: {
                  "app.kubernetes.io/instance": releaseName,
                  "app.kubernetes.io/name": "snapshot-controller",
                },
              },
            },
          ],
          resources: {
            requests: { cpu: "10m", memory: "32Mi" },
            limits: { memory: "128Mi" },
          },
        },
        // The chart otherwise emits an unused randomly generated TLS Secret,
        // which creates a perpetual Argo CD diff when the webhook is disabled.
        webhook: { enabled: false, tls: { autogenerate: false } },
      },
      values: this.config.values,
    });

    // Chart 5.1.1 ships optional VolumeGroupSnapshot CRDs even while its
    // feature gate is disabled. They reference the disabled conversion webhook,
    // so keep only the stable VolumeSnapshot API that this construct supports.
    for (const resource of this.helm.apiObjects) {
      if (
        resource.kind === "CustomResourceDefinition" &&
        resource.name.endsWith(".groupsnapshot.storage.k8s.io")
      ) {
        this.helm.node.tryRemoveChild(resource.node.id);
      }
    }
  }
}
