import { Construct } from "constructs";
import { Infra } from "@src/components/infra";

export interface IamConfig {
}

export class Iam extends Construct {

  constructor(
    public readonly scope: Infra,
    public readonly id: string, 
    public readonly config: IamConfig
  ) {
    super(scope, id);
  }
}
