import * as aws from '@pulumi/aws';

export interface IamConfig {
  trustedPrincipalArns?: string[];
}

export class Iam {
  public readonly sopsKey?: aws.kms.Key;
  public readonly sopsRole?: aws.iam.Role;
  public readonly sopsPolicy?: aws.iam.Policy;

  constructor(name: string, config?: IamConfig) {
    this.sopsKey = new aws.kms.Key(`${name}-sops-key`, {
      description: 'KMS key for SOPS secrets',
      deletionWindowInDays: 7,
      enableKeyRotation: true,
      multiRegion: true,
    });

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
    });

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
    });

    new aws.iam.RolePolicyAttachment(`${name}-sops-attach`, {
      role: this.sopsRole.name,
      policyArn: this.sopsPolicy.arn,
    });
  }
}

// legacy CDKTF code removed
