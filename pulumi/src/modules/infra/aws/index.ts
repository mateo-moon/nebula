import { Iam } from './iam';
import type { IamConfig } from './iam';
import { Eks } from './eks';
import type { EksConfig } from './eks';
import { Vpc } from './vpc';
import type { VpcConfig } from './vpc';

export type AwsConfig = {
  iam: IamConfig;
  eks: EksConfig;
  vpc: VpcConfig;
};

export interface AwsOutput {
  vpcId?: any;
  privateSubnetIds?: any;
  publicSubnetIds?: any;
  eksClusterName?: any;
  kubeconfig?: any;
  sopsKeyArn?: any;
  sopsRoleArn?: any;
}

export class Aws {
  public readonly iam: Iam;
  public readonly eks: Eks;
  public readonly vpc: Vpc;
  constructor(name: string, config: AwsConfig) {
    this.vpc = new Vpc(name, config.vpc);
    this.iam = new Iam(name, config.iam);
    this.eks = new Eks(name, this.vpc, config.eks);
  }
  public get outputs(): AwsOutput {
    return {
      vpcId: this.vpc?.vpcId,
      privateSubnetIds: this.vpc?.privateSubnetIds,
      publicSubnetIds: this.vpc?.publicSubnetIds,
      eksClusterName: (this.eks?.cluster as any)?.core?.cluster?.name || (this.eks?.cluster as any)?.name,
      kubeconfig: this.eks?.kubeconfig,
      sopsKeyArn: this.iam?.sopsKey?.arn,
      sopsRoleArn: this.iam?.sopsRole?.arn,
    };
  }
}