import * as fs from 'fs';
import { Buffer } from 'node:buffer';
import * as aws from '@pulumi/aws';
import * as eks from '@pulumi/eks';
import * as pulumi from '@pulumi/pulumi';
import * as path from 'path';
import * as YAML from 'yaml';
import { execSync } from 'child_process';
import TOML from 'smol-toml'
import { Vpc } from './vpc';

export interface EksConfig {
  name?: string;
  version?: string;
}

export class Eks extends pulumi.ComponentResource {
  public cluster: eks.Cluster;
  public kubeconfig: pulumi.Output<any>;

  constructor(name: string, vpc: Vpc, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:infra:aws:Eks', name, {}, opts);
    this.cluster = new eks.Cluster(name, {
      name,
      version: '1.32',
      vpcId: vpc.vpcId,
      privateSubnetIds: vpc.privateSubnetIds,
      publicSubnetIds: vpc.publicSubnetIds,
      endpointPrivateAccess: true,
      endpointPublicAccess: true,
      nodeGroupOptions: {
        desiredCapacity: 3,
        instanceType: 't3a.medium',
      },
      createOidcProvider: true,
    }, { parent: this });

    // Managed Node Groups equivalent
    // Public NG IAM role with additional SSM policy
    const publicNgRole = new aws.iam.Role('public-ng-role', {
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
    }, { parent: this });
    new aws.iam.RolePolicyAttachment('public-ng-worker', { role: publicNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy' }, { parent: this });
    new aws.iam.RolePolicyAttachment('public-ng-cni', { role: publicNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy' }, { parent: this });
    new aws.iam.RolePolicyAttachment('public-ng-ecr', { role: publicNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly' }, { parent: this });
    new aws.iam.RolePolicyAttachment('public-ng-ssm', { role: publicNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' }, { parent: this });

    // Public NG Launch Template with Bottlerocket data volume and TOML userData
    const publicUserData = Buffer.from(TOML.stringify({
      settings: { kubernetes: { 'max-pods': 32 } }
    })).toString('base64');
    const publicLt = new aws.ec2.LaunchTemplate('public-ng-lt', {
      blockDeviceMappings: [{
        deviceName: '/dev/xvdb',
        ebs: { volumeSize: 20, volumeType: 'gp3', deleteOnTermination: "true" },
      }],
      userData: publicUserData,
    }, { parent: this });

    new eks.ManagedNodeGroup('eks_managed_node_group_public', {
      cluster: this.cluster,
      nodeGroupName: 'eks-public-infra',
      subnetIds: vpc.publicSubnetIds,
      amiType: 'BOTTLEROCKET_x86_64',
      capacityType: 'SPOT',
      scalingConfig: { desiredSize: 2, minSize: 1, maxSize: 3 },
      instanceTypes: ['t3a.small'],
      nodeRoleArn: publicNgRole.arn,
      launchTemplate: { id: publicLt.id, version: "$Latest" },
      labels: {
        'vpc.amazonaws.com/subnet': 'public',
        'node-role.kubernetes.io': 'infra'
      },
      taints: [{ key: 'node-role.kubernetes.io/infra', value: 'true', effect: 'NoSchedule' }],
      
    }, { parent: this });

    // Private NG IAM role with additional SSM policy
    const privateNgRole = new aws.iam.Role('private-ng-role', {
      assumeRolePolicy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }],
      }),
    }, { parent: this });
    new aws.iam.RolePolicyAttachment('private-ng-worker', { role: privateNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy' }, { parent: this });
    new aws.iam.RolePolicyAttachment('private-ng-cni', { role: privateNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy' }, { parent: this });
    new aws.iam.RolePolicyAttachment('private-ng-ecr', { role: privateNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly' }, { parent: this });
    new aws.iam.RolePolicyAttachment('private-ng-ssm', { role: privateNgRole.name, policyArn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore' }, { parent: this });

    const privateUserData = Buffer.from(TOML.stringify({
      settings: { kubernetes: { 'max-pods': 24 } }
    })).toString('base64');
    const privateLt = new aws.ec2.LaunchTemplate('private-ng-lt', {
      blockDeviceMappings: [{
        deviceName: '/dev/xvdb',
        ebs: { volumeSize: 20, volumeType: 'gp3', deleteOnTermination: "true" },
      }],
      userData: privateUserData,
    }, { parent: this });

    new eks.ManagedNodeGroup('eks_managed_node_group_private', {
      cluster: this.cluster,
      nodeGroupName: 'eks-private-infra',
      subnetIds: vpc.privateSubnetIds,
      amiType: 'BOTTLEROCKET_x86_64',
      capacityType: 'SPOT',
      scalingConfig: { desiredSize: 3, minSize: 1, maxSize: 3 },
      instanceTypes: ['t3a.medium'],
      nodeRoleArn: privateNgRole.arn,
      launchTemplate: { id: privateLt.id, version: "$Latest" },
      labels: {
        'vpc.amazonaws.com/subnet': 'private',
        'node-role.kubernetes.io': 'infra'
      },
      taints: [{ key: 'node-role.kubernetes.io/infra', value: 'true', effect: 'NoSchedule' }],
      
    }, { parent: this });

    // Addons via aws.eks.Addon
    const addonVersion = {
      coredns: 'v1.11.4-eksbuild.2',
      kubeProxy: 'v1.32.0-eksbuild.2',
      vpcCni: 'v1.19.2-eksbuild.1',
      metricsServer: 'v0.7.2-eksbuild.1',
      efsCsi: 'v2.1.4-eksbuild.1'
    };

    new aws.eks.Addon('coredns', { clusterName: name, addonName: 'coredns', addonVersion: addonVersion.coredns });
    new aws.eks.Addon('kube-proxy', { clusterName: name, addonName: 'kube-proxy', addonVersion: addonVersion.kubeProxy });
    new aws.eks.Addon('vpc-cni', { clusterName: name, addonName: 'vpc-cni', addonVersion: addonVersion.vpcCni, configurationValues: JSON.stringify({ env: { ENABLE_PREFIX_DELEGATION: 'true' } }) });
    // metrics-server with tolerations for infra nodes
    new aws.eks.Addon('metrics-server', {
      clusterName: name,
      addonName: 'metrics-server',
      addonVersion: addonVersion.metricsServer,
      configurationValues: JSON.stringify({
        tolerations: [{ key: 'node-role.kubernetes.io/infra', operator: 'Exists' }],
        nodeSelector: { 'vpc.amazonaws.com/subnet': 'private', 'node-role.kubernetes.io': 'infra' }
      }),
    });
    // EFS CSI with controller tolerations
    new aws.eks.Addon('aws-efs-csi-driver', {
      clusterName: name,
      addonName: 'aws-efs-csi-driver',
      addonVersion: addonVersion.efsCsi,
      configurationValues: JSON.stringify({
        controller: {
          tolerations: [{ key: 'node-role.kubernetes.io/infra', operator: 'Exists' }],
          nodeSelector: { 'vpc.amazonaws.com/subnet': 'private', 'node-role.kubernetes.io': 'infra' },
        }
      })
    });

    // Persist kubeconfig (robust: verify cluster, use AWS_CONFIG_FILE, patch exec env, write only if changed)
    this.kubeconfig = this.cluster.kubeconfig;
    this.kubeconfig.apply(cfg => {
      try {
        const configDir = path.resolve(projectRoot, '.config');
        if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
        const kubeConfigPath = path.resolve(configDir, 'kube_config');

        const awsConfigFile = fs.existsSync(`${projectConfigPath}/aws_config`) ? `${projectConfigPath}/aws_config` : process.env['AWS_CONFIG_FILE'];
        const region = process.env['AWS_REGION'] || process.env['AWS_DEFAULT_REGION'];
        const profile = process.env['AWS_PROFILE'];

        const prefix = awsConfigFile ? `AWS_CONFIG_FILE=${awsConfigFile} ` : '';
        try {
          execSync(`${prefix}aws eks describe-cluster --name ${name} ${region ? `--region ${region}` : ''} ${profile ? `--profile ${profile}` : ''}`, { stdio: 'pipe' });
        } catch {
          return cfg;
        }

        const newKubeconfigContent = execSync(`${prefix}aws eks update-kubeconfig --name ${name} ${region ? `--region ${region}` : ''} ${profile ? `--profile ${profile}` : ''} --kubeconfig ${kubeConfigPath} --dry-run`, { stdio: 'pipe' }).toString();
        const parsed = YAML.parse(newKubeconfigContent);

        if (parsed?.users) {
          parsed.users.forEach((user: any) => {
            if (user.user?.exec) {
              user.user.exec.env = user.user.exec.env || [];
              const idx = user.user.exec.env.findIndex((e: any) => e.name === 'AWS_CONFIG_FILE');
              if (awsConfigFile) {
                if (idx >= 0) user.user.exec.env[idx].value = awsConfigFile; else user.user.exec.env.push({ name: 'AWS_CONFIG_FILE', value: awsConfigFile });
              }
            }
          });
        }

        const finalContent = '#Generated by Pulumi\n' + YAML.stringify(parsed);
        const existing = fs.existsSync(kubeConfigPath) ? fs.readFileSync(kubeConfigPath, 'utf8') : null;
        if (existing !== finalContent) fs.writeFileSync(kubeConfigPath, finalContent);
      } catch { /* ignore */ }
      return cfg;
    });

    this.registerOutputs({
      clusterName: this.cluster.core.cluster.name,
      kubeconfig: this.kubeconfig,
    });
  }
}
