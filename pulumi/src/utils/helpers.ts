import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as YAML from 'yaml';
import * as https from 'https';
import { execSync, execFileSync } from 'child_process';
import * as pulumi from '@pulumi/pulumi';
import * as crypto from 'crypto';
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
   * Cache for resolved ref+ secrets: ref+ string -> config key
   * This ensures we reuse the same config key for the same ref+ string
   */
  private static resolvedSecretsCache: Map<string, string> = new Map();

  /**
   * Get or create a config key for a resolved ref+ secret
   * Uses hash of ref+ string to generate deterministic key
   * Format: nebula:resolved-secret:{hash}
   */
  private static getConfigKeyForRefSecret(ref: string): string {
    // Check cache first
    if (Helpers.resolvedSecretsCache.has(ref)) {
      return Helpers.resolvedSecretsCache.get(ref)!;
    }

    // Generate deterministic hash of ref+ string
    const hash = crypto.createHash('sha256').update(ref).digest('hex').substring(0, 16);
    
    // Get project name safely (fallback to 'nebula' if not available)
    let projectName = 'nebula';
    try {
      projectName = pulumi.getProject();
    } catch {
      // Pulumi runtime not initialized yet, use default
    }
    
    const configKey = `${projectName}:resolved-secret:${hash}`;
    
    // Cache it
    Helpers.resolvedSecretsCache.set(ref, configKey);
    
    return configKey;
  }

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
        console.log(`  ✅ S3 bucket ${config.bucket} already exists`);
      } catch (error: any) {
        if (error.name === 'NotFound') {
          // Bucket doesn't exist, create it
          console.log(`  📦 Creating S3 bucket: ${config.bucket}`);
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
          
          console.log(`  ✅ S3 bucket ${config.bucket} created successfully`);
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
      // Read credentials file to extract projectId if not provided
      let projectId = config.projectId;
      if (!projectId) {
        try {
          const credentialsContent = fs.readFileSync(credentialsFile, 'utf8');
          const credentials = JSON.parse(credentialsContent);
          projectId = credentials.quota_project_id || credentials.project_id;
          if (projectId) {
            console.log(`Using project ID from credentials: ${projectId}`);
          }
        } catch (error) {
          console.log('Could not read project ID from credentials file');
        }
      }
      
      // Initialize Storage client with credentials
      const storageOptions: any = {
        keyFilename: credentialsFile
      };
      
      if (projectId) {
        storageOptions.projectId = projectId;
      }
      
      const storage = new Storage(storageOptions);
      
      // Check if bucket exists
      const [exists] = await storage.bucket(config.bucket).exists();
      
      if (exists) {
        console.log(`  ✅ GCS bucket ${config.bucket} already exists`);
        return;
      }
      
      // Create bucket
      console.log(`  📦 Creating GCS bucket: ${config.bucket}`);
      const bucketOptions: any = {};
      
      if (config.location) {
        bucketOptions.location = config.location;
      }
      
      if (projectId) {
        bucketOptions.projectId = projectId;
      }
      
      await storage.createBucket(config.bucket, bucketOptions);
      console.log(`  ✅ GCS bucket ${config.bucket} created successfully`);
      
    } catch (err: any) {
      console.error(`Failed to create GCS bucket ${config.bucket}:`, err?.message || err);
      
      // Check for authentication errors and provide helpful guidance
      if (err?.message?.includes('invalid_grant') || err?.message?.includes('reauth')) {
        console.error('\nAuthentication error detected. This usually means your Google Cloud credentials have expired.');
        console.error('Please run: npx nebula clear-auth (if available) or manually delete expired credential files.');
        console.error('Then run: npx nebula bootstrap to re-authenticate.');
      }
      
      // Check for project ID errors
      if (err?.message?.includes('Unable to detect a Project Id') || err?.message?.includes('Project ID')) {
        console.error('\nProject ID not found. Please ensure:');
        console.error('1. Your credentials file contains quota_project_id or project_id field');
        console.error('2. Pass projectId explicitly in the config');
        console.error('3. Or set CLOUDSDK_CORE_PROJECT environment variable');
      }
      
      throw err;
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
        
        // Try to get projectId from config, or try to extract from credentials
        let projectId = config.projectId;
        
        if (!projectId) {
          // Try to get projectId from environment variable or credentials file
          const credsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
          if (credsFile && fs.existsSync(credsFile)) {
            try {
              const creds = JSON.parse(fs.readFileSync(credsFile, 'utf8'));
              projectId = creds.project_id || creds.quota_project_id;
            } catch (e) {
              // Ignore errors reading credentials
            }
          }
        }
        
        if (projectId) {
          try {
            // Clear expired credentials
            Auth.GCP.clearExpiredCredentials(projectId);
            
            // Re-authenticate
            await Auth.GCP.authenticate(projectId, config.location);
            
            console.log('Credentials refreshed, retrying GCS bucket operation...');
            
            // Retry the operation with projectId now set
            await Helpers.checkCreateGcsBucket({ ...config, projectId });
            
          } catch (authError: any) {
            console.error('Failed to refresh credentials:', authError?.message || authError);
            throw new Error(`Authentication failed: ${authError?.message || authError}`);
          }
        } else {
          throw new Error('Project ID required for credential refresh. Please set gcp:project in your config or provide it in the credentials file.');
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
   * Get access token from credentials file, refreshing if expired
   * @param projectId - The GCP project ID
   * @returns Access token or null if not available
   */
  private static async getAccessToken(projectId: string): Promise<string | null> {
    try {
      const homeDir = os.homedir();
      const accessTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
      
      if (!fs.existsSync(accessTokenFilePath)) {
        return null;
      }

      const tokenData = JSON.parse(fs.readFileSync(accessTokenFilePath, 'utf8'));
      const now = Date.now();
      const expiresAt = tokenData.expires_at || 0;

      // If token is expired and we have a refresh token, try to refresh it
      if (now >= expiresAt && tokenData.refresh_token) {
        try {
          const { Auth } = await import('./auth');
          const refreshed = await Auth.GCP.refreshAccessToken(projectId);
          if (refreshed?.access_token) {
            return refreshed.access_token;
          }
        } catch (error) {
          console.warn(`Failed to refresh token: ${error}`);
          // Fall through to return existing token (might still work)
        }
      }

      return tokenData.access_token || null;
    } catch (error) {
      console.warn(`Failed to read access token: ${error}`);
      return null;
    }
  }

  /**
   * Enable a GCP API using the Service Usage REST API
   * @param projectId - The GCP project ID
   * @param apiName - The API name (e.g., 'compute.googleapis.com')
   * @param accessToken - The OAuth access token
   * @returns Promise that resolves to true if enabled, false otherwise
   */
  private static async enableGcpApi(projectId: string, apiName: string, accessToken: string): Promise<boolean> {
    return new Promise((resolve) => {
      const serviceName = `projects/${projectId}/services/${apiName}`;
      const postData = JSON.stringify({});

      const options = {
        hostname: 'serviceusage.googleapis.com',
        path: `/v1/${serviceName}:enable`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk.toString();
        });

        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204) {
            resolve(true);
          } else if (res.statusCode === 400 || res.statusCode === 409) {
            // API might already be enabled or invalid request
            // 400: Bad Request (often means already enabled)
            // 409: Conflict (resource already exists)
            try {
              const error = JSON.parse(data);
              const errorMessage = error.error?.message || '';
              if (errorMessage.includes('already enabled') || 
                  errorMessage.includes('already exists') ||
                  errorMessage.includes('already been enabled') ||
                  res.statusCode === 409) {
                resolve(true); // Consider already enabled as success
              } else {
                console.warn(`Failed to enable ${apiName}: ${errorMessage || res.statusCode}`);
                resolve(false);
              }
            } catch {
              // If we can't parse the error, check status code
              if (res.statusCode === 409) {
                resolve(true); // 409 usually means already enabled
              } else {
                resolve(false);
              }
            }
          } else {
            // Log error for debugging
            try {
              const error = JSON.parse(data);
              console.warn(`Failed to enable ${apiName}: ${error.error?.message || res.statusCode}`);
            } catch {
              console.warn(`Failed to enable ${apiName}: HTTP ${res.statusCode}`);
            }
            resolve(false);
          }
        });
      });

      req.on('error', (error) => {
        console.warn(`Failed to enable ${apiName}: ${error.message}`);
        resolve(false);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        resolve(false);
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * Enable required GCP APIs for the project
   * @param projectId - The GCP project ID
   */
  public static async enableGcpApis(projectId: string): Promise<void> {
    if (execSync('id -u').toString().trim() === '999') {
      return;
    }

    // Get access token from credentials (will refresh if expired)
    const accessToken = await Helpers.getAccessToken(projectId);
    if (!accessToken) {
      console.warn('⚠ No valid access token found. Skipping GCP API enablement. Please ensure you are authenticated.');
      return;
    }

    // List of required GCP APIs based on codebase usage
    const requiredApis = [
      'compute.googleapis.com',           // Compute Engine (VMs, networks, firewalls, load balancers)
      'container.googleapis.com',          // Kubernetes Engine (GKE)
      'iam.googleapis.com',                // Identity and Access Management
      'storage.googleapis.com',            // Cloud Storage (backend storage)
      'cloudkms.googleapis.com',           // Cloud KMS (secrets management)
      'secretmanager.googleapis.com',      // Secret Manager (confidential containers)
      'dns.googleapis.com',                // Cloud DNS (DNS management)
      'logging.googleapis.com',            // Cloud Logging (GKE logging)
      'monitoring.googleapis.com',         // Cloud Monitoring (GKE monitoring)
      'serviceusage.googleapis.com',       // Service Usage (used by Karpenter)
    ];

    console.log(`🔧 Enabling required GCP APIs for project: ${projectId}`);

    const enabledApis: string[] = [];
    const failedApis: string[] = [];

    // Enable APIs in parallel for better performance
    const enablePromises = requiredApis.map(async (api) => {
      const success = await Helpers.enableGcpApi(projectId, api, accessToken);
      if (success) {
        enabledApis.push(api);
      } else {
        failedApis.push(api);
      }
    });

    await Promise.all(enablePromises);

    if (enabledApis.length > 0) {
      console.log(`  ✅ Enabled ${enabledApis.length} GCP API(s)`);
    }
    if (failedApis.length > 0) {
      console.warn(`  ⚠️  Failed to enable ${failedApis.length} GCP API(s). Some operations may fail if APIs are not enabled.`);
    }
    console.log('GCP API enablement completed');
  }

  /**
   * Bootstrap backend storage and secrets providers for all environments.
   * This is a utility function that should be called from the CLI layer.
   */
  public static async bootstrap(projectId: string, environments: Record<string, any>, projectConfig?: any): Promise<{ envVars: Record<string, string> }> {
    // Extract settings from environment configs
    const envConfigs = Object.values(environments).filter(Boolean) as any[];
    const envSettings = envConfigs.map(cfg => cfg.settings || {});

    // Backend URL taken from project config
    const backendUrl = projectConfig?.backendUrl;

    // Parse first available config (string or object) and extract cloud details
    const firstRawConfig = envSettings.find(s => s.config != null)?.config;
    
    // Parse config if it's a string (JSON)
    let parsedConfig: Record<string, any> = {};
    if (firstRawConfig) {
      if (typeof firstRawConfig === 'string') {
        try {
          parsedConfig = JSON.parse(firstRawConfig);
        } catch {
          // If parsing fails, treat as empty config
          parsedConfig = {};
        }
      } else if (typeof firstRawConfig === 'object') {
        parsedConfig = firstRawConfig;
      }
    }
    
    // Extract AWS config
    const awsConfig = parsedConfig['aws:region'] || parsedConfig['aws:profile'] ? {
      region: parsedConfig['aws:region'],
      profile: parsedConfig['aws:profile'],
    } : undefined;
    
    // Extract GCP config
    const gcpConfig = parsedConfig['gcp:project'] || parsedConfig['gcp:region'] ? {
      projectId: parsedConfig['gcp:project'],
      region: parsedConfig['gcp:region'],
    } : undefined;

    const envVars: Record<string, string> = {};

    // Authenticate with GCP if GCP config is present
    if (gcpConfig?.projectId) {
      const { Auth } = await import('./auth');
      await Auth.GCP.authenticate(gcpConfig.projectId, gcpConfig.region);
      
      // Capture environment variables set by authentication
      const credsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
      if (credsFile) {
        envVars['GOOGLE_APPLICATION_CREDENTIALS'] = credsFile;
      }
      if (process.env['CLOUDSDK_CORE_PROJECT']) {
        envVars['CLOUDSDK_CORE_PROJECT'] = process.env['CLOUDSDK_CORE_PROJECT'];
      }
      if (process.env['CLOUDSDK_COMPUTE_ZONE']) {
        envVars['CLOUDSDK_COMPUTE_ZONE'] = process.env['CLOUDSDK_COMPUTE_ZONE'];
      }
      
      // Enable required GCP APIs after authentication
      await Helpers.enableGcpApis(gcpConfig.projectId);
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

    // Setup SOPS config for GCP KMS - handle multiple providers
    // Create separate rules for each environment
    // Each environment gets access to shared secrets.yaml AND its own env-specific secrets
    const envNames = Object.keys(environments);
    for (const envName of envNames) {
      // Use the KMS key for this environment (get from env settings)
      const envConfig = environments[envName];
      const envKmsProvider = envConfig?.settings?.secretsProvider;
      
      if (envKmsProvider && envKmsProvider.startsWith('gcpkms://')) {
        const resource = envKmsProvider.replace(/^gcpkms:\/\//, '');
        // Each env rule includes both shared secrets.yaml and env-specific secrets
        Helpers.ensureSopsConfig({ 
          gcpKmsResourceId: resource, 
          patterns: [
            `secrets\\.yaml`,
            `secrets-${projectId}-${envName}\\.yaml`
          ] 
        });
      }
    }

    return { envVars };
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
        console.log(`  ✅ Key ring ${keyRingPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.log(`  🔐 Creating key ring: ${keyRingPath}`);
          await kmsClient.createKeyRing({
            parent: kmsClient.locationPath(projectId, location),
            keyRingId: keyRingId
          });
          console.log(`  ✅ Key ring ${keyRingPath} created successfully`);
        } else {
          throw error;
        }
      }
      
      // Check if crypto key exists
      try {
        await kmsClient.getCryptoKey({ name: cryptoKeyPath });
        console.log(`  ✅ Crypto key ${cryptoKeyPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.log(`  🔐 Creating crypto key: ${cryptoKeyPath}`);
          await kmsClient.createCryptoKey({
            parent: keyRingPath,
            cryptoKeyId: cryptoKeyId,
            cryptoKey: {
              purpose: 'ENCRYPT_DECRYPT'
            }
          });
          console.log(`  ✅ Crypto key ${cryptoKeyPath} created successfully`);
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

  /** Synchronous version of resolveVals for use in transforms (plain strings only) */
  private static resolveValsSync(ref: string, debug: boolean = false): string {
    if (debug) {
      pulumi.log.debug(`[SecretResolution] Calling vals to resolve: ${ref}`);
    }
    try {
      // Use execFileSync for array-based command arguments
      const stdout = execFileSync('vals', ['get', ref, '-o', 'yaml'], { encoding: 'utf8' });
      const result = stdout.trim();
      if (debug) {
        pulumi.log.debug(`[SecretResolution] vals resolved successfully (length: ${result.length})`);
      }
      return result;
    } catch (e: any) {
      const msg = e.stderr || e.message || 'vals evaluation failed';
      if (debug) {
        pulumi.log.error(`[SecretResolution] vals command failed for ${ref}: ${msg}`);
      }
      throw new Error(`Helpers.resolveValsSync failed: ${msg}`);
    }
  }

  /** Ensure .sops.yaml exists and references the provided GCP KMS key for given patterns. */
  public static ensureSopsConfig(opts: { gcpKmsResourceId: string; patterns: string[] }) {
    const sopsPath = path.resolve(process.cwd(), '.sops.yaml');
    
    // Read existing config if it exists
    const existingConfig = Helpers.readSopsConfig(sopsPath);
    
    // Create new rule
    const newRule = {
      gcp_kms: opts.gcpKmsResourceId,
      path_regex: opts.patterns.join('|'),
    };
    
    // Merge with existing rules (avoid duplicates)
    const existingRules = existingConfig?.creation_rules || [];
    const ruleExists = existingRules.some((rule: any) => 
      rule.gcp_kms === newRule.gcp_kms && rule.path_regex === newRule.path_regex
    );
    
    if (!ruleExists) {
      existingRules.push(newRule);
    }
    
    const cfg = {
      creation_rules: existingRules,
      stores: existingConfig?.stores || { yaml: { indent: 2 } },
    };
    
    Helpers.writeSopsConfig(sopsPath, cfg as any);
  }

  /** Read existing SOPS config if it exists */
  private static readSopsConfig(pathname: string): { creation_rules?: any[]; stores?: any } | null {
    try {
      if (fs.existsSync(pathname)) {
        const content = fs.readFileSync(pathname, 'utf8');
        return YAML.parse(content);
      }
    } catch (error) {
      console.log(`Failed to read existing SOPS config: ${error}`);
    }
    return null;
  }

  private static writeSopsConfig(pathname: string, cfg: { creation_rules: any[]; stores: { yaml: { indent: number } } }) {
    try {
      fs.writeFileSync(pathname, '# Generated by Pulumi\n' + YAML.stringify(cfg, { indent: 2 }));
    } catch (error) {
      console.log(`Failed to write SOPS config: ${error}`);
    }
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

  /**
   * Register a resolved ref+ secret in PULUMI_CONFIG_SECRET_KEYS without wrapping in pulumi.secret()
   * This is used for Helm Charts where nested Outputs cause serialization issues
   */
  private static registerResolvedSecretPlain(ref: string, resolvedValue: string, debug: boolean = false): string {
    const configKey = Helpers.getConfigKeyForRefSecret(ref);
    
    if (debug) {
      pulumi.log.debug(`[SecretResolution] Registering secret with config key: ${configKey}`);
    }
    
    try {
      // Add key to PULUMI_CONFIG_SECRET_KEYS environment variable
      let currentSecretKeys: string[] = [];
      const envSecretKeys = process.env['PULUMI_CONFIG_SECRET_KEYS'];
      
      if (envSecretKeys) {
        try {
          currentSecretKeys = JSON.parse(envSecretKeys) || [];
          if (debug) {
            pulumi.log.debug(`[SecretResolution] Found ${currentSecretKeys.length} existing secret keys`);
          }
        } catch {
          currentSecretKeys = [];
          if (debug) {
            pulumi.log.debug(`[SecretResolution] Failed to parse existing secret keys, starting fresh`);
          }
        }
      }
      
      if (!currentSecretKeys.includes(configKey)) {
        currentSecretKeys.push(configKey);
        process.env['PULUMI_CONFIG_SECRET_KEYS'] = JSON.stringify(currentSecretKeys);
        
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Added config key to PULUMI_CONFIG_SECRET_KEYS (total: ${currentSecretKeys.length})`);
        }
        
        // Also update store.config for Pulumi runtime
        try {
          const runtimeConfig = require('@pulumi/pulumi/runtime/config') as any;
          const runtimeState = require('@pulumi/pulumi/runtime/state') as any;
          const store = runtimeState.getStore();
          if (store?.config) {
            store.config[runtimeConfig.configSecretKeysEnvKey] = JSON.stringify(currentSecretKeys);
            if (debug) {
              pulumi.log.debug(`[SecretResolution] Updated runtime store config`);
            }
          }
        } catch (e) {
          if (debug) {
            pulumi.log.debug(`[SecretResolution] Failed to update runtime store (env var still set): ${e}`);
          }
          // Silent fail - env var is set
        }
      } else {
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Config key already registered, skipping`);
        }
      }
    } catch (e) {
      if (debug) {
        pulumi.log.error(`[SecretResolution] Failed to register secret: ${e}`);
      }
      // Silent fail
    }

    // Return plain string (not wrapped in pulumi.secret())
    // Key-level tracking in PULUMI_CONFIG_SECRET_KEYS enables Pulumi to recognize it as a secret
    return resolvedValue;
  }

  /**
   * Recursively walk through props and resolve ref+ strings to secret outputs
   * Similar to resolveStackRefsDeep but for ref+ secrets
   * 
   * Note: This function only processes plain values. Pulumi Outputs are skipped
   * because ref+ strings should always be plain strings, not wrapped in Outputs.
   * If a ref+ string is inside an Output, it cannot be resolved synchronously.
   * 
   * @param value - The value to process
   * @param debug - If true, logs debug information
   * @param path - Optional path for debugging (shows where in the object tree we are)
   */
  public static resolveRefPlusSecretsDeep(
    value: any, 
    debug: boolean = false,
    path: string = ''
  ): any {
    if (value == null) {
      if (debug && path) {
        pulumi.log.debug(`[SecretResolution] Skipping null/undefined at path: ${path}`);
      }
      return value;
    }
    
    // Skip Pulumi Outputs - ref+ strings should always be plain strings
    // If they're wrapped in Outputs, we can't resolve them synchronously anyway
    if (pulumi.Output.isInstance(value)) {
      if (debug) {
        pulumi.log.debug(`[SecretResolution] Skipping Pulumi Output at path: ${path || 'root'}`);
      }
      return value;
    }
    
    // Handle strings - check if they start with ref+
    if (typeof value === 'string' && value.startsWith('ref+')) {
      if (debug) {
        pulumi.log.debug(`[SecretResolution] Found ref+ string at path: ${path || 'root'} - ${value}`);
      }
      try {
        // Resolve the secret synchronously
        const resolvedValue = Helpers.resolveValsSync(value, debug);
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Resolved secret at path: ${path || 'root'} (length: ${resolvedValue.length})`);
        }
        // Register in PULUMI_CONFIG_SECRET_KEYS for key-level tracking
        // This should be sufficient for Pulumi to recognize it as a secret
        return Helpers.registerResolvedSecretPlain(value, resolvedValue, debug);
      } catch (error: any) {
        if (debug) {
          pulumi.log.error(`[SecretResolution] Failed to resolve ${value} at path: ${path || 'root'}: ${error.message}`);
        }
        // If resolution fails, return original value
        return value;
      }
    }
    
    // Handle arrays - recursively process each element
    if (Array.isArray(value)) {
      if (debug) {
        pulumi.log.debug(`[SecretResolution] Processing array at path: ${path || 'root'} (length: ${value.length})`);
      }
      return value.map((v, idx) => Helpers.resolveRefPlusSecretsDeep(v, debug, path ? `${path}[${idx}]` : `[${idx}]`));
    }
    
    // Handle objects - recursively process each property
    if (typeof value === 'object') {
      // Skip certain object types that shouldn't be processed
      if (value instanceof Date || value instanceof RegExp || value instanceof Error) {
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Skipping special object type at path: ${path || 'root'} (${value.constructor.name})`);
        }
        return value;
      }
      
      // Check if object has a constructor that's not Object (might be a class instance)
      const constructor = value.constructor;
      if (constructor !== Object && constructor !== undefined && constructor.name !== 'Object') {
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Skipping object with constructor: ${constructor.name} at path: ${path || 'root'}`);
        }
        return value;
      }
      
      if (debug) {
        const keys = Object.keys(value);
        pulumi.log.debug(`[SecretResolution] Processing object at path: ${path || 'root'} (keys: ${keys.join(', ')})`);
      }
      
      const out: Record<string, any> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = Helpers.resolveRefPlusSecretsDeep(v, debug, path ? `${path}.${k}` : k);
      }
      return out;
    }
    
    // For other types (numbers, booleans, etc.), return as-is
    if (debug && path) {
      pulumi.log.debug(`[SecretResolution] Skipping primitive type at path: ${path} (${typeof value})`);
    }
    return value;
  }

  /**
   * Register a global resource transform that resolves ref+ secrets in resource arguments
   * This uses pulumi.runtime.registerResourceTransform to apply the transform to all resources
   * in the stack, rather than adding transformations to individual components.
   * 
   * The transform processes only args.props (resource arguments) recursively.
   * Secrets are resolved as plain strings and registered in PULUMI_CONFIG_SECRET_KEYS
   * for key-level tracking, which should be sufficient for Pulumi to recognize them
   * as secrets in preview and state.
   * 
   * Note: For Helm Charts, if `values` is a Pulumi Output, it will be skipped to avoid
   * serialization issues. Helm Chart values must be plain objects (not Outputs).
   * 
   * @param debug - If true, logs debug information about transform execution
   */
  public static registerSecretResolutionTransform(debug: boolean = false): void {
    // Use a flag to ensure we only register once, but allow updating debug flag
    if ((Helpers as any)._secretTransformRegistered) {
      // If debug is requested, update the debug flag even if already registered
      if (debug) {
        (Helpers as any)._secretTransformDebug = true;
        try {
          pulumi.log.debug(`[SecretResolution] Transform already registered, enabling debug mode`);
        } catch {
          // Pulumi runtime not available yet
        }
      }
      return;
    }

    // Check if Pulumi runtime is available before trying to register
    try {
      if (!pulumi.runtime || typeof pulumi.runtime.registerResourceTransform !== 'function') {
        // Runtime not available yet, mark as attempted so Environment constructor can retry
        (Helpers as any)._secretTransformAttempted = true;
        return;
      }
    } catch {
      // Pulumi runtime not available yet, mark as attempted so Environment constructor can retry
      (Helpers as any)._secretTransformAttempted = true;
      return;
    }

    (Helpers as any)._secretTransformRegistered = true;
    (Helpers as any)._secretTransformDebug = debug;

    // Log registration if debug is enabled
    if (debug) {
      try {
        pulumi.log.debug(`[SecretResolution] Registering global resource transform for secret resolution`);
      } catch {
        // Pulumi runtime not fully initialized yet, but registration will proceed
      }
    }

    pulumi.runtime.registerResourceTransform((args: any) => {
      const isDebug = (Helpers as any)._secretTransformDebug || false;
      
      // Only process args.props (resource arguments), not opts
      if (!args || !args.props) {
        if (isDebug) {
          pulumi.log.debug(`[SecretResolution] Skipping transform: no args or props`);
        }
        return undefined; // Return undefined to indicate no transformation
      }

      const resourceType = args.type || 'unknown';
      const resourceName = args.name || 'unknown';
      
      if (isDebug) {
        pulumi.log.debug(`[SecretResolution] Transform invoked for: ${resourceType}::${resourceName}`);
        pulumi.log.debug(`[SecretResolution] Processing props (keys: ${Object.keys(args.props).join(', ')})`);
      }

      // Process only args.props recursively (resource arguments)
      // The resolveRefPlusSecretsDeep function skips non-plain objects (class instances, etc.)
      // which should prevent serialization issues with special Pulumi types
      const resolvedProps = Helpers.resolveRefPlusSecretsDeep(args.props, isDebug, 'props');
      
      if (isDebug) {
        pulumi.log.debug(`[SecretResolution] Transform completed for resource: ${resourceType}::${resourceName}`);
      }
      
      // Return transformed args with resolved props
      return {
        props: resolvedProps,
        opts: args.opts,
      };
    });
  }
}

// Register the secret resolution transform at module load time
// This ensures it's registered before any resources are created, regardless of when
// Project/Environment classes are instantiated. This is critical because transforms
// only apply to resources created AFTER they are registered.
// 
// We use a try-catch to handle cases where Pulumi runtime isn't initialized yet
// (e.g., during module import in non-Pulumi contexts). The transform will be
// registered when the module is imported in a Pulumi context.
try {
  // Try to register immediately - this will work if Pulumi runtime is available
  // The registerSecretResolutionTransform function handles the case where runtime isn't ready
  Helpers.registerSecretResolutionTransform(false); // Register without debug by default
} catch (e) {
  // Pulumi runtime not available yet, will be registered when Environment is created
  // This is a fallback for cases where the module is imported before Pulumi is initialized
  // Silently continue - registration will happen in Environment constructor
}
