import { Construct } from "constructs";
import { Network, NetworkConfig } from "./network";
import { Gke, GkeConfig, NodePoolConfig } from "./gke";
import { Iam, IamConfig, WorkloadIdentityConfig } from "./iam";
import { NetworkSpecDeletionPolicy } from "#imports/compute.gcp.upbound.io";
import { ClusterSpecDeletionPolicy } from "#imports/container.gcp.upbound.io";
import { ProjectIamMember } from "#imports/cloudplatform.gcp.upbound.io";
import { BaseConstruct } from "../../../core";

export { Network } from "./network";
export type { NetworkConfig } from "./network";
export { Gke } from "./gke";
export type { GkeConfig, NodePoolConfig, MasterAuthorizedNetwork } from "./gke";
export { Iam } from "./iam";
export type { IamConfig, WorkloadIdentityConfig } from "./iam";
export { NetworkSpecDeletionPolicy } from "#imports/compute.gcp.upbound.io";
export { ClusterSpecDeletionPolicy } from "#imports/container.gcp.upbound.io";

export interface GcpConfig {
  /** GCP project ID */
  project: string;
  /** GCP region */
  region: string;
  /** Network configuration */
  network: Omit<NetworkConfig, "name" | "project" | "region">;
  /** GKE configuration (name is optional, defaults to {id}-cluster) */
  gke: Omit<GkeConfig, "project" | "network"> & { name?: string };
  /** IAM configuration (optional) */
  iam?: Omit<IamConfig, "project" | "providerConfigRef" | "deletionPolicy">;
  /** ProviderConfig name to use for all resources */
  providerConfigRef?: string;
  /** Deletion policy for all resources */
  deletionPolicy?: NetworkSpecDeletionPolicy;
  /**
   * Grant Crossplane's GSA the roles/iam.serviceAccountAdmin role.
   *
   * This allows all modules to automatically create their own Workload Identity
   * IAM bindings without manual bootstrap steps.
   *
   * The GSA is assumed to be: crossplane-provider@{project}.iam.gserviceaccount.com
   *
   * @default true
   */
  enableCrossplaneIamAdmin?: boolean;
}

export class Gcp extends BaseConstruct<GcpConfig> {
  public readonly network: Network;
  public readonly gke: Gke;
  public readonly iam?: Iam;

  constructor(scope: Construct, id: string, config: GcpConfig) {
    super(scope, id, config);

    const providerConfigRef = this.config.providerConfigRef ?? "default";
    const networkDeletionPolicy =
      this.config.deletionPolicy ?? NetworkSpecDeletionPolicy.DELETE;
    const clusterDeletionPolicy = this.config.deletionPolicy
      ? this.config.deletionPolicy === NetworkSpecDeletionPolicy.ORPHAN
        ? ClusterSpecDeletionPolicy.ORPHAN
        : ClusterSpecDeletionPolicy.DELETE
      : ClusterSpecDeletionPolicy.DELETE;

    // Create Network
    this.network = new Network(this, "network", {
      name: `${id}-network`,
      project: this.config.project,
      region: this.config.region,
      cidr: this.config.network.cidr,
      podsSecondaryCidr: this.config.network.podsSecondaryCidr,
      podsRangeName: this.config.network.podsRangeName,
      servicesSecondaryCidr: this.config.network.servicesSecondaryCidr,
      servicesRangeName: this.config.network.servicesRangeName,
      providerConfigRef,
      deletionPolicy: networkDeletionPolicy,
    });

    // Create GKE Cluster
    this.gke = new Gke(this, "gke", {
      name: this.config.gke.name ?? `${id}-cluster`,
      project: this.config.project,
      location: this.config.gke.location,
      network: this.network,
      releaseChannel: this.config.gke.releaseChannel,
      deletionProtection: this.config.gke.deletionProtection,
      nodePools: this.config.gke.nodePools,
      createSystemNodePool: this.config.gke.createSystemNodePool,
      systemNodePoolConfig: this.config.gke.systemNodePoolConfig,
      masterAuthorizedNetworks: this.config.gke.masterAuthorizedNetworks,
      providerConfigRef,
      deletionPolicy: clusterDeletionPolicy,
    });

    // Create IAM resources (if configured)
    if (this.config.iam) {
      this.iam = new Iam(this, "iam", {
        project: this.config.project,
        externalDns: this.config.iam.externalDns,
        certManager: this.config.iam.certManager,
        providerConfigRef,
      });
    }

    // Grant Crossplane's GSA the IAM Admin role (enabled by default)
    // This allows all modules to create their own Workload Identity bindings
    const enableCrossplaneIamAdmin =
      this.config.enableCrossplaneIamAdmin !== false;
    if (enableCrossplaneIamAdmin) {
      const crossplaneGsa = `crossplane-provider@${this.config.project}.iam.gserviceaccount.com`;
      new ProjectIamMember(this, "crossplane-iam-admin", {
        metadata: {
          name: "crossplane-provider-iam-admin",
        },
        spec: {
          forProvider: {
            project: this.config.project,
            role: "roles/iam.serviceAccountAdmin",
            member: `serviceAccount:${crossplaneGsa}`,
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
        },
      });
    }
  }
}
