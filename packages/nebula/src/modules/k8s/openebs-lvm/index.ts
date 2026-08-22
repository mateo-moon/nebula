/**
 * OpenEbsLvm - OpenEBS LocalPV-LVM: PVC semantics over a node-local LVM VG.
 *
 * Deploys the `lvm-localpv` Helm chart and typed StorageClasses over volume
 * groups that already exist on the nodes. LVM is kernel-native: no dataplane
 * component, no replication — the module's job is dynamic provisioning,
 * WaitForFirstConsumer binding and online expansion (lvextend + fs resize) on
 * top of storage some other layer made durable (a cloud data volume turned
 * into a VG at boot, a baremetal partition at host enrollment). Creating the
 * VG is deliberately OUT of scope: it is host provisioning, not cluster
 * state.
 *
 * No snapshot support, by construction: the chart's bundled external
 * snapshot-CRD manifests render CORRUPTED (long description strings mangled
 * into schema keys — the apiserver rejects them outright), so the CRDs are
 * disabled and, since the chart has no container toggle, the csi-snapshotter
 * and snapshot-controller containers are removed from the rendered controller
 * Deployment by name. Revisit if a chart release fixes the CRD manifests.
 *
 * The chart's templates also do not stamp `.Release.Namespace` onto their
 * namespaced objects; under an Application with no destination namespace
 * ArgoCD rejects those outright ("Namespace ... is missing"), so the module
 * stamps the namespace itself.
 *
 * @example
 * ```typescript
 * new OpenEbsLvm(chart, "openebs", {
 *   kubeletDir: "/var/lib/k0s/kubelet/",
 *   storageClasses: [{ name: "openebs-lvm", vgName: "toolnode-vg" }],
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm, JsonPatch } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { KubeStorageClass } from "cdk8s-plus-33/lib/imports/k8s";
import { HelmModule, Toleration } from "../../../core";

/** One StorageClass over one node-local volume group. */
export interface OpenEbsLvmStorageClass {
  /** StorageClass name, e.g. "openebs-lvm". */
  name: string;
  /** LVM volume group the LVs are carved from (must pre-exist on the nodes). */
  vgName: string;
  /**
   * Mark as the cluster default StorageClass (defaults to false — consumers
   * usually opt in by name, since LocalPV pins each PV to its node).
   */
  default?: boolean;
  /** Filesystem for new LVs (defaults to ext4). */
  fsType?: string;
  /** Reclaim policy (defaults to Delete). */
  reclaimPolicy?: string;
}

export interface OpenEbsLvmConfig {
  /** Namespace (defaults to "openebs"). */
  namespace?: string;
  /** Helm chart version (defaults to 1.9.1 — the version validated live). */
  version?: string;
  /** Helm repository URL. */
  repository?: string;
  /**
   * Kubelet root path, mapped to the chart's `lvmNode.kubeletDir` (drives the
   * node driver's registration/plugin hostPath mounts). Defaults to the chart
   * default `/var/lib/kubelet/`; k0s uses `/var/lib/k0s/kubelet/`. Wrong or
   * missing on k0s, the driver registers against a socket the kubelet never
   * reads and every mount fails.
   */
  kubeletDir?: string;
  /**
   * Tolerations for the node DaemonSet — required when the VG-bearing nodes
   * are tainted (the DaemonSet is idle-but-harmless on nodes without a VG,
   * and must be present on every node that has one).
   */
  tolerations?: Toleration[];
  /** StorageClasses to emit (none by default — the chart ships none either). */
  storageClasses?: OpenEbsLvmStorageClass[];
  /** Additional Helm values (deep-merged over the module defaults). */
  values?: Record<string, unknown>;
}

export class OpenEbsLvm extends HelmModule<OpenEbsLvmConfig> {
  public readonly helm: Helm;
  public readonly namespace: kplus.Namespace;

  constructor(scope: Construct, id: string, config: OpenEbsLvmConfig = {}) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "openebs";
    this.namespace = this.createNamespace(namespaceName);

    const defaultValues: Record<string, unknown> = {
      lvmNode: {
        ...(this.config.kubeletDir
          ? { kubeletDir: this.config.kubeletDir }
          : {}),
        ...(this.config.tolerations
          ? { tolerations: this.config.tolerations }
          : {}),
      },
      // See the module doc: the bundled external snapshot CRDs render
      // corrupted, and the snapshot containers are stripped below.
      crds: { csi: { volumeSnapshots: { enabled: false } } },
      analytics: { enabled: false },
      // Scheduler-honest sizing so the controller never runs BestEffort.
      lvmController: {
        resources: {
          requests: { cpu: "10m", memory: "64Mi" },
          limits: { memory: "128Mi" },
        },
      },
    };

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "lvm-localpv",
      releaseName: "openebs-lvm",
      repo: this.config.repository ?? "https://openebs.github.io/lvm-localpv",
      version: this.config.version ?? "1.9.1",
      defaultValues,
      values: this.config.values,
    });

    // Post-render chart-bug repairs (see the module doc for both).
    const NAMESPACED = new Set([
      "ServiceAccount",
      "Service",
      "DaemonSet",
      "Deployment",
      "ConfigMap",
      "Secret",
      "Role",
      "RoleBinding",
    ]);
    const SNAPSHOT_CONTAINERS = new Set([
      "csi-snapshotter",
      "snapshot-controller",
    ]);
    this.helm.apiObjects.forEach((o) => {
      if (NAMESPACED.has(o.kind)) {
        o.addJsonPatch(JsonPatch.add("/metadata/namespace", namespaceName));
      }
      if (o.kind === "Deployment") {
        // Located by NAME, removed by index in descending order so positions
        // stay valid — chart upgrades reorder containers without notice.
        const rendered = o.toJson() as {
          spec?: {
            template?: { spec?: { containers?: Array<{ name?: string }> } };
          };
        };
        const containers = rendered.spec?.template?.spec?.containers ?? [];
        containers
          .map((c, i) => ({ name: c.name ?? "", i }))
          .filter((c) => SNAPSHOT_CONTAINERS.has(c.name))
          .sort((a, b) => b.i - a.i)
          .forEach((c) =>
            o.addJsonPatch(
              JsonPatch.remove(`/spec/template/spec/containers/${c.i}`),
            ),
          );
      }
    });

    for (const sc of this.config.storageClasses ?? []) {
      new KubeStorageClass(this, `sc-${sc.name}`, {
        metadata: {
          name: sc.name,
          ...(sc.default
            ? {
                annotations: {
                  "storageclass.kubernetes.io/is-default-class": "true",
                },
              }
            : {}),
        },
        provisioner: "local.csi.openebs.io",
        parameters: {
          storage: "lvm",
          volgroup: sc.vgName,
          fsType: sc.fsType ?? "ext4",
        },
        // WaitForFirstConsumer: the LV can only exist on one node, so binding
        // must follow scheduling, not precede it.
        volumeBindingMode: "WaitForFirstConsumer",
        allowVolumeExpansion: true,
        reclaimPolicy: sc.reclaimPolicy ?? "Delete",
      });
    }
  }
}
