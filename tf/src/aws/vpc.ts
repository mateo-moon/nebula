import { Construct } from 'constructs';
import { Vpc as AwsVpc, VpcConfig as AwsVpcConfig } from "@module/terraform-aws-modules/aws/vpc"
import { DataAwsAvailabilityZones } from "@provider/aws/data-aws-availability-zones"
import { Infra } from '@src/components/infra';

export interface VpcConfig extends AwsVpcConfig {}

export class Vpc extends Construct {
  public vpc: AwsVpc

  constructor(scope: Infra, id: string) {
    super(scope, id);

    const clusterName = `${scope.node.getContext('project')}-${scope.env.id}`

    const allAvailabilityZones = new DataAwsAvailabilityZones(
      this,
      "all-availability-zones",
      {}
    ).names;

    // Create VPC
    this.vpc = new AwsVpc(this, "vpc", {
      name: "vpc",
      cidr: "10.0.0.0/16",
      azs: allAvailabilityZones,
      privateSubnets: ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"],
      publicSubnets: ["10.0.4.0/24", "10.0.5.0/24", "10.0.6.0/24"],
      enableNatGateway: true,
      enableDnsHostnames: true,
      mapPublicIpOnLaunch: true,
      tags: {
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
      },
      publicSubnetTags: {
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        "kubernetes.io/role/elb": "1",
      },
      privateSubnetTags: {
        [`kubernetes.io/cluster/${clusterName}`]: "shared",
        "kubernetes.io/role/internal-elb": "1",
      },
    });
  }
}
