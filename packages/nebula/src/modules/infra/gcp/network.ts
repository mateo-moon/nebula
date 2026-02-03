import { Construct } from 'constructs';
import {
  Network as CpNetwork,
  NetworkSpecDeletionPolicy,
  Subnetwork as CpSubnetwork,
  SubnetworkSpecDeletionPolicy,
} from '#imports/compute.gcp.upbound.io';

export interface NetworkConfig {
  /** Network name */
  name: string;
  /** GCP project ID */
  project: string;
  /** GCP region for the subnetwork */
  region: string;
  /** Primary CIDR block for the subnetwork (e.g., "10.10.0.0/16") */
  cidr: string;
  /** Secondary CIDR for pods (e.g., "10.20.0.0/16") */
  podsSecondaryCidr?: string;
  /** Name for the pods secondary range */
  podsRangeName?: string;
  /** Secondary CIDR for services (e.g., "10.30.0.0/16") */
  servicesSecondaryCidr?: string;
  /** Name for the services secondary range */
  servicesRangeName?: string;
  /** ProviderConfig name to use */
  providerConfigRef?: string;
  /** Deletion policy */
  deletionPolicy?: NetworkSpecDeletionPolicy;
}

export class Network extends Construct {
  public readonly network: CpNetwork;
  public readonly subnetwork: CpSubnetwork;
  public readonly podsRangeName: string;
  public readonly servicesRangeName: string;

  constructor(scope: Construct, id: string, config: NetworkConfig) {
    super(scope, id);

    const providerConfigRef = config.providerConfigRef ?? 'default';
    const networkDeletionPolicy = config.deletionPolicy ?? NetworkSpecDeletionPolicy.DELETE;
    const subnetworkDeletionPolicy = config.deletionPolicy 
      ? (config.deletionPolicy === NetworkSpecDeletionPolicy.ORPHAN 
          ? SubnetworkSpecDeletionPolicy.ORPHAN 
          : SubnetworkSpecDeletionPolicy.DELETE)
      : SubnetworkSpecDeletionPolicy.DELETE;

    // Create VPC Network
    this.network = new CpNetwork(this, 'network', {
      metadata: {
        name: config.name,
      },
      spec: {
        forProvider: {
          autoCreateSubnetworks: false,
          project: config.project,
        },
        providerConfigRef: {
          name: providerConfigRef,
        },
        deletionPolicy: networkDeletionPolicy,
      },
    });

    // Set up secondary ranges
    const subnetName = `${config.name}-subnet`;
    this.podsRangeName = config.podsRangeName ?? `${subnetName}-pods`;
    this.servicesRangeName = config.servicesRangeName ?? `${subnetName}-services`;

    const secondaryIpRanges: Array<{ ipCidrRange: string; rangeName: string }> = [];
    if (config.podsSecondaryCidr) {
      secondaryIpRanges.push({
        ipCidrRange: config.podsSecondaryCidr,
        rangeName: this.podsRangeName,
      });
    }
    if (config.servicesSecondaryCidr) {
      secondaryIpRanges.push({
        ipCidrRange: config.servicesSecondaryCidr,
        rangeName: this.servicesRangeName,
      });
    }

    // Create Subnetwork
    this.subnetwork = new CpSubnetwork(this, 'subnetwork', {
      metadata: {
        name: subnetName,
      },
      spec: {
        forProvider: {
          ipCidrRange: config.cidr,
          networkRef: {
            name: config.name,
          },
          privateIpGoogleAccess: true,
          project: config.project,
          region: config.region,
          ...(secondaryIpRanges.length > 0 ? { secondaryIpRange: secondaryIpRanges } : {}),
        },
        providerConfigRef: {
          name: providerConfigRef,
        },
        deletionPolicy: subnetworkDeletionPolicy,
      },
    });
  }
}
