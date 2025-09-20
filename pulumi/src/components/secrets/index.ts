import * as YAML from "yaml";
import * as fs from "fs";
import { File } from "../../../.gen/providers/local/file";
import { Kms } from '../../../.gen/modules/terraform-aws-modules/aws/kms';
import { TerraformOutput, Annotations } from "cdktf";
import { DataAwsIamRoles } from "../../../.gen/providers/aws/data-aws-iam-roles"
import { IamAssumableRole } from "../../../.gen/modules/terraform-aws-modules/aws/iam/modules/iam-assumable-role";
import { IamPolicy as AwsIamPolicy } from "../../../.gen/modules/terraform-aws-modules/aws/iam/modules/iam-policy";
import { Environment } from "../../core/environment";
import { Component } from "../../core/component";
import { RenameDependencies, WithAwsProvider } from "../../utils/decorators";


type outputs = {
}
interface Outputs {
  outputs?: outputs;
}

/**
 * Supported encryption methods for SOPS
 * TODO(OP): Add pgp method encryption
 */
export type EncryptionMethod = 'kms' | 'pgp'

export interface SecretsConfig {
  readonly methods: EncryptionMethod[];
  readonly arns?: string[];
}

/**
 * Root SOPS configuration
 * https://github.com/getsops/sops
 */
/**
 * SOPS creation rule for encrypting secrets
 * @interface CreationRule
 */
interface CreationRule {
  /** Regular expression pattern for matching secret files */
  path_regex: string;
  /** Groups of encryption keys to use */
  key_groups: {
    /** KMS key configuration */
    kms?: {
      /** ARN of the KMS key */
      arn: string;
      /** ARN of the IAM role with KMS access */
      role: string;
    }[]
  }[]
}

/**
 * SOPS configuration file structure
 * @interface SopsConfig
 */
interface SopsConfig {
  /** List of rules for encrypting different files */
  creation_rules: CreationRule[];
  /** Configuration for different file formats */
  stores: {
    /** YAML-specific configuration */
    yaml: {
      /** Number of spaces for YAML indentation */
      indent: number;
    }
  }
}

interface KmsResources {
  key: Kms;
  role: IamAssumableRole;
}

/**
 * Secrets stack that manages SOPS configuration and KMS encryption resources
 * 
 * This stack is responsible for:
 * - Creating and managing KMS keys for encryption
 * - Setting up IAM roles and policies for KMS access
 * - Generating SOPS configuration file (.sops.yaml)
 * - Managing access control for secrets encryption/decryption
 */
@RenameDependencies()
@WithAwsProvider()
export class Secrets
  extends Component
  implements SecretsConfig, Outputs
{
  public outputs?: outputs;
  public readonly methods: EncryptionMethod[];
  public readonly arns?: string[];
  private kmsResources?: KmsResources;

  constructor(
    public readonly env: Environment,
    public readonly id: string, 
    public readonly config: SecretsConfig
  ) {
    super(env, id);
    this.methods = config.methods;
  }

  public init(): Secrets {
    // Create secrets file
    this.createSecretsFile();
    this.giveAccess(this.arns);
    return this;
  }

  /**
   * Creates or updates the .sops.yaml configuration file
   * 
   * This method:
   * - Reads existing SOPS configuration if present
   * - Creates KMS resources if KMS encryption is enabled
   * - Updates configuration with new encryption rules
   * - Writes the updated configuration to .sops.yaml
   */
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
      this.outputs = {}
      this.kmsResources = this.createKmsResources();
    }

    // Update or add rules for current environment
    const updatedConfig = this.updateSopsConfig(existingConfig);

    new File(this, "local_file", {
      filename: sopsFilePath,
      content: '#Generated with CDKTF\n' + YAML.stringify(updatedConfig, { indent: 2 }),
    });
  }

  /**
   * Creates and attaches IAM trust policy to the SOPS role
   * @param principalArns - List of IAM principal ARNs that can assume the role. Supports wildcards (*)
   * @throws Error if KMS resources are not initialized
   */
  public giveAccess(principalArns: string[] | undefined): void {
    if (!principalArns) {
      return;
    }
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

  /**
   * Creates KMS key and IAM role resources for SOPS encryption
   * 
   * @returns Object containing the created KMS key and IAM role
   * @throws Error if AWS configuration is missing
   */
  private createKmsResources(): KmsResources {
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

  /**
   * Updates SOPS configuration with new encryption rules
   * 
   * @param existingConfig - Current SOPS configuration
   * @returns Updated SOPS configuration with new rules
   */
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
