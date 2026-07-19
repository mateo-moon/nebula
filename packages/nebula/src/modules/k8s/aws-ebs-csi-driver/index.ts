/**
 * AwsEbsCsiDriver - the AWS EBS CSI driver for dynamic EBS volume provisioning.
 *
 * Deploys the upstream kubernetes-sigs `aws-ebs-csi-driver` Helm chart KEYLESS:
 * this targets self-managed k0s clusters (not EKS), so there is no IRSA — the
 * controller authenticates to AWS via the NODE INSTANCE PROFILE over IMDS (the
 * shared node role created by {@link AwsIam} with `controllerPolicies: true`
 * carries `ec2:*`, which covers every EBS CSI controller action). The
 * ServiceAccounts are therefore created WITHOUT an `eks.amazonaws.com/role-arn`
 * annotation, and `region`/`clusterName` are pinned explicitly because the
 * non-EKS SDK path cannot self-derive them from the cluster.
 *
 * Also renders an optional gp3 StorageClass (encrypted, WaitForFirstConsumer)
 * that can be marked as the cluster default.
 *
 * @example
 * ```typescript
 * import { AwsEbsCsiDriver } from 'nebula/modules/k8s/aws-ebs-csi-driver';
 *
 * new AwsEbsCsiDriver(chart, 'aws-ebs-csi-driver', {
 *   region: 'eu-central-1',
 *   clusterName: 'nucon-aws',
 *   storageClass: { isDefault: true },
 * });
 * ```
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { KubeStorageClass } from "cdk8s-plus-33/lib/imports/k8s";
import { HelmModule } from "../../../core";

/** gp3 StorageClass configuration */
export interface AwsEbsCsiDriverStorageClassConfig {
  /** StorageClass name (defaults to gp3) */
  name?: string;
  /**
   * Mark this StorageClass as the cluster DEFAULT via the
   * `storageclass.kubernetes.io/is-default-class` annotation.
   * @default false
   */
  isDefault?: boolean;
  /** Reclaim policy (defaults to Delete) */
  reclaimPolicy?: string;
  /** Allow volume expansion (defaults to true) */
  allowVolumeExpansion?: boolean;
  /**
   * KMS key id/ARN/alias for volume encryption. When unset, encrypted volumes
   * use the account's default `aws/ebs` key.
   */
  kmsKeyId?: string;
  /** Extra StorageClass parameters merged over the defaults (type=gp3, encrypted=true) */
  parameters?: Record<string, string>;
}

export interface AwsEbsCsiDriverConfig {
  /** Namespace (defaults to kube-system, the chart's upstream default) */
  namespace?: string;
  /** Helm chart version (defaults to 2.62.0) */
  version?: string;
  /**
   * AWS region the cluster runs in (e.g. `eu-central-1`). Pinned explicitly
   * because on non-EKS clusters the controller cannot derive it from the
   * cluster; without it the SDK falls back to IMDS, which is fine on EC2 but
   * makes the render environment-dependent.
   */
  region: string;
  /**
   * Cluster name used to tag created volumes/snapshots
   * (`kubernetes.io/cluster/<name>`), mapped to the chart's
   * `controller.k8sTagClusterId`.
   */
  clusterName?: string;
  /**
   * gp3 StorageClass rendered next to the driver. Created by default; pass
   * `false` to skip it, or an object to customize name/default-class/etc.
   * @default {}
   */
  storageClass?: AwsEbsCsiDriverStorageClassConfig | false;
  /** Additional Helm values */
  values?: Record<string, unknown>;
}

export class AwsEbsCsiDriver extends HelmModule<AwsEbsCsiDriverConfig> {
  public readonly helm: Helm;
  public readonly namespace?: kplus.Namespace;
  /** Name of the rendered gp3 StorageClass (undefined when storageClass: false) */
  public readonly storageClassName?: string;

  constructor(scope: Construct, id: string, config: AwsEbsCsiDriverConfig) {
    super(scope, id, config);

    const namespaceName = this.config.namespace ?? "kube-system";

    // Create namespace if not kube-system (kube-system already exists)
    if (namespaceName !== "kube-system") {
      this.namespace = this.createNamespace(namespaceName);
    }

    // --- Helm chart ---

    const defaultValues: Record<string, unknown> = {
      controller: {
        // Explicit region — the non-EKS SDK path cannot self-derive it.
        region: this.config.region,
        ...(this.config.clusterName
          ? { k8sTagClusterId: this.config.clusterName }
          : {}),
        serviceAccount: {
          create: true,
          name: "ebs-csi-controller-sa",
          // No IRSA annotation (eks.amazonaws.com/role-arn): keyless auth via
          // the node instance profile (IMDS), not a web-identity role.
          annotations: {},
        },
      },
      node: {
        serviceAccount: {
          create: true,
          name: "ebs-csi-node-sa",
          annotations: {},
        },
      },
    };

    this.helm = this.createHelmRelease({
      namespace: namespaceName,
      chart: "aws-ebs-csi-driver",
      releaseName: "aws-ebs-csi-driver",
      repo: "https://kubernetes-sigs.github.io/aws-ebs-csi-driver",
      version: this.config.version ?? "2.62.0",
      defaultValues,
      values: this.config.values,
      // `helm template` omits CRDs by default; include any the chart ships.
      helmFlags: ["--include-crds"],
    });

    // --- gp3 StorageClass ---

    if (this.config.storageClass !== false) {
      const sc = this.config.storageClass ?? {};
      this.storageClassName = sc.name ?? "gp3";
      new KubeStorageClass(this, "storage-class", {
        metadata: {
          name: this.storageClassName,
          ...(sc.isDefault
            ? {
                annotations: {
                  "storageclass.kubernetes.io/is-default-class": "true",
                },
              }
            : {}),
        },
        provisioner: "ebs.csi.aws.com",
        allowVolumeExpansion: sc.allowVolumeExpansion ?? true,
        reclaimPolicy: sc.reclaimPolicy ?? "Delete",
        volumeBindingMode: "WaitForFirstConsumer",
        parameters: {
          type: "gp3",
          encrypted: "true",
          ...(sc.kmsKeyId ? { kmsKeyId: sc.kmsKeyId } : {}),
          ...sc.parameters,
        },
      });
    }
  }
}
