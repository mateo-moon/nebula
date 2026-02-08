/**
 * ConfidentialContainers - Deploy Confidential Containers runtime on Kubernetes
 *
 * Provides hardware-based isolation for container workloads using:
 * - AMD SEV-SNP (Secure Encrypted Virtualization - Secure Nested Paging)
 * - Intel TDX (Trust Domain Extensions)
 *
 * Creates RuntimeClasses for running pods in Trusted Execution Environments (TEEs).
 *
 * @example
 * ```typescript
 * import { ConfidentialContainers } from 'nebula/modules/k8s/confidential-containers';
 *
 * new ConfidentialContainers(chart, 'coco', {
 *   // Default configuration for AMD SEV-SNP
 * });
 * ```
 *
 * @see https://github.com/confidential-containers/charts
 */
import { Construct } from "constructs";
import { Helm } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import { deepmerge } from "deepmerge-ts";
import { BaseConstruct } from "../../../core";

/** Kubernetes distribution type */
export type K8sDistribution = "k8s" | "k3s" | "rke2" | "k0s" | "microk8s";

/** TEE (Trusted Execution Environment) shim configuration */
export interface TeeShimConfig {
  /** Enable AMD SEV-SNP shim (default: true on AMD systems) */
  snp?: boolean;
  /** Enable Intel TDX shim (default: true on Intel systems) */
  tdx?: boolean;
  /** Enable development/testing shim (default: false) */
  cocoDev?: boolean;
}

/** Custom containerd configuration */
export interface CustomContainerdConfig {
  /** Enable custom containerd installation */
  enabled: boolean;
  /** Tarball URL for single-architecture clusters */
  tarballUrl?: string;
  /** Tarball URLs for multi-architecture clusters */
  tarballUrls?: {
    amd64?: string;
    arm64?: string;
  };
  /** Installation path on host (default: /usr/local) */
  installPath?: string;
}

export interface ConfidentialContainersConfig {
  /** Namespace for the deployment (default: coco-system) */
  namespace?: string;
  /** Helm chart version (default: 0.18.0) */
  version?: string;
  /** Kubernetes distribution (default: k0s for k0smotron clusters) */
  k8sDistribution?: K8sDistribution;
  /** Node selector for targeting specific nodes */
  nodeSelector?: Record<string, string>;
  /** Enable debug logging (default: false) */
  debug?: boolean;
  /** TEE shim configuration */
  shims?: TeeShimConfig;
  /** Create RuntimeClass resources (default: true) */
  createRuntimeClasses?: boolean;
  /** Custom containerd configuration */
  customContainerd?: CustomContainerdConfig;
  /** Image pull policy (default: IfNotPresent) */
  imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
  /** Additional Helm values to merge with defaults */
  values?: Record<string, unknown>;
}

/**
 * RuntimeClass names created by the Confidential Containers Helm chart.
 * Use these when specifying runtimeClassName in Pod specs.
 */
export const RuntimeClasses = {
  /** AMD SEV-SNP protection */
  AMD_SEV_SNP: "kata-qemu-snp",
  /** AMD SEV-SNP with NVIDIA GPU support */
  AMD_SEV_SNP_GPU: "kata-qemu-nvidia-gpu-snp",
  /** Intel TDX protection */
  INTEL_TDX: "kata-qemu-tdx",
  /** Development/testing runtime (no hardware TEE) */
  COCO_DEV: "kata-qemu-coco-dev",
} as const;

export class ConfidentialContainers extends BaseConstruct<ConfidentialContainersConfig> {
  public readonly namespace: kplus.Namespace;
  public readonly helm: Helm;

  constructor(
    scope: Construct,
    id: string,
    config: ConfidentialContainersConfig = {},
  ) {
    super(scope, id, config);

    const namespaceName = config.namespace ?? "coco-system";

    // Create namespace
    this.namespace = new kplus.Namespace(this, "namespace", {
      metadata: { name: namespaceName },
    });

    // Build shims configuration — map simple boolean flags to chart's expected structure.
    // The chart expects shims.<name>.enabled (with full objects), not simple booleans.
    // We selectively enable/disable the shims the user cares about.
    const shimsOverrides: Record<string, unknown> = {};
    if (config.shims) {
      const snp = config.shims.snp ?? true;
      const tdx = config.shims.tdx ?? false;
      const cocoDev = config.shims.cocoDev ?? false;

      if (!snp) {
        shimsOverrides["qemu-snp"] = { enabled: false };
        shimsOverrides["qemu-nvidia-gpu-snp"] = { enabled: false };
      }
      if (!tdx) {
        shimsOverrides["qemu-tdx"] = { enabled: false };
        shimsOverrides["qemu-nvidia-gpu-tdx"] = { enabled: false };
      }
      if (!cocoDev) {
        shimsOverrides["qemu-coco-dev"] = { enabled: false };
        shimsOverrides["qemu-coco-dev-runtime-rs"] = { enabled: false };
      }
    }

    // Build subchart values (kata-as-coco-runtime is the subchart alias for kata-deploy)
    const subchartValues: Record<string, unknown> = {
      imagePullPolicy: config.imagePullPolicy ?? "IfNotPresent",
      k8sDistribution: config.k8sDistribution ?? "k0s",
      debug: config.debug ?? false,
      runtimeClasses: {
        enabled: config.createRuntimeClasses !== false,
      },
    };

    // Add node selector if specified
    if (config.nodeSelector) {
      subchartValues.nodeSelector = config.nodeSelector;
    }

    // Add shims overrides if specified
    if (Object.keys(shimsOverrides).length > 0) {
      subchartValues.shims = shimsOverrides;
    }

    // Parent chart values
    const defaultValues: Record<string, unknown> = {
      "kata-as-coco-runtime": subchartValues,
    };

    // Add custom containerd if specified (parent chart level)
    if (config.customContainerd?.enabled) {
      defaultValues.customContainerd = {
        enabled: true,
        tarballUrl: config.customContainerd.tarballUrl,
        tarballUrls: config.customContainerd.tarballUrls,
        installPath: config.customContainerd.installPath ?? "/usr/local",
      };
    }

    const chartValues = deepmerge(defaultValues, config.values ?? {});

    // Deploy Helm chart
    this.helm = new Helm(this, "helm", {
      chart:
        "oci://ghcr.io/confidential-containers/charts/confidential-containers",
      releaseName: "confidential-containers",
      version: config.version ?? "0.18.0",
      namespace: namespaceName,
      values: chartValues,
    });
  }
}

export default ConfidentialContainers;
