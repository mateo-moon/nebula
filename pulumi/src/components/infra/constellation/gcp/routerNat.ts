import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface RouterNatConfig {
  name: string;
  region: string;
  networkId: pulumi.Input<string>;
  uid?: pulumi.Input<string>;
}

export class RouterNat extends pulumi.ComponentResource {
  public readonly router: gcp.compute.Router;
  public readonly nat: gcp.compute.RouterNat;

  constructor(name: string, args: RouterNatConfig, opts?: pulumi.ComponentResourceOptions) {
    super('routerNat', name, args, opts);

    const resourceName = args.uid ? pulumi.interpolate`${args.name}-${args.uid}` : args.name;

    this.router = new gcp.compute.Router(args.name, {
      name: resourceName,
      description: 'Constellation VPC router',
      region: args.region,
      network: args.networkId,
    }, { parent: this });

    this.nat = new gcp.compute.RouterNat(args.name, {
      name: resourceName,
      router: this.router.name,
      region: args.region,
      natIpAllocateOption: 'AUTO_ONLY',
      sourceSubnetworkIpRangesToNat: 'ALL_SUBNETWORKS_ALL_IP_RANGES',
    }, { parent: this });

    this.registerOutputs({
      routerName: this.router.name,
      natName: this.nat.name,
    });
  }
}


