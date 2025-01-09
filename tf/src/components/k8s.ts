import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { IamEksRole } from "@module/terraform-aws-modules/aws/iam/modules/iam-eks-role";
import { Environment } from '@src/core';
import { TerraformAwsEksExternalDns, TerraformAwsEksExternalDnsConfig } from "@module/lablabs/terraform-aws-eks-external-dns";
import { WithAwsProvider, WithK8sProvider } from '@src/core/decorators';
import { TerraformOutput, TerraformStack, Annotations } from 'cdktf';
import { K8sChart, K8sChartConfig as K8sChartConfigModule } from '@src/k8s';

interface K8sChartConfig extends Omit<K8sChartConfigModule, 'chartDir'> {
  chartDir?: string
}

export interface K8sConfig {
  kubeConfig: {
    context: string
  }
  charts?: {[key: string]: K8sChartConfig}
}

export interface Outputs {
}

@WithAwsProvider()
@WithK8sProvider()
export class K8s extends TerraformStack {

  constructor(
    public readonly env: Environment,
    public readonly id: string,
    public readonly config: K8sConfig
  ) {
  super(env, id);

    this.init()
}

  private init() {
    this.applyHelmCharts()
  }

  private applyHelmCharts() {
    for (const chart in this.config.charts) {
      const k8sPath = `${projectRoot}/k8s`;
      const chartConfig = this.config.charts[chart];
      chartConfig.chartDir ??= path.join(k8sPath, chart);
      const chartDir = chartConfig.chartDir;

      if (!fs.existsSync(path.join(chartDir, 'values.yaml'))) {
        Annotations.of(this).addWarning(`Chart directory ${chartDir} not found or missing values.yaml`);
        continue;
      }

      const baseValuesPath = path.join(chartDir, 'values.yaml');
      const envValuesPath = path.join(chartDir, `values-${this.env.id}.yaml`);
      
      // First, check and update the env-specific values file if it exists
      if (fs.existsSync(envValuesPath)) {
        const envValues = yaml.parse(fs.readFileSync(envValuesPath, 'utf8')) || {};
        let role: IamEksRole | undefined;
        let serviceAccountName: string | undefined;

        // Recursively search and update role-arn in the env values
        const findAndUpdateRoleArn = (obj: any): boolean => {
          if (!obj || typeof obj !== 'object') return false;
          
          if (obj.annotations && obj.annotations['eks.amazonaws.com/role-arn'] === '') {
            if (obj.name) {
              serviceAccountName = obj.name;
            }
            if (!role) {
              role = this.createIamRoleForServiceAccount(chart, serviceAccountName);
            }
            obj.annotations['eks.amazonaws.com/role-arn'] = role.iamRoleArnOutput;
            return true;
          }

          for (const key in obj) {
            if (findAndUpdateRoleArn(obj[key])) {
              return true;
            }
          }
          return false;
        };

        if (findAndUpdateRoleArn(envValues)) {
          // Write back the updated values to the env-specific file
          fs.writeFileSync(envValuesPath, yaml.stringify(envValues));
        }

        // Overwrite the base values with env values
        fs.writeFileSync(baseValuesPath, yaml.stringify(envValues));
      }

      new K8sChart(this, chart, chartConfig as K8sChartConfigModule);
    }
  }

  private getClusterArn(): string {
    const kubeConfigPath = `${projectConfigPath}/.config/kube_config`;
    const kubeConfig = yaml.parse(fs.readFileSync(kubeConfigPath, 'utf8'));
    
    // Find the cluster info for the specified context
    const context = kubeConfig.contexts.find((ctx: any) => ctx.name === this.config.kubeConfig.context);
    if (!context) {
      throw new Error(`Context ${this.config.kubeConfig.context} not found in kubeconfig`);
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

    return clusterName
  }

  private createIamRoleForServiceAccount(chartDir: string, serviceAccountName?: string): IamEksRole {
    serviceAccountName = serviceAccountName ? `${chartDir}:${serviceAccountName}` : `${chartDir}:${chartDir}-sa`;
    const roleName = `${this.env.id}-${chartDir}-sa`;
    const clusterArn = this.getClusterArn();
    
    const role = new IamEksRole(this, `${chartDir}-role`, {
      roleName,
      clusterServiceAccounts: {
        [clusterArn]: [serviceAccountName]
      }
    });

    new TerraformOutput(this, `${chartDir}-role-arn`, {
      value: role.iamRoleArnOutput
    });

    return role;
  }
}
