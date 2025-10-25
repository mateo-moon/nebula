import * as path from 'path';
import * as fs from 'fs';
import * as YAML from 'yaml';
import { execSync } from 'child_process';
import * as pulumi from '@pulumi/pulumi';
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
    
    if (!credentialsFile || !fs.existsSync(credentialsFile)) {
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
      
      // Check for authentication errors and provide helpful guidance
      if (err?.message?.includes('invalid_grant') || err?.message?.includes('reauth')) {
        console.error('\nAuthentication error detected. This usually means your Google Cloud credentials have expired.');
        console.error('Please run: npx nebula clear-auth (if available) or manually delete expired credential files.');
        console.error('Then run: npx nebula bootstrap to re-authenticate.');
      }
    }
  }

  /**
   * Checks if GCS bucket exists and creates it if not using Google Cloud Storage SDK with retry logic for auth errors
   * @param config - GCS backend configuration
   */
  public static async checkCreateGcsBucketWithRetry(config: { bucket: string; location?: string; projectId?: string }) {
    if (execSync('id -u').toString().trim() === '999') {
      return
    }
    
    let credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    
    if ((!credentialsFile || !fs.existsSync(credentialsFile)) && config.projectId) {
      console.log('No valid credentials file found, attempting to authenticate...');
      const { Auth } = await import('./auth');
      await Auth.GCP.authenticate(config.projectId, config.location);
      credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    }
    
    if (!credentialsFile || !fs.existsSync(credentialsFile)) {
      console.error('No credentials file available for GCS bucket creation');
      return;
    }
    
    try {
      // Try the operation first
      await Helpers.checkCreateGcsBucket(config);
    } catch (err: any) {
      // Check if this is an authentication error
      if (err?.message?.includes('invalid_grant') || err?.message?.includes('reauth') || err?.message?.includes('invalid_rapt')) {
        console.log('Authentication error detected, attempting to refresh credentials...');
        
        // Import Auth utilities
        const { Auth } = await import('./auth');
        
        if (config.projectId) {
          try {
            // Clear expired credentials
            Auth.GCP.clearExpiredCredentials(config.projectId);
            
            // Re-authenticate
            await Auth.GCP.authenticate(config.projectId, config.location);
            
            console.log('Credentials refreshed, retrying GCS bucket operation...');
            
            // Retry the operation
            await Helpers.checkCreateGcsBucket(config);
            
          } catch (authError: any) {
            console.error('Failed to refresh credentials:', authError?.message || authError);
            throw new Error(`Authentication failed: ${authError?.message || authError}`);
          }
        } else {
          throw new Error('Project ID required for credential refresh');
        }
      } else {
        // Re-throw non-auth errors
        throw err;
      }
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
      await Helpers.checkCreateGcsBucketWithRetry({ bucket, ...(opts.gcp?.region ? { location: opts.gcp.region } : {}), ...(opts.gcp?.projectId ? { projectId: opts.gcp.projectId } : {}) } as any);
    }
  }

  /** Ensure secrets provider resources exist before workspace init. For now: supports gcpkms:// only. */
  public static async ensureSecretsProvider(opts: { secretsProviders: string[]; projectId?: string }) {
    for (const provider of opts.secretsProviders) {
      if (provider.startsWith('gcpkms://')) {
        await Helpers.ensureGcpKmsKeyFromUrlWithRetry(provider);
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
    
    if (!credentialsFile || !fs.existsSync(credentialsFile)) {
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
      
      // Check for authentication errors and provide helpful guidance
      if (error?.message?.includes('invalid_grant') || error?.message?.includes('reauth')) {
        console.error('\nAuthentication error detected. This usually means your Google Cloud credentials have expired.');
        console.error('Please run: npx nebula clear-auth (if available) or manually delete expired credential files.');
        console.error('Then run: npx nebula bootstrap to re-authenticate.');
      }
      
      throw error;
    }
  }

  private static async ensureGcpKmsKeyFromUrlWithRetry(providerUrl: string) {
    // Parse the provider URL to get project ID
    const url = new URL(providerUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length < 6) throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    
    const [projectId, , location] = pathParts;
    if (!projectId || !location) {
      throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    }
    
    let credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    
    if (!credentialsFile || !fs.existsSync(credentialsFile)) {
      console.log('No valid credentials file found, attempting to authenticate...');
      const { Auth } = await import('./auth');
      await Auth.GCP.authenticate(projectId, location);
      credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    }
    
    if (!credentialsFile || !fs.existsSync(credentialsFile)) {
      console.error('No credentials file available for KMS key creation');
      return;
    }
    
    try {
      // Try the operation first
      await Helpers.ensureGcpKmsKeyFromUrl(providerUrl);
    } catch (error: any) {
      // Check if this is an authentication error
      if (error?.message?.includes('invalid_grant') || error?.message?.includes('reauth') || error?.message?.includes('invalid_rapt')) {
        console.log('Authentication error detected, attempting to refresh credentials...');
        
        // Import Auth utilities
        const { Auth } = await import('./auth');
        
        try {
          // Clear expired credentials
          Auth.GCP.clearExpiredCredentials(projectId);
          
          // Re-authenticate
          await Auth.GCP.authenticate(projectId, location);
          
          console.log('Credentials refreshed, retrying KMS key operation...');
          
          // Retry the operation
          await Helpers.ensureGcpKmsKeyFromUrl(providerUrl);
          
        } catch (authError: any) {
          console.error('Failed to refresh credentials:', authError?.message || authError);
          throw new Error(`Authentication failed: ${authError?.message || authError}`);
        }
      } else {
        // Re-throw non-auth errors
        throw error;
      }
    }
  }

  /** Resolve refs via vals (e.g., ref+sops://..., ref+aws-ssm://..., etc.). Returns trimmed stdout or throws. */
  public static async resolveVals(ref: string): Promise<string> {
    try {
      const { execFileSync } = await import('child_process');
      // Use vals get with yaml output format for SOPS files
      const stdout = execFileSync('vals', ['get', ref, '-o', 'yaml'], { encoding: 'utf8' });
      return stdout.trim();
    } catch (e: any) {
      const msg = e.stderr || e.message || 'vals evaluation failed';
      throw new Error(`Helpers.resolveVals failed: ${msg}`);
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


  /** Parse a Pulumi config setting provided as string (JSON or vals ref) or object into a plain object. */
  public static async parsePulumiConfigRaw(raw: any): Promise<Record<string, any>> {
    if (!raw) return {};
    if (typeof raw === 'string') {
      if (raw.startsWith('ref+')) {
        return JSON.parse(await Helpers.resolveVals(raw));
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

  /** Convert raw Pulumi config (string or object) into Workspace-ready config map. */
  public static async convertPulumiConfigToWorkspace(raw: any): Promise<Record<string, any>> {
    const parsed = await Helpers.parsePulumiConfigRaw(raw);
    const out: Record<string, any> = {};
    Object.entries(parsed).forEach(([k, v]) => {
      if (typeof v === 'string') {
        // Keep vals references as plain strings - they'll be handled separately
        out[k] = v;
      } else {
        out[k] = { value: v };
      }
    });
    return out;
  }

  /** Resolve secrets using vals and return them for stack.setConfig() */
  public static async resolveSecrets(config: Record<string, any>): Promise<Record<string, string>> {
    const secretEntries = Object.entries(config).filter(([_, v]) => 
      typeof v === 'string' && v.startsWith('ref+')
    );

    const resolvedSecrets: Record<string, string> = {};
    
    for (const [key, secretRef] of secretEntries) {
      try {
        const resolvedValue = await Helpers.resolveVals(secretRef);
        resolvedSecrets[key] = resolvedValue;
        console.log(`Successfully resolved ${key}`);
      } catch (error) {
        console.warn(`Failed to resolve secret for ${key}: ${error}`);
        // Fall back to plain value (not recommended but better than failing)
        try {
          const resolvedValue = await Helpers.resolveVals(secretRef);
          resolvedSecrets[key] = resolvedValue;
          console.log(`Fallback: stored ${key} as plain value`);
        } catch (fallbackError) {
          console.error(`Failed to process ${key}: ${fallbackError}`);
        }
      }
    }
    
    return resolvedSecrets;
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

  /** Return current envId inferred from stack name (envId-component). */
  public static getCurrentEnvId(): string | undefined {
    try {
      const stack = pulumi.getStack();
      const idx = stack.indexOf('-');
      if (idx > 0) return stack.substring(0, idx);
      return undefined;
    } catch { return undefined; }
  }

  /** Parse stack ref strings like:
   * - stack://component/outputKey (env = current env)
   * - stack://env/component/outputKey
   * - stack:component:outputKey
   * - stack:env:component:outputKey
   */
  public static tryParseStackRef(value: string): { envId?: string; component: string; output: string } | undefined {
    if (typeof value !== 'string') return undefined;
    if (value.startsWith('stack://')) {
      const rest = value.slice('stack://'.length);
      const raw = rest.split('/');
      const parts = raw.filter((p): p is string => Boolean(p));
      if (parts.length === 2) {
        const e = Helpers.getCurrentEnvId();
        if (!e) return undefined;
        const component = parts[0] as string;
        const output = parts[1] as string;
        return { envId: e, component, output };
      } else if (parts.length === 3) {
        const envId = parts[0] as string;
        const component = parts[1] as string;
        const output = parts[2] as string;
        return { envId, component, output };
      }
      return undefined;
    }
    if (value.startsWith('stack:')) {
      const rest = value.slice('stack:'.length);
      const raw = rest.split(':');
      const parts = raw.filter((p): p is string => Boolean(p));
      if (parts.length === 2) {
        const e = Helpers.getCurrentEnvId();
        if (!e) return undefined;
        const component = parts[0] as string;
        const output = parts[1] as string;
        return { envId: e, component, output };
      } else if (parts.length === 3) {
        const envId = parts[0] as string;
        const component = parts[1] as string;
        const output = parts[2] as string;
        return { envId, component, output };
      }
      return undefined;
    }
    return undefined;
  }

  private static stackRefCache = new Map<string, pulumi.StackReference>();

  /** Get a StackReference for the given envId + component using current project. */
  public static getStackRef(envId: string | undefined, component: string): pulumi.StackReference {
    const project = pulumi.getProject();
    const inferred = Helpers.getCurrentEnvId();
    const cid = String(envId ?? inferred ?? 'default').toLowerCase();
    const comp = component.toLowerCase();
    const stackName = `${cid}-${comp}`;
    // Use fully-qualified ref when running against Pulumi Service
    const orgEnv = process.env['PULUMI_ORG'] || process.env['PULUMI_ORGANIZATION'];
    const pulumiCfg = new pulumi.Config('pulumi');
    const orgCfg = pulumiCfg.get('organization');
    // Default to 'organization' to support local/file backends that require this placeholder
    const org = orgEnv || orgCfg || 'organization';
    const refName = org ? `${org}/${project}/${stackName}` : `${project}/${stackName}`;
    const key = refName;
    let ref = Helpers.stackRefCache.get(key);
    if (!ref) {
      ref = new pulumi.StackReference(refName);
      Helpers.stackRefCache.set(key, ref);
    }
    return ref;
  }

  /** Recursively walk an object/array and replace any stack://... or stack:... strings with StackReference outputs. */
  public static resolveStackRefsDeep<T = any>(value: T): any {
    if (value == null) return value;
    if (typeof value === 'string') {
      const parsed = Helpers.tryParseStackRef(value);
      if (parsed) {
        const ref = Helpers.getStackRef(parsed.envId, parsed.component);
        return ref.getOutput(parsed.output);
      }
      return value;
    }
    if (Array.isArray(value)) {
      return value.map(v => Helpers.resolveStackRefsDeep(v));
    }
    if (typeof value === 'object') {
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value as any)) {
        out[k] = Helpers.resolveStackRefsDeep(v as any);
      }
      return out;
    }
    return value;
  }
}
