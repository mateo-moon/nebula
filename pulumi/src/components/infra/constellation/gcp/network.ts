import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import { defaultValues } from '../index';

export interface ConstellationGcpNetworkConfig {
  name?: string;
  region: string;
  ipCidrNodes?: string; // default 192.168.178.0/24
  ipCidrPods?: string;  // default 10.10.0.0/16
  mtu?: number; // default 8896
  uid?: pulumi.Input<string>;
}

function stableShortHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return ('0000000' + hash.toString(16)).slice(-8);
}

export class ConstellationGcpNetwork extends pulumi.ComponentResource {
  public readonly network: gcp.compute.Network;
  public readonly nodesSubnetwork: gcp.compute.Subnetwork;
  public readonly podsRangeName: pulumi.Output<string> | string;

  constructor(name: string, args: ConstellationGcpNetworkConfig, opts?: pulumi.ComponentResourceOptions) {
    super('gcpNetwork', name, args, opts);

    const region = args.region;
    const ipCidrNodes = args.ipCidrNodes || defaultValues.gcp?.network?.ipCidrNodes!;
    const ipCidrPods = args.ipCidrPods || defaultValues.gcp?.network?.ipCidrPods!;
    const mtu = args.mtu ?? defaultValues.gcp?.network?.mtu!;

    const suffix = stableShortHash([region, ipCidrNodes, ipCidrPods].join('|'));
    const baseName = args.uid ? pulumi.interpolate`${args.name || name}-${args.uid}` : `${args.name || name}-${suffix}`;

    this.network = new gcp.compute.Network(`${name}-network`, {
      name: baseName,
      description: 'Constellation VPC network',
      autoCreateSubnetworks: false,
      mtu,
    }, { parent: this });

    const podsRangeName = baseName; // mirror TF: secondary range name == local.name
    this.podsRangeName = podsRangeName;

    this.nodesSubnetwork = new gcp.compute.Subnetwork(`${name}-subnet`, {
      name: baseName,
      description: 'Constellation VPC subnetwork',
      region,
      network: this.network.id,
      ipCidrRange: ipCidrNodes,
      secondaryIpRanges: [{
        rangeName: podsRangeName,
        ipCidrRange: ipCidrPods,
      }],
    }, { 
      parent: this,
      deleteBeforeReplace: true, // Delete subnetwork before replacement to avoid "resource in use" errors
    });

    this.registerOutputs({
      networkId: this.network.id,
      networkSelfLink: this.network.selfLink,
      nodesSubnetworkId: this.nodesSubnetwork.id,
      nodesSubnetworkSelfLink: this.nodesSubnetwork.selfLink,
      podsRangeName,
    });
  }
}


