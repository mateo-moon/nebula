import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface AddressesConfig {
  name: string; // baseName with suffix
  region: string;
  uid?: pulumi.Input<string>; // Constellation cluster UID
  labels?: Record<string, string>;
}

export class Addresses extends pulumi.ComponentResource {
  public readonly globalAddress: gcp.compute.GlobalAddress;

  constructor(name: string, args: AddressesConfig, opts?: pulumi.ComponentResourceOptions) {
    super('addresses', name, args, opts);

    // Use a global external address for Global TCP Proxy LB
    const addressName = args.uid ? pulumi.interpolate`${args.name}-${args.uid}` : args.name;
    const addressArgs: any = {
      name: addressName,
    };
    
    // Add Constellation UID label if provided
    if (args.uid) {
      addressArgs.labels = {
        'constellation-uid': args.uid,
        ...(args.labels || {}),
      };
    } else if (args.labels) {
      addressArgs.labels = args.labels;
    }
    
    this.globalAddress = new gcp.compute.GlobalAddress(args.name, addressArgs, { parent: this });

    this.registerOutputs({
      globalAddress: this.globalAddress.address,
    });
  }
}


