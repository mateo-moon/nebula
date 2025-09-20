import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Construct } from "constructs";
import { IamEksRole } from "../../.gen/modules/terraform-aws-modules/aws/iam/modules/iam-eks-role";
import { TerraformOutput, Token, Tokenization, TokenizedStringFragments } from 'cdktf';

type outputs = {
  /** Map of created IAM roles */
  iamRoles: { [key: string]: string }
}
interface Outputs {
  outputs?: outputs;
}

interface CreateIAMRoleForServiceAccountConfig {
  chart: string;
  chartDir: string;
  context: string;
}

export class CreateIAMRoleForServiceAccount
  extends Construct
  implements CreateIAMRoleForServiceAccountConfig, Outputs
{
  public outputs?: outputs;
  public chart: string;
  public chartDir: string;
  public context: string;

  constructor(scope: Construct, id: string, config: CreateIAMRoleForServiceAccountConfig) {
    super(scope, id);

    this.chartDir = config.chartDir;
    this.chart = config.chart;
    this.context = config.context;
  }

  public init() {
    const envValuesPath = path.join(this.chartDir, `values-${this.node.getContext('env')}.yaml`);
    
    // First, check and update the env-specific values file if it exists
    if (fs.existsSync(envValuesPath)) {
      const envValues = yaml.parse(fs.readFileSync(envValuesPath, 'utf8')) || {};

      // Recursively search and update role-arn in the env values

      if (this.findAndUpdateRoleArn(envValues)) {
        // Write back the updated values to the env-specific file
        fs.writeFileSync(envValuesPath, yaml.stringify(envValues));
      }
    }
  }

  private findAndUpdateRoleArn(obj: any): boolean {
    if (!obj || typeof obj !== 'object') return false;

    let role: IamEksRole | undefined;
    let serviceAccountName: string | undefined;
    
    if (obj.annotations && obj.annotations['eks.amazonaws.com/role-arn'] === '') {
      if (obj.name) {
        serviceAccountName = obj.name;
      }
      if (!role) {
        role = this.createIamRoleForServiceAccount(this.chart, serviceAccountName);
      }
      obj.annotations['eks.amazonaws.com/role-arn'] = role.iamRoleArnOutput;
      return true;
    }

    for (const key in obj) {
      if (this.findAndUpdateRoleArn(obj[key])) {
        return true;
      }
    }
    return false;
  }

  /**
   * Retrieves the EKS cluster ARN from kubeconfig
   * 
   * @returns The ARN of the EKS cluster
   * @throws Error if context or cluster is not found
   * @private
   */
  private getClusterArn(): string {
    // Ensure the context is resolved before reading the kubeconfig
    const resolvedContext = Tokenization.resolve(this.context, {
      scope: this,
      resolver: {
        resolveToken: (token: Token) => {
          if (Token.isUnresolved(token)) {
            return token.toString();
          }
          return token;
        },
        resolveList: (tokens: Token[]) => tokens.map(t => t.toString()),
        resolveMap: (map: { [key: string]: Token }) => {
          const resolved: { [key: string]: string } = {};
          for (const key in map) {
            resolved[key] = map[key].toString();
          }
          return resolved;
        },
        resolveString: (str: TokenizedStringFragments) => str,
        resolveNumberList: (numbers: number[]) => numbers
      }
    })
    console.log('resolvedContext', resolvedContext);

    // Only proceed with kubeconfig parsing after context is resolved
    const kubeConfigPath = `${projectConfigPath}/kube_config`;
    const kubeConfig = yaml.parse(fs.readFileSync(kubeConfigPath, 'utf8'));
    
    // Find the cluster info for the specified context
    const context = kubeConfig.contexts.find((ctx: any) => ctx.name === resolvedContext);
    if (!context) {
      throw new Error(`Context ${resolvedContext} not found in kubeconfig`);
    }

    const clusterName = context.context.cluster;
    const cluster = kubeConfig.clusters.find((c: any) => c.name === clusterName);
    if (!cluster) {
      throw new Error(`Cluster ${clusterName} not found in kubeconfig`);
    }

    // Extract cluster ARN from server URL
    // URL format: https://XXXXXXXXXXXX.gr7.region.eks.amazonaws.com
    const serverUrl = cluster.cluster.server;
    const match = serverUrl.match(/eks\.amazonaws\.com/);
    if (!match) {
      throw new Error(`Invalid EKS cluster URL: ${serverUrl}`);
    }

    return clusterName;
  }

  /**
   * Creates an IAM role for a Kubernetes service account
   * 
   * @param chartDir - Directory name of the Helm chart
   * @param serviceAccountName - Optional name for the service account
   * @returns Created IAM role for the service account
   * @private
   */
  private createIamRoleForServiceAccount(chartDir: string, serviceAccountName?: string): IamEksRole {
    serviceAccountName = serviceAccountName ? `${chartDir}:${serviceAccountName}` : `${chartDir}:${chartDir}-sa`;
    const roleName = `${this.node.getContext('env')}-${chartDir}-sa`;
    const clusterArn = "123"
    
    const role = new IamEksRole(this, `${chartDir}-role`, {
      roleName,
      clusterServiceAccounts: {
        [clusterArn]: [serviceAccountName]
      }
    });

    this.outputs = { iamRoles: {} };
    this.outputs!.iamRoles[chartDir] = role.iamRoleArnOutput;

    new TerraformOutput(this, `${chartDir}-role-arn`, {
      value: role.iamRoleArnOutput
    });

    return role;
  }
}
