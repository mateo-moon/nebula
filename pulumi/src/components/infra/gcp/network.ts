import * as gcp from '@pulumi/gcp';
import * as pulumi from '@pulumi/pulumi';

export interface NetworkConfig {
  name?: string;
  cidrBlocks?: string[]; // deprecated in favor of cidr
  cidr?: string; // e.g., "10.10.0.0/16"
  region?: string;
  podsSecondaryCidr?: string; // e.g., "10.20.0.0/16"
  podsRangeName?: string;     // e.g., "gcp-subnet-pods"
  servicesSecondaryCidr?: string; // e.g., "10.30.0.0/16"
  servicesRangeName?: string;     // e.g., "gcp-subnet-services"
  networkName?: string; // override GCP network name
  subnetName?: string;  // override GCP subnet name
}

export class Network extends pulumi.ComponentResource {
  public readonly network: gcp.compute.Network;
  public readonly subnetwork: gcp.compute.Subnetwork;
  public readonly podsRangeName?: string;
  public readonly servicesRangeName?: string;

  constructor(name: string, config?: NetworkConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:gcp:Network', name, {}, opts);
    const netName = config?.networkName ?? name;
    this.network = new gcp.compute.Network(netName, {
      name: netName,
      autoCreateSubnetworks: false,
    }, { parent: this });

    const subnetName = config?.subnetName ?? `${name}-subnet`;
    const ipCidr = config?.cidr ?? config?.cidrBlocks?.[0] ?? '10.10.0.0/16';
    const podsRangeName = config?.podsRangeName ?? `${subnetName}-pods`;
    const servicesRangeName = config?.servicesRangeName ?? `${subnetName}-services`;
    this.podsRangeName = config?.podsSecondaryCidr ? podsRangeName : undefined;
    this.servicesRangeName = config?.servicesSecondaryCidr ? servicesRangeName : undefined;

    this.subnetwork = new gcp.compute.Subnetwork(subnetName, {
      name: subnetName,
      ipCidrRange: ipCidr,
      region: config?.region,
      network: this.network.id,
      privateIpGoogleAccess: true,
      secondaryIpRanges: [
        ...(config?.podsSecondaryCidr ? [{
          ipCidrRange: config.podsSecondaryCidr,
          rangeName: podsRangeName,
        }] : []),
        ...(config?.servicesSecondaryCidr ? [{
          ipCidrRange: config.servicesSecondaryCidr,
          rangeName: servicesRangeName,
        }] : []),
      ],
    }, { parent: this });
    this.registerOutputs({
      networkId: this.network.id,
      subnetworkId: this.subnetwork.id,
      podsRangeName: this.podsRangeName,
      servicesRangeName: this.servicesRangeName,
    });
  }
}


