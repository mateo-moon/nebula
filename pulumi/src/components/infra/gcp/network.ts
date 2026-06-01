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
  public readonly podsRangeName: string;
  public readonly servicesRangeName: string;

  constructor(name: string, args?: NetworkConfig, opts?: pulumi.ComponentResourceOptions) {
    super('gcpNetwork', name, {}, opts);
    
    const netName = args?.networkName ?? name;
    this.network = new gcp.compute.Network(netName, {
      name: netName,
      autoCreateSubnetworks: false,
    }, { parent: this });

    const subnetName = args?.subnetName ?? `${name}-subnet`;
    const ipCidr = args?.cidr ?? args?.cidrBlocks?.[0] ?? '10.10.0.0/16';
    const podsRangeName = args?.podsRangeName ?? `${subnetName}-pods`;
    const servicesRangeName = args?.servicesRangeName ?? `${subnetName}-services`;
    this.podsRangeName = podsRangeName;
    this.servicesRangeName = servicesRangeName;

    this.subnetwork = new gcp.compute.Subnetwork(subnetName, {
      name: subnetName,
      ipCidrRange: ipCidr,
      ...(args?.region ? { region: args.region } : {}),
      network: this.network.id,
      privateIpGoogleAccess: true,
      secondaryIpRanges: [
        ...(args?.podsSecondaryCidr ? [{
          ipCidrRange: args.podsSecondaryCidr,
          rangeName: podsRangeName,
        }] : []),
        ...(args?.servicesSecondaryCidr ? [{
          ipCidrRange: args.servicesSecondaryCidr,
          rangeName: servicesRangeName,
        }] : []),
      ],
    }, { parent: this });

    // Ensure TCP port 15150 is open on the VPC (ingress from anywhere) as requested
    // This rule applies to all instances in this network unless further scoped via targetTags.
    new gcp.compute.Firewall(`${netName}-allow-15150`, {
      name: `${netName}-allow-15150`,
      direction: 'INGRESS',
      network: this.network.id,
      sourceRanges: ['0.0.0.0/0'],
      allows: [{ protocol: 'tcp', ports: ['15150'] }],
      description: 'Allow TCP 15150',
    }, { parent: this, dependsOn: [this.network] });
    this.registerOutputs({
      networkId: this.network.id,
      subnetworkId: this.subnetwork.id,
      networkSelfLink: this.network.selfLink,
      subnetworkSelfLink: this.subnetwork.selfLink,
      podsRangeName: podsRangeName,
      servicesRangeName: servicesRangeName,
    });
  }
}


