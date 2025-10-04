import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface AddressesConfig {
  name: string; // baseName with suffix
  region: string;
  internalLoadBalancer?: boolean;
  ilbSubnetworkId?: pulumi.Input<string>;
}

export class Addresses extends pulumi.ComponentResource {
  public readonly internalAddress?: gcp.compute.Address;
  public readonly globalAddress?: gcp.compute.Address;

  constructor(name: string, args: AddressesConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:constellation:gcp:Addresses', name, args, opts);

    if (args.internalLoadBalancer) {
      const addrArgs: any = {
        name: args.name,
        region: args.region,
        purpose: 'SHARED_LOADBALANCER_VIP',
        addressType: 'INTERNAL',
      };
      if (args.ilbSubnetworkId) addrArgs.subnetwork = args.ilbSubnetworkId;
      this.internalAddress = new gcp.compute.Address(args.name, addrArgs, { parent: this });
    } else {
      // Use a regional external address for external Network TCP/UDP LB
      this.globalAddress = new gcp.compute.Address(args.name, {
        name: args.name,
        region: args.region,
        addressType: 'EXTERNAL',
      }, { parent: this });
    }

    this.registerOutputs({
      internalAddress: this.internalAddress?.address,
      globalAddress: this.globalAddress?.address,
    });
  }
}


