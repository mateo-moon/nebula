import * as YAML from "yaml";
import * as fs from "fs";
import { File } from "@provider/local/file";
import { Kms } from '@module/terraform-aws-modules/aws/kms';
import { TerraformOutput, TerraformStack, Annotations } from "cdktf";
import { DataAwsIamRoles } from "@provider/aws/data-aws-iam-roles"
import { IamAssumableRole } from "@module/terraform-aws-modules/aws/iam/modules/iam-assumable-role";
import { IamPolicy as AwsIamPolicy } from "@module/terraform-aws-modules/aws/iam/modules/iam-policy";
import { Environment } from "@src/core";
import { WithAwsProvider } from "@src/core/decorators";

/**
 * Supported encryption methods for SOPS
 * TODO(OP): Add pgp method encryption
 */
export type EncryptionMethod = 'kms' | 'pgp'

/**
 * Main configuration interface for Secrets management
 */
export interface SecretsConfig {
  /**
   * Encryption methods to use
   */
  methods: EncryptionMethod[];
  inputs?: {
    arns: string[];
  }
}

/**
 * Root SOPS configuration
 */
interface CreationRule {
  path_regex: string;     // Regex pattern for matching secret files
  key_groups: {
    kms?: {
      arn: string;   // KMS key ARN
      role: string;  // IAM role ARN for KMS access
    }[]
  }[] // Key groups to use for encryption
}

interface SopsConfig {
  creation_rules: CreationRule[];
  stores: {
    yaml: {
      indent: number;
    }
  }
}

@WithAwsProvider()
export class Secrets extends TerraformStack {
  public kmsResources?: {
    key: Kms;
    role: IamAssumableRole;
  }

  constructor(
    public readonly env: Environment,
    public readonly id: string, 
    public readonly config: SecretsConfig
  ) {
    super(env, id);

    this.init();
  }

  private init(): void {
    // Create secrets file
    this.createSecretsFile();
  }

  private createSecretsFile(): void {
    const sopsFilePath = `${projectRoot}/.sops.yaml`;
    let existingConfig: SopsConfig = { creation_rules: [], stores: { yaml: { indent: 2 } } };

    // Try to read existing config
    try {
      if (fs.existsSync(sopsFilePath)) {
        const content = fs.readFileSync(sopsFilePath, 'utf8');
        existingConfig = YAML.parse(content);
      }
    } catch (error) {
      Annotations.of(this).addError(`Failed to read existing .sops.yaml: ${error}`);
    }

    // Create KMS resources if method is enabled
    if (this.config?.methods.includes('kms') && this.env?.config?.awsConfig) {
      this.kmsResources = this.createKmsResources();
    }

    // Update or add rules for current environment
    const updatedConfig = this.updateSopsConfig(existingConfig);

    new File(this, "local_file", {
      filename: sopsFilePath,
      content: '#Generated with CDKTF\n' + YAML.stringify(updatedConfig, { indent: 2 }),
    });
  }

  public set inputs(inputs: typeof this.config.inputs) {
    if (inputs?.arns) {
      this.giveAccess(inputs.arns);
    }
  }

  /**
   * Creates and attaches IAM trust policy to the SOPS role
   * @param principalArns - List of IAM principal ARNs that can assume the role. Supports wildcards (*)
   * @throws Error if KMS resources are not initialized
   */
  public giveAccess(principalArns: string[]): void {
    if (!this.kmsResources?.role) {
      throw new Error('KMS resources must be initialized before attaching trust policy');
    }

    // Split ARNs into exact matches and wildcard patterns
    const exactArns: string[] = [];
    const wildcardPatterns: string[] = [];

    principalArns.forEach(arn => {
      if (arn.includes('*')) {
        wildcardPatterns.push(arn);
      } else {
        exactArns.push(arn);
      }
    });

    // Get existing trust policy or create a new one
    let existingPolicy: any = {
      Version: "2012-10-17",
      Statement: []
    };

    const existingPolicyStr = this.kmsResources.role.customRoleTrustPolicy
    if (existingPolicyStr) {
      try {
        existingPolicy = JSON.parse(existingPolicyStr);
      } catch (e) {
        Annotations.of(this).addWarning(`Failed to parse existing trust policy: ${e}`);
      }
    }

    // Add new statements for exact ARNs if any exist
    if (exactArns.length > 0) {
      // Find existing statement for exact ARNs
      const existingExactStatement = existingPolicy.Statement.find((s: any) => 
        s.Effect === "Allow" && 
        s.Action === "sts:AssumeRole" && 
        s.Principal?.AWS && 
        !s.Condition
      );

      if (existingExactStatement) {
        // Convert existing Principal.AWS to array if it's a string
        if (typeof existingExactStatement.Principal.AWS === 'string') {
          existingExactStatement.Principal.AWS = [existingExactStatement.Principal.AWS];
        }
        // Add new ARNs that don't already exist
        exactArns.forEach(arn => {
          if (!existingExactStatement.Principal.AWS.includes(arn)) {
            existingExactStatement.Principal.AWS.push(arn);
          }
        });
      } else {
        existingPolicy.Statement.push({
          Effect: "Allow",
          Principal: {
            AWS: exactArns
          },
          Action: "sts:AssumeRole"
        });
      }
    }

    // Add new statements for wildcard patterns if any exist
    if (wildcardPatterns.length > 0) {
      // Find existing statement for wildcard patterns
      const existingWildcardStatement = existingPolicy.Statement.find((s: any) => 
        s.Effect === "Allow" && 
        s.Action === "sts:AssumeRole" && 
        s.Principal?.AWS === "*" &&
        s.Condition?.StringLike?.["aws:PrincipalARN"]
      );

      if (existingWildcardStatement) {
        // Convert existing patterns to array if it's a string
        if (typeof existingWildcardStatement.Condition.StringLike["aws:PrincipalARN"] === 'string') {
          existingWildcardStatement.Condition.StringLike["aws:PrincipalARN"] = 
            [existingWildcardStatement.Condition.StringLike["aws:PrincipalARN"]];
        }
        // Add new patterns that don't already exist
        wildcardPatterns.forEach(pattern => {
          if (!existingWildcardStatement.Condition.StringLike["aws:PrincipalARN"].includes(pattern)) {
            existingWildcardStatement.Condition.StringLike["aws:PrincipalARN"].push(pattern);
          }
        });
      } else {
        existingPolicy.Statement.push({
          Effect: "Allow",
          Principal: {
            AWS: "*"
          },
          Action: "sts:AssumeRole",
          Condition: {
            StringLike: {
              "aws:PrincipalARN": wildcardPatterns
            }
          }
        });
      }
    }

    // Apply the updated trust policy
    this.kmsResources.role.addOverride('custom_role_trust_policy', JSON.stringify(existingPolicy));
    this.kmsResources.role.addOverride('create_custom_role_trust_policy', true);
  }

  private createKmsResources(): typeof this.kmsResources {
    const keyName = `sops-key-${this.id}`;
    const roleName = `sops-role-${this.id}`;

    // Create KMS key
    var key = new Kms(this, 'kms', {
      description: `SOPS encryption key for ${this.id} environment`,
      deletionWindowInDays: 7,
      enableKeyRotation: true,
      aliases: [`alias/${keyName}`],
    });

    const sopsPolicy = new AwsIamPolicy(this, 'aws_iam_policy', {
      name: `sops-policy-${this.id}`,
      policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Action: [
            "kms:Decrypt",
            "kms:Encrypt",
            "kms:ReEncrypt*",
            "kms:GenerateDataKey*",
            "kms:DescribeKey",
          ],
          Resource: key.keyArnOutput,
        }]
      })
    })

    let adminRole: DataAwsIamRoles | undefined;
    if (!this.env.project.config.aws?.sso_config?.sso_role_name) {
      adminRole = new DataAwsIamRoles(
        this,
        "data_aws_iam_roles",
        {nameRegex: `.*${this.env.project.config.aws?.sso_config?.sso_role_name}.*`}
      );
    }
    const role = new IamAssumableRole(this, 'iam_assumable_role', {
      createRole: true,
      roleName: roleName,
      roleRequiresMfa: false,
      customRolePolicyArns: [sopsPolicy.arnOutput],
      createCustomRoleTrustPolicy: true,
      customRoleTrustPolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: {
            AWS: adminRole?.arns[0] || ""
          },
          Action: "sts:AssumeRole"
        }]
      })
    });

    // Create outputs
    new TerraformOutput(this, 'kms_key_arn', {
      value: key.keyArnOutput,
    });
    new TerraformOutput(this, 'iam_assumable_role_arn', {
      value: role.iamRoleArnOutput,
    });
    return { key, role };
  }

  private updateSopsConfig(existingConfig: SopsConfig): SopsConfig {
    const pathPatterns = [
      `.*/secrets\\.yaml`,
      `.*/secrets-${this.env.id}\\.yaml`,
    ];

    // For each path pattern
    pathPatterns.forEach(pattern => {
      // Find existing rule for this pattern
      const existingRuleIndex = existingConfig.creation_rules.findIndex(
        rule => rule.path_regex === pattern
      );

      if (this.kmsResources) {
        const kmsConfig = {
          arn: this.kmsResources.key.keyArnOutput,
          role: this.kmsResources.role.iamRoleArnOutput
        };

        if (existingRuleIndex === -1) {
          // Create new rule if doesn't exist
          existingConfig.creation_rules.push({
            path_regex: pattern,
            key_groups: [{
              kms: [kmsConfig]
            }]
          });
        } else {
          // Update existing rule
          const rule = existingConfig.creation_rules[existingRuleIndex];
          if (!rule.key_groups[0]) {
            rule.key_groups[0] = { kms: [] };
          }
          if (!rule.key_groups[0].kms) {
            rule.key_groups[0].kms = [];
          }

          // Add KMS config if not already present
          const existingKmsConfig = rule.key_groups[0].kms.find(
            k => k.arn === kmsConfig.arn && k.role === kmsConfig.role
          );
          if (!existingKmsConfig) {
            rule.key_groups[0].kms.push(kmsConfig);
          }
        }
      }
    });
    return existingConfig;
  }
}
