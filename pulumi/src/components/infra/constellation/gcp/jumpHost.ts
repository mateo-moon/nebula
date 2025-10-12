import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';

export interface JumpHostConfig {
  baseName: string;
  zone: string;
  subnetwork: pulumi.Input<string>;
  labels?: Record<string, string>;
  lbInternalIp?: pulumi.Input<string>;
  ports?: number[];
}

export class JumpHost extends pulumi.ComponentResource {
  public readonly instance: gcp.compute.Instance;

  constructor(name: string, args: JumpHostConfig, opts?: pulumi.ComponentResourceOptions) {
    super('jumpHost', name, args, opts);

    const instanceArgs: any = {
      name: `${args.baseName}-jump`,
      zone: args.zone,
      machineType: 'e2-micro',
      bootDisk: { initializeParams: { image: 'projects/debian-cloud/global/images/family/debian-12' } },
      networkInterfaces: [{ subnetwork: args.subnetwork, accessConfigs: [{}] }],
      ...(args.labels ? { labels: args.labels } : {}),
      metadata: args.lbInternalIp ? { 'lb-internal-ip': args.lbInternalIp as any } : undefined,
      tags: ['jump-host'],
    };
    this.instance = new gcp.compute.Instance(`${args.baseName}-jump`, instanceArgs, { parent: this });

    this.registerOutputs({ ip: this.instance.networkInterfaces.apply(nis => nis?.[0]?.accessConfigs?.[0]?.natIp) });
  }
}


