import { TerraformStack } from "cdktf";
import { Eks } from "@src/aws/eks";
import { Iam } from "@src/aws/iam";
import { Vpc } from "@src/aws/vpc";
import { Environment } from "@src/core";
import { WithAwsProvider } from "@src/core/decorators";

export interface AwsResources {
  vpc: Vpc;
  eks: Eks;
  iam: Iam;
}

export interface InfraConfig {
  aws?: boolean;
}

@WithAwsProvider()
export class Infra extends TerraformStack {
  public aws?: AwsResources;

  constructor(
    public readonly env: Environment,
    public readonly id: string,
    public readonly config: InfraConfig
  ) {
    super(env, id);
    
    this.init()
  }

  private init() {
    if (!this.config.aws) return;
    this.aws = {} as AwsResources;
    this.aws.vpc = new Vpc(this, `vpc`)
    this.aws.eks = new Eks(
      this,
      `eks`,
      this.aws.vpc
    )
  }
}
