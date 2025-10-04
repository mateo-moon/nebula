import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface ConstellationGcpNetworkConfig {
  name?: string;
  region: string;
  ipCidrNodes?: string; // default 192.168.178.0/24
  ipCidrPods?: string;  // default 10.10.0.0/16
  ipCidrProxy?: string; // default 192.168.179.0/24
  ipCidrIlb?: string;   // default 192.168.180.0/24
  internalLoadBalancer?: boolean; // default false
  mtu?: number; // default 8896
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
  public readonly proxySubnetwork?: gcp.compute.Subnetwork;
  public readonly ilbSubnetwork?: gcp.compute.Subnetwork;
  public readonly podsRangeName: pulumi.Output<string> | string;

  constructor(name: string, args: ConstellationGcpNetworkConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:gcp:Network', name, args, opts);

    const region = args.region;
    const ipCidrNodes = args.ipCidrNodes || '192.168.178.0/24';
    const ipCidrPods = args.ipCidrPods || '10.10.0.0/16';
    const ipCidrProxy = args.ipCidrProxy || '192.168.179.0/24';
    const ipCidrIlb = args.ipCidrIlb || '192.168.180.0/24';
    const internalLb = args.internalLoadBalancer === true;
    const mtu = args.mtu ?? 8896;

    const suffix = stableShortHash([region, ipCidrNodes, ipCidrPods, ipCidrProxy, ipCidrIlb].join('|'));
    const baseName = `${args.name || name}-${suffix}`;

    this.network = new gcp.compute.Network(baseName, {
      name: baseName,
      description: 'Constellation VPC network',
      autoCreateSubnetworks: false,
      mtu,
    }, { parent: this });

    const podsRangeName = baseName; // mirror TF: secondary range name == local.name
    this.podsRangeName = podsRangeName;

    this.nodesSubnetwork = new gcp.compute.Subnetwork(baseName, {
      name: baseName,
      description: 'Constellation VPC subnetwork',
      region,
      network: this.network.id,
      ipCidrRange: ipCidrNodes,
      secondaryIpRanges: [{
        rangeName: podsRangeName,
        ipCidrRange: ipCidrPods,
      }],
    }, { parent: this });

    if (internalLb) {
      const proxyName = `${baseName}-proxy`;
      this.proxySubnetwork = new gcp.compute.Subnetwork(proxyName, {
        name: proxyName,
        region,
        ipCidrRange: ipCidrProxy,
        purpose: 'REGIONAL_MANAGED_PROXY',
        role: 'ACTIVE',
        network: this.network.id,
      }, { parent: this });

      const ilbName = `${baseName}-ilb`;
      this.ilbSubnetwork = new gcp.compute.Subnetwork(ilbName, {
        name: ilbName,
        region,
        ipCidrRange: ipCidrIlb,
        network: this.network.id,
      }, { parent: this, dependsOn: [this.proxySubnetwork] });
    }

    this.registerOutputs({
      networkId: this.network.id,
      networkSelfLink: this.network.selfLink,
      nodesSubnetworkId: this.nodesSubnetwork.id,
      nodesSubnetworkSelfLink: this.nodesSubnetwork.selfLink,
      podsRangeName,
      proxySubnetworkId: this.proxySubnetwork?.id,
      ilbSubnetworkId: this.ilbSubnetwork?.id,
    });
  }
}


