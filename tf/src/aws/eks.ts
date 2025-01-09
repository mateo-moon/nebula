import { Construct } from 'constructs';
import { ComplexMap, Fn, TerraformIterator, Token, Annotations } from "cdktf";
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'yaml';
import { Eks as AwsEks, EksConfig as AwsEksConfig} from "@module/terraform-aws-modules/aws/eks"
import { Vpc } from "@module/terraform-aws-modules/aws/vpc"
import { SecurityGroup } from "@provider/aws/security-group"
import { EksBlueprintsAddons } from "@module/aws-ia/aws/eks-blueprints-addons";
import { TerraformAwsEksExternalDns } from "@module/lablabs/terraform-aws-eks-external-dns";
import { Infra } from "@src/components";
import { WithK8sProvider } from '@src/core/decorators';

export interface EksConfig extends AwsEksConfig {
  vpc: Vpc,
}

export class Eks extends Construct {
  public eks!: AwsEks
  public eksSecurityGroup!: SecurityGroup

  constructor(
    public readonly scope: Infra,
    public readonly id: string,
    public readonly config: EksConfig
  ) {
    super(scope, id);

    this.init()
    const kubeconfig = new GenerateKubeconfig(this, this.id)
    kubeconfig.node.addDependency(this.eks)
    const externalDns = new ExternalDns(
      this,
      'external-dns',
      {kubeConfig: {context: this.eks.clusterArnOutput }}
    )
    externalDns.node.addDependency(this.eks)
  }

  private init() {
    // Security Group for EKS and Node Groups
    this.eksSecurityGroup = new SecurityGroup(this, "security-group", {
      name: `eks-${this.id}-security-group`,
      vpcId: this.config.vpc.vpcIdOutput,
      description: `eks ${this.id}`,
      // allow all traffic from the security group itself
      ingress: [{
        fromPort: 0,
        toPort: 0,
        protocol: '-1',
        selfAttribute: true,
      }],
      egress: [{
        fromPort: 0,
        toPort: 0,
        protocol: '-1',
        cidrBlocks: ['0.0.0.0/0'],
      }],
      tags: {
        Name: `eks-${this.id}-security-group`,
      }
    })

    // Create EKS cluster
    this.eks = new AwsEks(this, "eks", {
      // general settings
      vpcId: this.config.vpc.vpcIdOutput,
      subnetIds: Fn.tolist(this.config.vpc.privateSubnetsOutput),
      clusterName: this.id,
      clusterEndpointPublicAccess: true,
      clusterEndpointPrivateAccess: true,
      enableClusterCreatorAdminPermissions: true,
      createNodeSecurityGroup: true,
      nodeSecurityGroupId: this.eksSecurityGroup.id,
      eksManagedNodeGroups: {
        public: {
          desired_size: 1,
          disk_size: 50,
          instance_types: ["t3a.small"],
          max_size: 1,
          subnet_ids: Fn.tolist(this.config.vpc.publicSubnetsOutput),
          ebs_optimized: true,
          labels: {
            "vpc.amazonaws.com/subnet": "public"
          }
        },
        private: {
          desired_size: 1,
          disk_size: 50,
          instance_types: ["t3a.small"],
          max_size: 1,
          subnet_ids: Fn.tolist(this.config.vpc.privateSubnetsOutput),
          ebs_optimized: true,
          labels: {
            "vpc.amazonaws.com/subnet": "private"
          }
        },
      }
    });


    const arns = Token.asList(TerraformIterator.fromMap(this.eks.eksManagedNodeGroupsOutput as unknown as ComplexMap).pluckProperty("node_group_arn"))
    // EKS blueprints addons
    new EksBlueprintsAddons(this, "eks_blueprints_addons",{
      clusterEndpoint: this.eks.clusterEndpointOutput,
      clusterName: this.eks.clusterNameOutput,
      clusterVersion: this.eks.clusterVersionOutput,
      oidcProviderArn: this.eks.oidcProviderArnOutput,
      createDelayDependencies: arns,
      eksAddons: {
        "coredns": {
          most_recent: true,
        },
        "kube-proxy": {
          most_recent: true,
        },
        "vpc-cni": {
          most_recent: true,
        },
      },
    })
  }
}

class GenerateKubeconfig extends Construct {
  constructor(
    private readonly scope: Eks,
    readonly id: string
  ) {
    super(scope, `${id}-kubeconfig`);

    if (!scope.eks) return;
    this.node.addDependency(scope.eks)
    this.generateKubeconfig()
  }

  private generateKubeconfig() {
    const awsConfig = this.scope.scope.env.config.awsConfig;
    const clusterName = this.scope.eks?.clusterName
    
    try {
      // Check if EKS cluster exists
      try {
        execSync(`AWS_CONFIG_FILE=${awsConfig?.sharedConfigFiles?.[0]} \
aws eks describe-cluster \
--name ${clusterName} \
--region ${awsConfig?.region} \
--profile ${awsConfig?.profile}`, 
          { stdio: 'pipe' }
        );
      } catch (error) {
        Annotations.of(this).addWarning(`EKS cluster ${clusterName} not found. Skipping kubeconfig generation.\n ${error}`);
        return;
      }

      // Create .config directory in project root
      const configDir = path.resolve(projectRoot, '.config');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }

      const kubeConfigPath = path.resolve(configDir, 'kube_config');
      
      // Store existing config content if file exists
      let existingConfig: string | null = null;
      if (fs.existsSync(kubeConfigPath)) {
        existingConfig = fs.readFileSync(kubeConfigPath, 'utf8');
      }
      
      // Get the new kubeconfig content without writing to file
      const newKubeconfigContent = execSync(`AWS_CONFIG_FILE=${awsConfig?.sharedConfigFiles?.[0]} \
aws eks update-kubeconfig \
--name ${clusterName} \
--region ${awsConfig?.region} \
--profile ${awsConfig?.profile} \
--kubeconfig ${kubeConfigPath} \
--dry-run`,
        { stdio: 'pipe' }
      ).toString();
      
      // Parse the new kubeconfig content
      const kubeconfig = yaml.parse(newKubeconfigContent);

      // Update the env section in the kubeconfig
      let configChanged = false;
      if (kubeconfig.users) {
        kubeconfig.users.forEach((user: any) => {
          if (user.user.exec) {
            // Initialize env array if it doesn't exist
            if (!user.user.exec.env) {
              user.user.exec.env = [];
              configChanged = true;
            }

            // Add or update AWS_CONFIG_FILE in the env array
            const awsConfigIndex = user.user.exec.env.findIndex((e: any) => e.name === 'AWS_CONFIG_FILE');
            const newConfigValue = awsConfig?.sharedConfigFiles?.[0];
            
            if (awsConfigIndex >= 0) {
              if (user.user.exec.env[awsConfigIndex].value !== newConfigValue) {
                user.user.exec.env[awsConfigIndex].value = newConfigValue;
                configChanged = true;
              }
            } else {
              user.user.exec.env.push({
                name: 'AWS_CONFIG_FILE',
                value: newConfigValue
              });
              configChanged = true;
            }
          }
        });
      }

      const newContent = '#Generated by CDKTF\n' + yaml.stringify(kubeconfig);
      
      // Only write and show messages if content has changed
      if (existingConfig !== newContent) {
        Annotations.of(this).addInfo(`Generating kubeconfig for ${clusterName} environment...`);
        fs.writeFileSync(kubeConfigPath, newContent);
        Annotations.of(this).addInfo(`Successfully generated and updated kubeconfig for ${clusterName} at ${kubeConfigPath}`);
      }
    } catch (error) {
      Annotations.of(this).addError(`Failed to generate kubeconfig for ${clusterName}:\n ${error}`);
    }
  };
}

@WithK8sProvider()
class ExternalDns extends Construct {
  constructor(
    scope: Eks,
    id: string,
    config: any
  ) {
    super(scope, id);

    config
    this.node.addDependency(scope.eks)

    new TerraformAwsEksExternalDns(
      this,
      `external-dns`,
      {
        clusterIdentityOidcIssuer: scope.eks.oidcProviderOutput,
        clusterIdentityOidcIssuerArn: scope.eks.oidcProviderArnOutput,
        helmChartVersion: "1.14.5",
        helmRepoUrl: "https://kubernetes-sigs.github.io/external-dns/",
        helmWait: true,
        namespace: "external-dns",
        values: Fn.yamlencode({
          policy: "sync",
          txtOwnerId: scope.id,
        }),
        dependsOn: [scope.eks]
      }
    );
  }
}
