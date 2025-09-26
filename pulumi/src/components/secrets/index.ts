import * as fs from 'fs';
import * as YAML from 'yaml';
import * as aws from '@pulumi/aws';
import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import type { PulumiFn } from '@pulumi/pulumi/automation';
import { Component } from '../../core/component';
import { Environment } from '../../core/environment';
import { KeyManagementServiceClient } from '@google-cloud/kms';

export interface SecretsConfig {
  deploy?: boolean;
  paths?: string[];
  aws?: {
    enabled?: boolean;
    alias?: string;            // e.g. alias/sops-<env>
    createRole?: boolean;
    roleName?: string;
    allowAssumeRoleArns?: string[];
  };
  gcp?: {
    enabled?: boolean;
    location?: string;         // e.g. global
    keyRing?: string;          // e.g. sops-<env>
    keyName?: string;          // e.g. sops-<env>
    members?: string[];        // e.g. serviceAccount:foo@project.iam.gserviceaccount.com
  };
}

export interface SecretsResources {
  // High-level outputs for IDE assist (extend as needed)
}

type SopsCreationRule = {
  path_regex: string;
  key_groups: Array<{
    kms?: Array<{ arn: string; role?: string }>;
    gcp_kms?: Array<{ resource_id: string }>;
  }>;
};

type SopsConfig = {
  creation_rules: SopsCreationRule[];
  stores: { yaml: { indent: number } };
};

export class Secrets extends Component implements SecretsConfig {
  public readonly deploy?: boolean;
  public readonly paths?: string[];
  public readonly aws?: SecretsConfig['aws'];
  public readonly gcp?: SecretsConfig['gcp'];

  constructor(
    public readonly env: Environment,
    public readonly name: string,
    public readonly config: SecretsConfig
  ) {
    super(env, name);
    this.deploy = config.deploy;
    this.paths = config.paths;
    this.aws = config.aws;
    this.gcp = config.gcp;
  }

  public createProgram(): PulumiFn {
    return async () => {
      if (this.deploy === false) return;

      const sopsPath = `${projectRoot}/.sops.yaml`;
      const existing: SopsConfig = this.readSopsConfig(sopsPath);

      const useAws = (this.aws?.enabled !== false) && !!this.env.config.awsConfig;
      let awsKeyArn: pulumi.Output<string> | undefined;
      let awsRoleArn: pulumi.Output<string> | undefined;
      if (useAws) {
        const aliasName = this.aws?.alias || `alias/sops-${this.env.id}`;
        const key = new aws.kms.Key(`${this.name}-key`, {
          description: `SOPS key for env ${this.env.id}`,
          deletionWindowInDays: 7,
          enableKeyRotation: true,
        });
        new aws.kms.Alias(`${this.name}-alias`, {
          name: aliasName.startsWith('alias/') ? aliasName : `alias/${aliasName}`,
          targetKeyId: key.keyId,
        });
        awsKeyArn = key.arn;

        if (this.aws?.createRole) {
          const role = new aws.iam.Role(`${this.name}-sops-role`, {
            name: this.aws.roleName || `sops-role-${this.env.id}`,
            assumeRolePolicy: this.buildAwsAssumeRolePolicy(this.aws.allowAssumeRoleArns || []),
          });
          new aws.iam.RolePolicy(`${this.name}-sops-policy`, {
            role: role.name,
            policy: key.arn.apply(arn => JSON.stringify({
              Version: '2012-10-17',
              Statement: [{
                Effect: 'Allow',
                Action: [
                  'kms:Decrypt','kms:Encrypt','kms:ReEncrypt*','kms:GenerateDataKey*','kms:DescribeKey'
                ],
                Resource: arn,
              }],
            })),
          });
          awsRoleArn = role.arn;
        }
      }

      // Optionally provision GCP KMS using Google SDK for existence check
      const useGcp = (this.gcp?.enabled === true) || (!useAws && !!this.env.config.gcpConfig);
      let gcpKeyResourceId: pulumi.Output<string> | undefined;
      if (useGcp) {
        const location = this.gcp?.location || 'global';
        const ringName = this.gcp?.keyRing || `sops-${this.env.id}`;
        const keyName = this.gcp?.keyName || `sops-${this.env.id}`;
        const projectId = this.env.config.gcpConfig?.projectId || gcp.config.project;

        const kms = new KeyManagementServiceClient();
        const ringFullName = projectId ? kms.keyRingPath(projectId, location, ringName) : undefined;
        const keyFullName = projectId ? kms.cryptoKeyPath(projectId, location, ringName, keyName) : undefined;

        const ringExists = async (): Promise<boolean> => {
          if (!ringFullName) return false;
          try { await kms.getKeyRing({ name: ringFullName }); return true; } catch { return false; }
        };
        const keyExists = async (): Promise<boolean> => {
          if (!keyFullName) return false;
          try { await kms.getCryptoKey({ name: keyFullName }); return true; } catch { return false; }
        };

        const [hasRing, hasKey] = await Promise.all([ringExists(), keyExists()]);

        const ring = new gcp.kms.KeyRing(`${this.name}-ring`, {
          name: ringName,
          location,
        }, hasRing && ringFullName ? { import: ringFullName } : undefined);
        const ckey = new gcp.kms.CryptoKey(`${this.name}-key`, {
          name: keyName,
          keyRing: ring.id,
          rotationPeriod: '7776000s', // 90 days
        }, hasKey && keyFullName ? { import: keyFullName } : undefined);
        gcpKeyResourceId = ckey.id; // projects/.../locations/.../keyRings/.../cryptoKeys/...
        (this.gcp?.members || []).forEach((member, idx) => {
          new gcp.kms.CryptoKeyIAMMember(`${this.name}-member-${idx}`, {
            cryptoKeyId: ckey.id,
            role: 'roles/cloudkms.cryptoKeyEncrypterDecrypter',
            member,
          });
        });
      }

      // Resolve dynamic IDs and then merge/update SOPS rules, writing file once
      const awsArnIn: pulumi.Input<string> = awsKeyArn ?? '';
      const awsRoleIn: pulumi.Input<string> = awsRoleArn ?? '';
      const gcpResIn: pulumi.Input<string> = gcpKeyResourceId ?? '';
      pulumi.all([awsArnIn, awsRoleIn, gcpResIn]).apply(([awsArn, awsRole, gcpRes]) => {
        const rules = this.paths || [
          `.*/secrets\.yaml`,
          `.*/secrets-${this.env.id}\.yaml`,
        ];
        rules.forEach(pattern => {
          const idx = existing.creation_rules.findIndex(r => r.path_regex === pattern);
          const group: SopsCreationRule['key_groups'][number] = {};
          if (awsArn) group.kms = [{ arn: awsArn, role: awsRole || undefined }];
          if (gcpRes) group.gcp_kms = [{ resource_id: gcpRes }];
          if (!group.kms && !group.gcp_kms) return;
          if (idx === -1) {
            existing.creation_rules.push({ path_regex: pattern, key_groups: [group] });
          } else {
            const kg = (existing.creation_rules[idx].key_groups[0] || {}) as SopsCreationRule['key_groups'][number];
            if (group.kms) {
              kg.kms = kg.kms || [];
              const exists = kg.kms.find(k => k.arn === group.kms![0].arn && k.role === group.kms![0].role);
              if (!exists) kg.kms.push(group.kms[0]);
            }
            if (group.gcp_kms) {
              kg.gcp_kms = kg.gcp_kms || [];
              const exists = kg.gcp_kms.find(g => g.resource_id === group.gcp_kms![0].resource_id);
              if (!exists) kg.gcp_kms.push(group.gcp_kms[0]);
            }
            existing.creation_rules[idx].key_groups[0] = kg;
          }
        });
        this.writeSopsConfig(sopsPath, existing);
      });
    };
  }

  public override expandToStacks(): Array<{ name: string; projectName?: string; stackConfig?: Record<string,string>; program: PulumiFn }> {
    return [{
      name: `secrets`,
      projectName: `${this.env.projectId}-infra`,
      program: this.createProgram(),
    }];
  }

  private readSopsConfig(pathname: string): SopsConfig {
    try {
      if (fs.existsSync(pathname)) {
        const content = fs.readFileSync(pathname, 'utf8');
        const parsed = YAML.parse(content);
        if (parsed?.creation_rules && parsed?.stores?.yaml) return parsed as SopsConfig;
      }
    } catch {}
    return { creation_rules: [], stores: { yaml: { indent: 2 } } };
  }

  private writeSopsConfig(pathname: string, cfg: SopsConfig) {
    try {
      fs.writeFileSync(pathname, '# Generated by Pulumi\n' + YAML.stringify(cfg, { indent: 2 }));
    } catch {}
  }

  private buildAwsAssumeRolePolicy(arns: string[]): string {
    if (!arns || arns.length === 0) {
      return JSON.stringify({ Version: '2012-10-17', Statement: [] });
    }
    const exact = arns.filter(a => !a.includes('*'));
    const wildcard = arns.filter(a => a.includes('*'));
    const statements: any[] = [];
    if (exact.length > 0) {
      statements.push({ Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: exact } });
    }
    if (wildcard.length > 0) {
      statements.push({
        Effect: 'Allow', Action: 'sts:AssumeRole', Principal: { AWS: '*' },
        Condition: { StringLike: { 'aws:PrincipalARN': wildcard } },
      });
    }
    return JSON.stringify({ Version: '2012-10-17', Statement: statements });
  }

  public get secretsResources(): SecretsResources {
    return {};
  }
}
