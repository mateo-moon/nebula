import * as path from 'path';
import * as fs from 'fs';
import * as YAML from 'yaml';
import { execSync, execFileSync } from 'child_process';
import { S3Client, HeadBucketCommand, CreateBucketCommand, PutBucketVersioningCommand, BucketLocationConstraint } from '@aws-sdk/client-s3';
import { Storage } from '@google-cloud/storage';
import { KeyManagementServiceClient } from '@google-cloud/kms';

declare global {
  /** Root path of the git repository */
  var projectRoot: string;
  /** 
   * Config directory path (.config)
   * Used to store AWS config file, Kubernetes config and similar configuration files
   */
  var projectConfigPath: string;
  /** Git remote origin URL */
  var gitOrigin: string;
}

/**
 * Helper class providing utility methods for project configuration and AWS setup
 */
export class Helpers {

  /**
   * Checks if S3 bucket exists and creates it if not
   * Handles AWS SSO authentication and enables versioning on the bucket
   * @param config - S3 backend configuration
   */
  // Minimal shape needed for S3 bucket bootstrap
  public static async checkCreateS3Bucket(config: { bucket: string; region?: string; profile?: string; sharedConfigFiles?: string[] }) {
    if (execSync('id -u').toString().trim() === '999') {
      return
    }
    if (config.sharedConfigFiles && config.sharedConfigFiles[0]) {
      process.env['AWS_CONFIG_FILE'] = config.sharedConfigFiles[0];
    }
    if (config.profile) {
      process.env['AWS_PROFILE'] = config.profile;
      process.env['AWS_SDK_LOAD_CONFIG'] = '1';
    }
    const client = new S3Client({
      ...(config.region ? { region: config.region } : {}),
    })

    try {
      // Check if bucket exists
      try {
        await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
        console.log(`S3 bucket ${config.bucket} already exists`);
      } catch (error: any) {
        if (error.name === 'NotFound') {
          // Bucket doesn't exist, create it
          console.log(`Creating S3 bucket: ${config.bucket}`);
          const createParams: any = {
            Bucket: config.bucket,
          };
          
          // Add location constraint if region is specified and not us-east-1
          if (config.region && config.region !== 'us-east-1') {
            createParams.CreateBucketConfiguration = {
              LocationConstraint: config.region as BucketLocationConstraint,
            };
          }
          
          await client.send(new CreateBucketCommand(createParams));
          
          // Enable versioning
          await client.send(new PutBucketVersioningCommand({
            Bucket: config.bucket,
            VersioningConfiguration: { Status: 'Enabled' },
          }));
          
          console.log(`S3 bucket ${config.bucket} created successfully`);
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      console.log(`S3 bucket operation failed: ${error.message}`);
    }
  }

  /**
   * Checks if GCS bucket exists and creates it if not using Google Cloud Storage SDK
   * @param config - GCS backend configuration
   */
  public static async checkCreateGcsBucket(config: { bucket: string; location?: string; projectId?: string }) {
    if (execSync('id -u').toString().trim() === '999') {
      return
    }
    
    const credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    
    if (!credentialsFile) {
      console.error('No credentials file available for GCS bucket creation');
      return;
    }
    
    try {
      // Initialize Storage client with credentials
      const storageOptions: any = {
        keyFilename: credentialsFile
      };
      
      if (config.projectId) {
        storageOptions.projectId = config.projectId;
      }
      
      const storage = new Storage(storageOptions);
      
      // Check if bucket exists
      const [exists] = await storage.bucket(config.bucket).exists();
      
      if (exists) {
        console.log(`GCS bucket ${config.bucket} already exists`);
        return;
      }
      
      // Create bucket
      console.log(`Creating GCS bucket: ${config.bucket}`);
      const bucketOptions: any = {};
      
      if (config.location) {
        bucketOptions.location = config.location;
      }
      
      if (config.projectId) {
        bucketOptions.projectId = config.projectId;
      }
      
      await storage.createBucket(config.bucket, bucketOptions);
      console.log(`GCS bucket ${config.bucket} created successfully`);
      
    } catch (err: any) {
      console.error(`Failed to create GCS bucket ${config.bucket}:`, err?.message || err);
    }
  }

  /**
   * Set global variables for the project
   */
  public static setGlobalVariables() {
    const projectRoot = process.cwd();
    global.projectRoot = projectRoot;
    global.projectConfigPath = path.resolve(projectRoot, '.config');
    global.gitOrigin = execSync('git config --get remote.origin.url').toString().trim();
  }


  /**
   * Bootstrap backend storage and secrets providers for all environments.
   * This is a utility function that should be called from the CLI layer.
   */
  public static async bootstrap(projectId: string, environments: Record<string, any>): Promise<void> {
    // Extract settings from environment configs
    const envConfigs = Object.values(environments).filter(Boolean) as any[];
    const envSettings = envConfigs.map(cfg => cfg.settings || {});

    // Backend URL taken from the first environment with one set
    const backendUrl = envSettings.find(s => Boolean(s.backendUrl))?.backendUrl;

    // Parse first available config (string or object) and extract cloud details
    const firstRawConfig = envSettings.find(s => s.config != null)?.config;
    const parsedCfg = Helpers.parsePulumiConfigRaw(firstRawConfig as any);
    const awsConfig = Helpers.extractAwsFromPulumiConfig(parsedCfg);
    const gcpConfig = Helpers.extractGcpFromPulumiConfig(parsedCfg);

    // Authenticate with GCP if GCP config is present
    if (gcpConfig?.projectId) {
      const { Auth } = await import('./auth');
      await Auth.GCP.authenticate(gcpConfig.projectId, gcpConfig.region);
    }

    // Ensure backend storage exists prior to workspace init
    await Helpers.ensureBackendForUrl({
      ...(backendUrl ? { backendUrl } : {}),
      ...(awsConfig ? { aws: awsConfig } : {}),
      ...(gcpConfig ? { gcp: gcpConfig } : {}),
    });

    // Collect all secrets providers
    const secretsProviders = Array.from(new Set(envSettings.map(s => s.secretsProvider).filter(Boolean) as string[]));

    // Ensure secrets providers exist
    if (secretsProviders.length > 0) {
      await Helpers.ensureSecretsProvider({ 
        secretsProviders, 
        ...(gcpConfig?.projectId ? { projectId: gcpConfig.projectId } : {})
      });
    }

    // Setup SOPS config for GCP KMS
    const gcpkms = secretsProviders.find(p => p.startsWith('gcpkms://'));
    if (gcpkms) {
      const patterns = [
        `.*/secrets\\.yaml`,
        `.*/secrets-${projectId}-.*\\.yaml`,
      ];
      const resource = gcpkms.replace(/^gcpkms:\/\//, '');
      Helpers.ensureSopsConfig({ gcpKmsResourceId: resource, patterns });
    }
  }

  /** Ensure remote backend storage exists for the given backend URL. Supports s3:// and gs:// when corresponding cloud config is provided. */
  public static async ensureBackendForUrl(opts: { backendUrl?: string; aws?: { region?: string; profile?: string }; gcp?: { projectId?: string; region?: string } }) {
    if (!opts.backendUrl) return;
    const url = new URL(opts.backendUrl);
    if (url.protocol === 's3:') {
      const bucket = url.hostname;
      await Helpers.checkCreateS3Bucket({ bucket, ...(opts.aws?.region ? { region: opts.aws.region } : {}), ...(opts.aws?.profile ? { profile: opts.aws.profile } : {}) } as any);
    } else if (url.protocol === 'gs:') {
      const bucket = url.hostname;
      await Helpers.checkCreateGcsBucket({ bucket, ...(opts.gcp?.region ? { location: opts.gcp.region } : {}), ...(opts.gcp?.projectId ? { projectId: opts.gcp.projectId } : {}) } as any);
    }
  }

  /** Ensure secrets provider resources exist before workspace init. For now: supports gcpkms:// only. */
  public static async ensureSecretsProvider(opts: { secretsProviders: string[]; projectId?: string }) {
    for (const provider of opts.secretsProviders) {
      if (provider.startsWith('gcpkms://')) {
        await Helpers.ensureGcpKmsKeyFromUrl(provider);
      }
    }
  }

  private static async ensureGcpKmsKeyFromUrl(providerUrl: string) {
    const url = new URL(providerUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length < 6) throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    
    // Expected format: PROJECT_ID/locations/LOCATION/keyRings/KEYRING_ID/cryptoKeys/CRYPTOKEY_ID
    const [projectId, , location, , keyRingId, , cryptoKeyId] = pathParts;
    if (!projectId || !location || !keyRingId || !cryptoKeyId) {
      throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    }
    
    const credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    
    if (!credentialsFile) {
      console.error('No credentials file available for KMS key creation');
      return;
    }
    
    try {
      // Initialize KMS client with credentials
      const kmsClient = new KeyManagementServiceClient({
        keyFilename: credentialsFile,
        projectId: projectId
      });
      
      const keyRingPath = kmsClient.keyRingPath(projectId, location, keyRingId);
      const cryptoKeyPath = kmsClient.cryptoKeyPath(projectId, location, keyRingId, cryptoKeyId);
      
      // Check if key ring exists
      try {
        await kmsClient.getKeyRing({ name: keyRingPath });
        console.log(`Key ring ${keyRingPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.log(`Creating key ring: ${keyRingPath}`);
          await kmsClient.createKeyRing({
            parent: kmsClient.locationPath(projectId, location),
            keyRingId: keyRingId
          });
          console.log(`Key ring ${keyRingPath} created successfully`);
        } else {
          throw error;
        }
      }
      
      // Check if crypto key exists
      try {
        await kmsClient.getCryptoKey({ name: cryptoKeyPath });
        console.log(`Crypto key ${cryptoKeyPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.log(`Creating crypto key: ${cryptoKeyPath}`);
          await kmsClient.createCryptoKey({
            parent: keyRingPath,
            cryptoKeyId: cryptoKeyId,
            cryptoKey: {
              purpose: 'ENCRYPT_DECRYPT'
            }
          });
          console.log(`Crypto key ${cryptoKeyPath} created successfully`);
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      console.error(`Failed to ensure GCP KMS key: ${error.message}`);
      throw error;
    }
  }

  /** Resolve refs via vals (e.g., ref+sops://...). Returns trimmed stdout or throws. */
  public static resolveVALS(ref: string): string {
    try {
      const stdout = execFileSync('vals', ['eval', ref], { encoding: 'utf8' });
      return stdout.trim();
    } catch (e: any) {
      const msg = e.stderr || e.message || 'vals eval failed';
      throw new Error(`Helpers.resolveVALS failed: ${msg}`);
    }
  }

  /** Ensure .sops.yaml exists and references the provided GCP KMS key for given patterns. */
  public static ensureSopsConfig(opts: { gcpKmsResourceId: string; patterns: string[] }) {
    const sopsPath = path.resolve(process.cwd(), '.sops.yaml');
    const cfg = {
      creation_rules: [
        {
          gcp_kms: opts.gcpKmsResourceId,
          path_regex: opts.patterns.join('|'),
        },
      ],
      stores: { yaml: { indent: 2 } },
    } as const;
    Helpers.writeSopsConfig(sopsPath, cfg as any);
  }

  private static writeSopsConfig(pathname: string, cfg: { creation_rules: any[]; stores: { yaml: { indent: number } } }) {
    try {
      fs.writeFileSync(pathname, '# Generated by Pulumi\n' + YAML.stringify(cfg, { indent: 2 }));
    } catch {}
  }

  /** Normalize an object of pulumi config entries into plain values or {value, secret} shapes. */
  public static normalizePulumiConfig(config: Record<string, any>): Record<string, any> {
    const out: Record<string, any> = {};
    Object.entries(config).forEach(([k, v]) => {
      if (typeof v === 'string') {
        out[k] = v;
      } else if (v && typeof v === 'object' && ('value' in v || 'secret' in v)) {
        out[k] = v;
      } else {
        out[k] = { value: v };
      }
    });
    return out;
  }

  /** Parse a Pulumi config setting provided as string (JSON or vals ref) or object into a plain object. */
  public static parsePulumiConfigRaw(raw: any): Record<string, any> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      if (raw.startsWith('ref+')) {
        return JSON.parse(Helpers.resolveVALS(raw));
      }
      try {
        return JSON.parse(raw);
      } catch {
        return {};
      }
    }
    if (raw && typeof raw === 'object') return raw as Record<string, any>;
    return {};
  }

  /** Convert raw Pulumi config (string or object) into Workspace-ready config map using normalizePulumiConfig. */
  public static convertPulumiConfigToWorkspace(raw: any): Record<string, any> {
    const parsed = Helpers.parsePulumiConfigRaw(raw);
    return Helpers.normalizePulumiConfig(parsed);
  }

  /** Get a config entry value supporting both plain string and { value, secret } objects. */
  public static getConfigValue(v: any): string {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      if ('value' in v) return String(v.value);
      if ('secret' in v) return String(v.secret);
    }
    try { return JSON.stringify(v); } catch { return String(v); }
  }

  /** Extract minimal AWS details from Pulumi config map if present. */
  public static extractAwsFromPulumiConfig(config: Record<string, any>): { region?: string; profile?: string; sharedConfigFiles?: string[] } | undefined {
    const region = Helpers.getConfigValue(config['aws:region']);
    const profile = Helpers.getConfigValue(config['aws:profile']);
    if (!region && !profile) return undefined;
    return {
      ...(region ? { region } : {}),
      ...(profile ? { profile } : {}),
      sharedConfigFiles: [`${projectConfigPath}/aws_config`],
    };
  }

  /** Extract minimal GCP details from Pulumi config map if present. */
  public static extractGcpFromPulumiConfig(config: Record<string, any>): { region?: string; projectId?: string } | undefined {
    const region = Helpers.getConfigValue(config['gcp:region']);
    const projectId = Helpers.getConfigValue(config['gcp:project']);
    if (!region && !projectId) return undefined;
    return { ...(region ? { region } : {}), ...(projectId ? { projectId } : {}) };
  }
}
