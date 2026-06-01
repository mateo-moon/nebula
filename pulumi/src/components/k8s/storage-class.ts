import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

export interface StorageClassConfig {
  /** Storage class name (default: "standard") */
  name?: string;
  /** Storage provisioner (default: "kubernetes.io/gce-pd" for GCP) */
  provisioner?: string;
  /** Storage parameters */
  parameters?: Record<string, string>;
  /** Volume binding mode (default: "WaitForFirstConsumer") */
  volumeBindingMode?: "Immediate" | "WaitForFirstConsumer";
  /** Reclaim policy (default: "Delete") */
  reclaimPolicy?: "Retain" | "Delete";
  /** Allow volume expansion (default: true) */
  allowVolumeExpansion?: boolean;
  /** Default storage class (default: true) */
  isDefault?: boolean;
}

export class StorageClass extends pulumi.ComponentResource {
  public readonly storageClass: k8s.storage.v1.StorageClass;

  constructor(
    name: string,
    args: StorageClassConfig,
    opts?: pulumi.ComponentResourceOptions
  ) {
    super('storage-class', name, args, opts);

    const storageClassName = args.name || "standard";
    const provisioner = args.provisioner || "kubernetes.io/gce-pd";
    const volumeBindingMode = args.volumeBindingMode || "WaitForFirstConsumer";
    const reclaimPolicy = args.reclaimPolicy || "Delete";
    const allowVolumeExpansion = args.allowVolumeExpansion !== false;
    const isDefault = args.isDefault !== false;

    // Default parameters for GCP
    const defaultParameters: Record<string, string> = {
      type: "pd-standard",
      "replication-type": "none",
    };

    // Merge with provided parameters
    const parameters = { ...defaultParameters, ...args.parameters };

    // Annotations for default storage class
    const annotations: Record<string, string> = {};
    if (isDefault) {
      annotations["storageclass.kubernetes.io/is-default-class"] = "true";
    }

    this.storageClass = new k8s.storage.v1.StorageClass(
      storageClassName,
      {
        metadata: {
          name: storageClassName,
          annotations,
        },
        provisioner,
        parameters,
        volumeBindingMode,
        reclaimPolicy,
        allowVolumeExpansion,
      },
      { parent: this }
    );
  }
}
