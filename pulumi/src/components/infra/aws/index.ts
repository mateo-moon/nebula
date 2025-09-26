import { Iam, IamConfig } from './iam';
import { Eks, EksConfig } from './eks';
import { Vpc, VpcConfig } from './vpc';

export type AwsConfig = {
  iam: IamConfig;
  eks: EksConfig;
  vpc: VpcConfig;
};

export class Aws {
  public readonly iam: Iam;
  public readonly eks: Eks;
  public readonly vpc: Vpc;
  constructor(name: string, config: AwsConfig) {
    this.vpc = new Vpc(name, config.vpc);
    this.iam = new Iam(name, config.iam);
    this.eks = new Eks(name, this.vpc, config.eks);
  }
}