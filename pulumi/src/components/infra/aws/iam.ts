import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';

export interface IamConfig {
  trustedPrincipalArns?: string[];
}

export class Iam extends pulumi.ComponentResource {
  public readonly sopsKey?: aws.kms.Key;
  public readonly sopsRole?: aws.iam.Role;
  public readonly sopsPolicy?: aws.iam.Policy;

  constructor(name: string, config?: IamConfig, opts?: pulumi.ComponentResourceOptions) {
    super('awsIam', name, {}, opts);
    this.sopsKey = new aws.kms.Key(`${name}-sops-key`, {
      description: 'KMS key for SOPS secrets',
      deletionWindowInDays: 7,
      enableKeyRotation: true,
      multiRegion: true,
    }, { parent: this });

    this.sopsPolicy = new aws.iam.Policy(`${name}-sops-policy`, {
      policy: this.sopsKey.arn.apply(arn => JSON.stringify({
        Version: '2012-10-17',
        Statement: [{
          Effect: 'Allow',
          Action: [
            'kms:Decrypt',
            'kms:Encrypt',
            'kms:ReEncrypt*',
            'kms:GenerateDataKey*',
            'kms:DescribeKey',
          ],
          Resource: arn,
        }],
      })),
    }, { parent: this });

    const principals = (config?.trustedPrincipalArns && config.trustedPrincipalArns.length > 0)
      ? config.trustedPrincipalArns
      : ['*'];

    const assume = aws.iam.getPolicyDocumentOutput({
      statements: [{
        actions: ['sts:AssumeRole'],
        principals: [{ type: 'AWS', identifiers: principals }],
      }],
    }).json;

    this.sopsRole = new aws.iam.Role(`${name}-sops-role`, {
      assumeRolePolicy: assume,
    }, { parent: this });

    new aws.iam.RolePolicyAttachment(`${name}-sops-attach`, {
      role: this.sopsRole.name,
      policyArn: this.sopsPolicy.arn,
    }, { parent: this });

    this.registerOutputs({
      sopsKeyArn: this.sopsKey.arn,
      sopsRoleArn: this.sopsRole.arn,
    });
  }
}

// legacy CDKTF code removed
