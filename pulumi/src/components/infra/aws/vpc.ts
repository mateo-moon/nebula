import * as awsx from '@pulumi/awsx';
import * as pulumi from '@pulumi/pulumi';

export interface VpcConfig {
  name?: string;
  cidrBlock?: string;
  numberOfAvailabilityZones?: number;
}

export class Vpc {
  public readonly vpc: awsx.ec2.Vpc;
  public readonly vpcId: pulumi.Output<string>;
  public readonly privateSubnetIds: pulumi.Output<string[]>;
  public readonly publicSubnetIds: pulumi.Output<string[]>;

  constructor(name: string, config?: VpcConfig) {
    const clusterName = 'eks';
    const clusterTagKey = `kubernetes.io/cluster/${clusterName}`;

    this.vpc = new awsx.ec2.Vpc(name, {
      numberOfAvailabilityZones: config?.numberOfAvailabilityZones ?? 3,
      cidrBlock: config?.cidrBlock ?? '10.0.0.0/16',
      natGateways: { strategy: 'Single' },
      subnetSpecs: [
        {
          type: awsx.ec2.SubnetType.Private,
          name: 'private',
          cidrMask: 20,
          tags: {
            [clusterTagKey]: 'shared',
            'kubernetes.io/role/internal-elb': '1',
          },
        },
        {
          type: awsx.ec2.SubnetType.Public,
          name: 'public',
          cidrMask: 20,
          tags: {
            [clusterTagKey]: 'shared',
            'kubernetes.io/role/elb': '1',
          },
        },
      ],
      tags: {
        Name: config?.name ?? name,
      },
    });

    this.vpcId = this.vpc.vpcId;
    this.privateSubnetIds = pulumi.output(this.vpc.privateSubnetIds);
    this.publicSubnetIds = pulumi.output(this.vpc.publicSubnetIds);
  }
}

// legacy CDKTF code removed
