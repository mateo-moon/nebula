import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as YAML from 'yaml';
import * as https from 'https';
import { execSync, spawnSync } from 'child_process';
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
 * Helpers - Utility methods for cloud provider setup, authentication, and secrets management.
 * 
 * Key capabilities:
 * - Cloud bucket creation (S3, GCS) for Pulumi state storage
 * - GCP KMS key management for secrets encryption
 * - GCP API enablement
 * - Secret resolution (ref+ pattern) via vals
 * - Stack reference resolution
 * - SOPS configuration management
 */
export class Helpers {
  /**
   * Cache for resolved ref+ secrets: ref+ string -> config key
   * This ensures we reuse the same config key for the same ref+ string
   */
  private static resolvedSecretsCache: Map<string, string> = new Map();
  
  /**
   * Cache for resolved secret values: resolved value -> original ref+ string
   * This allows us to recognize already-resolved secrets when they appear in resource properties
   */
  private static resolvedSecretValues: Map<string, string> = new Map();

  /**
   * Find the nearest project root (directory containing package.json)
   * moving up from the start directory.
   */
  private static findNearestProjectRoot(startDir: string): string {
    let currentDir = path.resolve(startDir);
    const root = path.parse(currentDir).root;
    while (currentDir !== root) {
      if (fs.existsSync(path.join(currentDir, 'package.json'))) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }
    // Fallback to startDir if no package.json found
    return startDir;
  }

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
        console.error(`  ✅ S3 bucket ${config.bucket} already exists`);
      } catch (error: any) {
        if (error.name === 'NotFound') {
          // Bucket doesn't exist, create it
          console.error(`  📦 Creating S3 bucket: ${config.bucket}`);
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
          
          console.error(`  ✅ S3 bucket ${config.bucket} created successfully`);
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      console.error(`S3 bucket operation failed: ${error.message}`);
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
            console.error(`Using project ID from credentials: ${projectId}`);
          }
        } catch (error) {
          console.error('Could not read project ID from credentials file');
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
        console.error(`  ✅ GCS bucket ${config.bucket} already exists`);
        return;
      }
      
      // Create bucket
      console.error(`  📦 Creating GCS bucket: ${config.bucket}`);
      const bucketOptions: any = {};
      
      if (config.location) {
        bucketOptions.location = config.location;
      }
      
      if (projectId) {
        bucketOptions.projectId = projectId;
      }
      
      await storage.createBucket(config.bucket, bucketOptions);
      console.error(`  ✅ GCS bucket ${config.bucket} created successfully`);
      
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
      console.error('No valid credentials file found, attempting to authenticate...');
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
        console.error('Authentication error detected, attempting to refresh credentials...');
        
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
            
            console.error('Credentials refreshed, retrying GCS bucket operation...');
            
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
          console.error(`Failed to refresh token: ${error}`);
          // Fall through to return existing token (might still work)
        }
      }

      return tokenData.access_token || null;
    } catch (error) {
      console.error(`Failed to read access token: ${error}`);
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
                console.error(`Failed to enable ${apiName}: ${errorMessage || res.statusCode}`);
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
              console.error(`Failed to enable ${apiName}: ${error.error?.message || res.statusCode}`);
            } catch {
              console.error(`Failed to enable ${apiName}: HTTP ${res.statusCode}`);
            }
            resolve(false);
          }
        });
      });

      req.on('error', (error) => {
        console.error(`Failed to enable ${apiName}: ${error.message}`);
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
      console.error('⚠ No valid access token found. Skipping GCP API enablement. Please ensure you are authenticated.');
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

    process.stderr.write(`🔧 Enabling required GCP APIs for project: ${projectId}\n`);

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
      process.stderr.write(`  ✅ Enabled ${enabledApis.length} GCP APIs\n`);
    }
    if (failedApis.length > 0) {
      process.stderr.write(`  ⚠️  Failed to enable ${failedApis.length} GCP APIs. Some operations may fail if APIs are not enabled.\n`);
    }
    process.stderr.write('GCP API enablement completed\n');
  }

  /**
   * Bootstrap backend storage and secrets providers for the component.
   * This is a utility function that should be called from the CLI layer.
   */
  public static async bootstrap(_componentId: string, config: any, workDir?: string): Promise<{ envVars: Record<string, string> }> {
    // Extract settings from component config
    const settings = config.settings || {};

    // Backend URL taken from project config
    const backendUrl = config.backendUrl;

    // Parse config if it's a string (JSON)
    let parsedConfig: Record<string, any> = {};
    const rawConfig = settings.config;
    
    if (rawConfig) {
      if (typeof rawConfig === 'string') {
        try {
          parsedConfig = JSON.parse(rawConfig);
        } catch {
          // If parsing fails, treat as empty config
          parsedConfig = {};
        }
      } else if (typeof rawConfig === 'object') {
        parsedConfig = rawConfig;
      }
    }
    
    // Extract AWS config
    const awsConfig = parsedConfig['aws:region'] || parsedConfig['aws:profile'] ? {
      region: parsedConfig['aws:region'],
      profile: parsedConfig['aws:profile'],
    } : undefined;
    
    // Extract GCP config from settings.config
    let gcpConfig: { projectId?: string; region?: string } | undefined = 
      parsedConfig['gcp:project'] || parsedConfig['gcp:region'] ? {
        projectId: parsedConfig['gcp:project'],
        region: parsedConfig['gcp:region'],
      } : undefined;
    
    // If no GCP config in settings.config, try to extract from secretsProvider URL
    // Format: gcpkms://projects/PROJECT_ID/locations/LOCATION/keyRings/...
    if (!gcpConfig && settings.secretsProvider?.startsWith('gcpkms://')) {
      try {
        const url = new URL(settings.secretsProvider);
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 4) {
          const extractedProjectId = pathParts[0];
          const extractedLocation = pathParts[2];
          if (extractedProjectId && extractedLocation) {
            gcpConfig = { projectId: extractedProjectId, region: extractedLocation };
          }
        }
      } catch {
        // Invalid URL, continue without GCP config
      }
    }
    
    // If still no GCP config, try to extract from backendUrl (gs://bucket-name)
    // Note: This doesn't give us projectId directly, but we might be able to infer from bucket name
    if (!gcpConfig && backendUrl?.startsWith('gs://')) {
      // Can't extract projectId from bucket URL alone, but note for future enhancement
    }

    const envVars: Record<string, string> = {};

    // Authenticate if GCP project is configured
    let primaryProjectId: string | null = null;
    let primaryRegion: string | null = null;
    
    if (gcpConfig?.projectId) {
      const { Auth } = await import('./auth');
      const projectId = gcpConfig.projectId;
      const region = gcpConfig.region;
      
      try {
        // Authenticate this project
        // Check if token exists
        if (await Auth.GCP.isTokenValid(projectId)) {
             console.error(`  ✅ Valid token already exists for project: ${projectId}`);
             Auth.GCP.setAccessTokenEnvVar(projectId, region);
        } else {
             await Auth.GCP.authenticate(projectId, region);
        }
        
        primaryProjectId = projectId;
        primaryRegion = region ?? null;
        
      } catch (error: any) {
        console.error(`⚠️  Failed to authenticate for project ${projectId}: ${error?.message || error}`);
      }
      
      // Populate envVars
      if (primaryProjectId) {
        const homeDir = os.homedir();
        const accessTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${primaryProjectId}-accesstoken`);
        envVars['GOOGLE_APPLICATION_CREDENTIALS'] = accessTokenFilePath;
        envVars['CLOUDSDK_CORE_PROJECT'] = primaryProjectId;
        if (primaryRegion) {
          const computeZone = `${primaryRegion}-a`;
          envVars['CLOUDSDK_COMPUTE_ZONE'] = computeZone;
        }
        
        // Enable APIs
        try {
          await Helpers.enableGcpApis(primaryProjectId);
        } catch (error: any) {
           console.error(`⚠️  Failed to enable APIs for project ${primaryProjectId}: ${error?.message || error}`);
        }
      }
    }

    // Ensure backend storage exists prior to workspace init
    await Helpers.ensureBackendForUrl({
      ...(backendUrl ? { backendUrl } : {}),
      ...(awsConfig ? { aws: awsConfig } : {}),
      ...(gcpConfig ? { gcp: gcpConfig } : {}),
    });

    // Ensure secrets provider exists
    if (settings.secretsProvider) {
      await Helpers.ensureSecretsProvider({ 
        secretsProviders: [settings.secretsProvider]
      });
    }

    // Setup SOPS config for GCP KMS
    if (settings.secretsProvider && settings.secretsProvider.startsWith('gcpkms://')) {
        const resource = settings.secretsProvider.replace(/^gcpkms:\/\//, '');
        // Determine credentials file path for SOPS config metadata
        const credentialsFilePath = primaryProjectId 
          ? path.join(os.homedir(), '.config', 'gcloud', `${primaryProjectId}-accesstoken`)
          : undefined;
        
        // Include shared secrets.yaml and any secrets-*.yaml
        const sopsConfigOpts: { gcpKmsResourceId: string; patterns: string[]; credentialsFilePath?: string } = {
          gcpKmsResourceId: resource,
          patterns: [
            `secrets\\.yaml`,
            `secrets-.*\\.yaml`
          ],
        };
        if (credentialsFilePath) {
          sopsConfigOpts.credentialsFilePath = credentialsFilePath;
        }
        // Pass workDir to ensureSopsConfig
        if (workDir) {
          (sopsConfigOpts as any).workDir = workDir;
        }
        Helpers.ensureSopsConfig(sopsConfigOpts);
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
  public static async ensureSecretsProvider(opts: { secretsProviders: string[]; skipInteractiveAuth?: boolean }) {
    // Ensure KMS keys exist (authentication and API enabling should already be done in bootstrap)
    for (const provider of opts.secretsProviders) {
      if (provider.startsWith('gcpkms://')) {
        await Helpers.ensureGcpKmsKeyFromUrlWithRetry(provider, { skipInteractiveAuth: opts.skipInteractiveAuth });
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
    
    try {
      // Initialize KMS client
      // If GOOGLE_APPLICATION_CREDENTIALS is set, use it; otherwise use ADC (Workload Identity)
      const kmsClient = new KeyManagementServiceClient({
        ...(credentialsFile && fs.existsSync(credentialsFile) ? { keyFilename: credentialsFile } : {}),
        projectId: projectId
      });
      
      const keyRingPath = kmsClient.keyRingPath(projectId, location, keyRingId);
      const cryptoKeyPath = kmsClient.cryptoKeyPath(projectId, location, keyRingId, cryptoKeyId);
      
      // Check if key ring exists
      try {
        await kmsClient.getKeyRing({ name: keyRingPath });
        console.error(`  ✅ Key ring ${keyRingPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.error(`  🔐 Creating key ring: ${keyRingPath}`);
          await kmsClient.createKeyRing({
            parent: kmsClient.locationPath(projectId, location),
            keyRingId: keyRingId
          });
          console.error(`  ✅ Key ring ${keyRingPath} created successfully`);
        } else {
          throw error;
        }
      }
      
      // Check if crypto key exists
      try {
        await kmsClient.getCryptoKey({ name: cryptoKeyPath });
        console.error(`  ✅ Crypto key ${cryptoKeyPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.error(`  🔐 Creating crypto key: ${cryptoKeyPath}`);
          await kmsClient.createCryptoKey({
            parent: keyRingPath,
            cryptoKeyId: cryptoKeyId,
            cryptoKey: {
              purpose: 'ENCRYPT_DECRYPT'
            }
          });
          console.error(`  ✅ Crypto key ${cryptoKeyPath} created successfully`);
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

  private static async ensureGcpKmsKeyFromUrlWithRetry(providerUrl: string, options?: { skipInteractiveAuth?: boolean }) {
    // Parse the provider URL to get project ID
    const url = new URL(providerUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length < 6) throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    
    const [projectId, , location] = pathParts;
    if (!projectId || !location) {
      throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    }
    
    const credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    const hasCredentialsFile = credentialsFile && fs.existsSync(credentialsFile);
    
    // If no credentials file and not in CI mode, try interactive auth
    if (!hasCredentialsFile && !options?.skipInteractiveAuth) {
      console.error('No valid credentials file found, attempting to authenticate...');
      const { Auth } = await import('./auth');
      await Auth.GCP.authenticate(projectId, location);
    }
    
    try {
      // Try the operation (will use ADC/Workload Identity if no credentials file)
      await Helpers.ensureGcpKmsKeyFromUrl(providerUrl);
    } catch (error: any) {
      // Check if this is an authentication error
      if (error?.message?.includes('invalid_grant') || error?.message?.includes('reauth') || error?.message?.includes('invalid_rapt')) {
        // Only attempt interactive re-auth if not in CI mode
        if (options?.skipInteractiveAuth) {
          console.error('Authentication error in CI mode - ensure Workload Identity is properly configured');
          throw error;
        }
        
        console.error('Authentication error detected, attempting to refresh credentials...');
        
        // Import Auth utilities
        const { Auth } = await import('./auth');
        
        try {
          // Clear expired credentials
          Auth.GCP.clearExpiredCredentials(projectId);
          
          // Re-authenticate
          await Auth.GCP.authenticate(projectId, location);
          
          console.error('Credentials refreshed, retrying KMS key operation...');
          
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
      const { spawnSync } = await import('child_process');
      // Use spawnSync to suppress SOPS diagnostic messages on stderr
      const result = spawnSync('vals', ['get', ref, '-o', 'yaml'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'] // stdin=ignore, stdout=pipe, stderr=ignore (suppress SOPS diagnostics)
      });
      
      if (result.error) {
        throw result.error;
      }
      
      if (result.status !== 0) {
        // If command failed, run again with stderr captured to get the error message
        const errorResult = spawnSync('vals', ['get', ref, '-o', 'yaml'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'] // Capture stderr for error messages
        });
        const errorMsg = errorResult.stderr?.toString() || errorResult.stdout?.toString() || 'vals evaluation failed';
        throw new Error(`vals command failed: ${errorMsg}`);
      }
      
      return (result.stdout || '').trim();
    } catch (e: any) {
      const msg = e.message || 'vals evaluation failed';
      throw new Error(`Helpers.resolveVals failed: ${msg}`);
    }
  }

  /** Synchronous version of resolveVals for use in transforms (plain strings only) */
  private static resolveValsSync(ref: string, debug: boolean = false): string {
    if (debug) {
      pulumi.log.debug(`[SecretResolution] Calling vals to resolve: ${ref}`);
    }
    try {
      // Use spawnSync to have better control over stderr
      // Redirect stderr to /dev/null to suppress SOPS diagnostic messages (e.g., "sops: successfully retrieved key=...")
      // These messages appear even when the key doesn't exist and are misleading
      const result = spawnSync('vals', ['get', ref, '-o', 'yaml'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'] // Capture stderr for debugging
      });
      
      if (result.error) {
        throw result.error;
      }
      
      if (result.status !== 0) {
        // If command failed, we need to run it again with stderr captured to get the error message
        const errorResult = spawnSync('vals', ['get', ref, '-o', 'yaml'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'] // Capture stderr for error messages
        });
        const errorMsg = errorResult.stderr?.toString() || errorResult.stdout?.toString() || 'vals evaluation failed';
        throw new Error(`vals command failed: ${errorMsg}`);
      }
      
      const resolvedValue = (result.stdout || '').trim();
      
      // Check if secret was actually retrieved
      // If resolved value is empty or unchanged, the secret wasn't retrieved
      if (!resolvedValue || resolvedValue === ref || resolvedValue === 'null' || resolvedValue === '') {
        pulumi.log.warn(
          `[SecretResolution] Secret not retrieved for "${ref}". ` +
          `The resolved value is empty or unchanged. ` +
          `This may indicate the key doesn't exist in the secret file or the file path is incorrect.`
        );
      }
      
      if (debug) {
        pulumi.log.debug(`[SecretResolution] vals resolved successfully (length: ${resolvedValue.length})`);
      }
      return resolvedValue;
    } catch (e: any) {
      const msg = e.message || 'vals evaluation failed';
      if (debug) {
        pulumi.log.error(`[SecretResolution] vals command failed for ${ref}: ${msg}`);
      }
      throw new Error(`Helpers.resolveValsSync failed: ${msg}`);
    }
  }

  /** Ensure .sops.yaml exists and references the provided GCP KMS key for given patterns. */
  public static ensureSopsConfig(opts: { gcpKmsResourceId: string; patterns: string[]; credentialsFilePath?: string; workDir?: string }) {
    // Use workDir if provided, otherwise process.cwd()
    const startDir = opts.workDir ? path.resolve(opts.workDir) : process.cwd();
    // Find the project root (where package.json is) relative to startDir
    const targetDir = Helpers.findNearestProjectRoot(startDir);
    const sopsPath = path.resolve(targetDir, '.sops.yaml');
    
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
    
    const cfg: any = {
      creation_rules: existingRules,
      stores: existingConfig?.stores || { yaml: { indent: 2 } },
    };
    
    // Add metadata about credentials file location if provided
    // This helps users know where to point GOOGLE_APPLICATION_CREDENTIALS
    if (opts.credentialsFilePath) {
      cfg._nebula_credentials = {
        file: opts.credentialsFilePath,
        env_var: 'GOOGLE_APPLICATION_CREDENTIALS',
        note: 'SOPS uses GOOGLE_APPLICATION_CREDENTIALS env var to authenticate with GCP KMS. Set it to the credentials file path above.',
      };
    }
    
    Helpers.writeSopsConfig(sopsPath, cfg);
  }

  /** Read existing SOPS config if it exists */
  private static readSopsConfig(pathname: string): { creation_rules?: any[]; stores?: any } | null {
    try {
      if (fs.existsSync(pathname)) {
        const content = fs.readFileSync(pathname, 'utf8');
        return YAML.parse(content);
      }
    } catch (error) {
      console.error(`Failed to read existing SOPS config: ${error}`);
    }
    return null;
  }

  private static writeSopsConfig(pathname: string, cfg: any) {
    try {
      // Remove metadata from config before writing (SOPS doesn't use it)
      const credentialsInfo = cfg._nebula_credentials;
      delete cfg._nebula_credentials;
      
      fs.writeFileSync(pathname, '# Generated by Nebula/Pulumi\n' + YAML.stringify(cfg, { indent: 2 }));
      
      // Update VS Code settings if credentials info is available
      if (credentialsInfo) {
        Helpers.ensureVSCodeSopsSettings(credentialsInfo.file);
      }
    } catch (error) {
      console.error(`Failed to write SOPS config: ${error}`);
    }
  }

  /** Ensure .vscode/settings.json exists with SOPS credentials configuration */
  private static ensureVSCodeSopsSettings(credentialsFilePath: string): void {
    const vscodeDir = path.resolve(process.cwd(), '.vscode');
    const settingsPath = path.join(vscodeDir, 'settings.json');
    
    try {
      // Ensure .vscode directory exists
      if (!fs.existsSync(vscodeDir)) {
        fs.mkdirSync(vscodeDir, { recursive: true });
      }
      
      // Read existing settings or create new
      let settings: any = {};
      if (fs.existsSync(settingsPath)) {
        try {
          const content = fs.readFileSync(settingsPath, 'utf8');
          settings = JSON.parse(content);
        } catch (error) {
          console.error(`Failed to parse existing VS Code settings: ${error}`);
          settings = {};
        }
      }
      
      // Update or add SOPS extension settings
      // SOPS VS Code extension uses sops.defaults.gcpCredentialsPath
      if (!settings.sops) {
        settings.sops = {};
      }
      if (!settings.sops.defaults) {
        settings.sops.defaults = {};
      }
      settings.sops.defaults.gcpCredentialsPath = credentialsFilePath;
      
      // Write updated settings
      fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
      console.error(`  ✅ Updated VS Code SOPS settings with credentials path: ${credentialsFilePath}`);
    } catch (error) {
      console.error(`Failed to update VS Code settings: ${error}`);
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
  public static tryParseStackRef(value: string): { envId?: string; component?: string; stackName?: string; output: string; propertyPath?: string } | undefined {
    if (typeof value !== 'string') return undefined;
    
    // Helper to process output string for property paths (e.g. "gcp:clusterName" -> output="gcp", path="clusterName")
    const parseOutput = (rawOutput: string): { output: string; propertyPath?: string } => {
      // Handle property access via colon or dot
      if (rawOutput.includes(':')) {
        const parts = rawOutput.split(':');
        const output = parts[0]!;
        const rest = parts.slice(1);
        const propertyPath = rest.join('.');
        return propertyPath ? { output, propertyPath } : { output };
      }
      if (rawOutput.includes('.')) {
        const parts = rawOutput.split('.');
        const output = parts[0]!;
        const rest = parts.slice(1);
        const propertyPath = rest.join('.');
        return propertyPath ? { output, propertyPath } : { output };
      }
      return { output: rawOutput };
    };

    if (value.startsWith('stack://')) {
      const rest = value.slice('stack://'.length);
      const raw = rest.split('/');
      const parts = raw.filter((p): p is string => Boolean(p));
      
      if (parts.length === 2) {
        const e = Helpers.getCurrentEnvId();
        const p0 = parts[0]!;
        const p1 = parts[1]!;
        
        if (!e) {
          // Explicit stack name: stack://my-stack/output
          const { output, propertyPath } = parseOutput(p1);
          return propertyPath 
            ? { stackName: p0, output, propertyPath }
            : { stackName: p0, output };
        }
        // Implicit env: stack://component/output
        const { output, propertyPath } = parseOutput(p1);
        return propertyPath
            ? { envId: e, component: p0, output, propertyPath }
            : { envId: e, component: p0, output };
      } else if (parts.length === 3) {
        // Explicit env: stack://env/component/output
        const p0 = parts[0]!;
        const p1 = parts[1]!;
        const p2 = parts[2]!;
        const { output, propertyPath } = parseOutput(p2);
        return propertyPath
            ? { envId: p0, component: p1, output, propertyPath }
            : { envId: p0, component: p1, output };
      }
      return undefined;
    }
    
    if (value.startsWith('stack:')) {
      const rest = value.slice('stack:'.length);
      const raw = rest.split(':');
      const parts = raw.filter((p): p is string => Boolean(p));
      
      if (parts.length === 2) {
        // stack:comp:output
        const e = Helpers.getCurrentEnvId();
        const p0 = parts[0]!;
        const p1 = parts[1]!;
        
        if (!e) {
          return { stackName: p0, output: p1 };
        }
        const { output, propertyPath } = parseOutput(p1);
        return propertyPath
            ? { envId: e, component: p0, output, propertyPath }
            : { envId: e, component: p0, output };
      } else if (parts.length >= 3) {
        // Ambiguity: stack:env:comp:output VS stack:comp:output:prop
        const e = Helpers.getCurrentEnvId();
        const p0 = parts[0]!;
        const p1 = parts[1]!;
        const p2 = parts[2]!;
        
        // If the first part matches current env, OR is the escape hatch '_', assume explicit env reference
        if ((e && p0 === e) || p0 === '_') {
          // Reconstruct the rest as output + property path
          const remaining = parts.slice(2);
          const output = remaining[0]!;
          const propertyPath = remaining.length > 1 ? remaining.slice(1).join('.') : undefined;
          
          return propertyPath
            ? { envId: p0, component: p1, output, propertyPath }
            : { envId: p0, component: p1, output };
        }
        
        // Otherwise, assume implicit env with property path
        // stack:comp:output:prop:subprop
        if (e) {
          const propertyPath = parts.slice(2).join('.');
          return { 
            envId: e, 
            component: p0, 
            output: p1, 
            propertyPath
          };
        }
        
        // Fallback for no env context: assume explicit env
        const propertyPath = parts.length > 3 ? parts.slice(3).join('.') : undefined;
        return propertyPath
            ? { envId: p0, component: p1, output: p2, propertyPath }
            : { envId: p0, component: p1, output: p2 };
      }
      return undefined;
    }
    return undefined;
  }

  private static stackRefCache = new Map<string, pulumi.StackReference>();

  /** Get a StackReference for the given envId + component using current project. */
  public static getStackRef(envId: string | undefined, component: string | undefined, explicitStackName?: string): pulumi.StackReference {
    const project = pulumi.getProject();
    
    let stackName = explicitStackName;
    if (!stackName) {
      const inferred = Helpers.getCurrentEnvId();
      const cid = String(envId ?? inferred ?? 'default').toLowerCase();
      // Handle escape hatch for non-prefixed stacks
      if (cid === '_') {
        stackName = (component || '').toLowerCase();
      } else {
        const comp = (component || '').toLowerCase();
        stackName = `${cid}-${comp}`;
      }
    }

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
        const ref = Helpers.getStackRef(parsed.envId, parsed.component, parsed.stackName);
        
        // Try to get the output directly (standard behavior)
        const directOutput = ref.getOutput(parsed.output);
        
        // Also check "outputs" wrapper (for components that wrap all outputs)
        const wrappedOutputs = ref.getOutput("outputs");
        
        // Combine them to find the real root object
        const rootObject = pulumi.all([directOutput, wrappedOutputs]).apply(([direct, wrapped]) => {
            // If direct output exists, use it
            if (direct !== undefined) return direct;
            // Otherwise, look inside "outputs" wrapper if it exists
            if (wrapped !== undefined && typeof wrapped === 'object' && parsed.output in wrapped) {
                return wrapped[parsed.output];
            }
            // Return undefined if not found in either place
            return undefined;
        });
        
        if (parsed.propertyPath) {
          return rootObject.apply((v: any) => {
            if (v == null) return undefined;
            
            // Navigate property path
            const props = parsed.propertyPath!.split('.');
            let current = v;
            for (const prop of props) {
              if (current == null) return undefined;
              current = current[prop];
            }
            return current;
          });
        }
        
        return rootObject;
      }
      return value;
    }
    
    // Skip special object types that shouldn't be processed (like Pulumi Asset/Archive)
    if (value instanceof Date || value instanceof RegExp || value instanceof Error) {
      return value;
    }
    // Check if object has a constructor that's not Object (might be a class instance like Asset)
    if (typeof value === 'object' && value !== null) {
      const constructor = (value as any).constructor;
      if (constructor !== Object && constructor !== undefined && constructor.name !== 'Object') {
        return value;
      }
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
            // Set the actual config value in the store - this is critical for Pulumi to recognize it as a secret
            store.config[configKey] = resolvedValue;
            // Also mark it as a secret in the runtime secretKeys set
            if (store.secretKeys) {
              store.secretKeys.add(configKey);
              if (debug) {
                pulumi.log.debug(`[SecretResolution] Added ${configKey} to runtime secretKeys set`);
              }
            }
            if (debug) {
              pulumi.log.debug(`[SecretResolution] Updated runtime store config and set config value`);
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
   * Recursively walk through props and resolve ref+ strings
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
    
    // Handle strings - check if they start with ref+ OR if they match a known resolved secret value
    if (typeof value === 'string') {
      // First check if it's a ref+ string that needs resolution
      if (value.startsWith('ref+')) {
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Found ref+ string at path: ${path || 'root'} - ${value}`);
        }
        try {
          // Resolve the secret synchronously
          const resolvedValue = Helpers.resolveValsSync(value, debug);
          
          // Check if secret was actually retrieved (not empty and different from original ref+ string)
          const secretRetrieved = resolvedValue && resolvedValue !== value && resolvedValue !== 'null' && resolvedValue !== '';
          
          if (!secretRetrieved) {
            // Warning already logged in resolveValsSync, but add context about where it was used
            pulumi.log.warn(
              `[SecretResolution] Secret resolution returned empty/unchanged value at path: ${path || 'root'}. ` +
              `Original ref+ string: "${value}"`
            );
          }
          
          if (debug) {
            pulumi.log.debug(`[SecretResolution] Resolved secret at path: ${path || 'root'} (length: ${resolvedValue.length}, retrieved: ${secretRetrieved})`);
          }
          // Register in PULUMI_CONFIG_SECRET_KEYS for key-level tracking
          // Also track the resolved value so we can recognize it later
          const registeredValue = Helpers.registerResolvedSecretPlain(value, resolvedValue, debug);
          // Track resolved value -> original ref+ mapping
          Helpers.resolvedSecretValues.set(resolvedValue, value);
          return registeredValue;
        } catch (error: any) {
          pulumi.log.warn(
            `[SecretResolution] Failed to resolve "${value}" at path: ${path || 'root'}: ${error.message}. ` +
            `The original ref+ string will be used instead.`
          );
          if (debug) {
            pulumi.log.error(`[SecretResolution] Full error details: ${error.stack || error.message}`);
          }
          // If resolution fails, return original value
          return value;
        }
      }
      
      // Check if this string matches a known resolved secret value
      // This handles secrets that were resolved earlier in the resource tree
      if (Helpers.resolvedSecretValues.has(value)) {
        const originalRef = Helpers.resolvedSecretValues.get(value)!;
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Found known resolved secret value at path: ${path || 'root'} (from ref: ${originalRef})`);
        }
        // Re-register to ensure it's tracked (in case it wasn't registered before)
        // This ensures secrets remain tracked even when passed through ComponentResources
        return Helpers.registerResolvedSecretPlain(originalRef, value, debug);
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
   * Check if props contain any known resolved secret values
   * Returns array of paths where secrets were found
   */
  private static checkForResolvedSecretsInProps(props: any, debug: boolean = false, path: string = ''): string[] {
    const secretPaths: string[] = [];
    
    if (props == null) {
      return secretPaths;
    }
    
    if (typeof props === 'string') {
      if (Helpers.resolvedSecretValues.has(props)) {
        secretPaths.push(path || 'root');
        if (debug) {
          pulumi.log.debug(`[SecretResolution] Found resolved secret at path: ${path || 'root'}`);
        }
      }
      return secretPaths;
    }
    
    if (Array.isArray(props)) {
      props.forEach((item, idx) => {
        secretPaths.push(...Helpers.checkForResolvedSecretsInProps(item, debug, path ? `${path}[${idx}]` : `[${idx}]`));
      });
      return secretPaths;
    }
    
    if (typeof props === 'object') {
      for (const [key, value] of Object.entries(props)) {
        secretPaths.push(...Helpers.checkForResolvedSecretsInProps(value, debug, path ? `${path}.${key}` : key));
      }
      return secretPaths;
    }
    
    return secretPaths;
  }

  /**
   * Register a global resource transform that resolves ref+ secrets in resource arguments
   * This uses pulumi.runtime.registerResourceTransform to apply the transform to all resources
   * in the stack, rather than adding transformations to individual components.
   * 
   * The transform:
   * 1. Scans ALL resource props for 'ref+' patterns
   * 2. Resolves them synchronously
   * 3. Tracks which props contain secrets
   * 4. Marks those props as secret outputs on the resource
   * 
   * This works recursively with all children and doesn't require any manual configuration.
   * 
   * @param debug - If true, logs debug information about transform execution
   */
  public static registerSecretResolutionTransform(debug: boolean = false): void {
    // Use a flag to ensure we only register once, but allow updating debug flag
    if ((Helpers as any)._secretTransformRegistered) {
      if (debug) {
        (Helpers as any)._secretTransformDebug = true;
      }
      return;
    }

    // Check if Pulumi runtime is available before trying to register
    try {
      if (!pulumi.runtime || typeof pulumi.runtime.registerResourceTransform !== 'function') {
        (Helpers as any)._secretTransformAttempted = true;
        return;
      }
    } catch {
      (Helpers as any)._secretTransformAttempted = true;
      return;
    }

    (Helpers as any)._secretTransformRegistered = true;
    (Helpers as any)._secretTransformDebug = debug;

    pulumi.runtime.registerResourceTransform((args: any) => {
      const isDebug = (Helpers as any)._secretTransformDebug || false;
      const resourceType = args?.type || 'unknown';
      const resourceName = args?.name || 'unknown';
      
      try {
        if (isDebug) {
          pulumi.log.debug(`[SecretResolution] Transform called for: ${resourceType}::${resourceName}`);
        }
        
        // Only process args.props (resource arguments), not opts
        if (!args || !args.props) {
          if (isDebug) {
            pulumi.log.debug(`[SecretResolution] Skipping transform: no args or props for ${resourceType}::${resourceName}`);
          }
          return undefined; // Return undefined to indicate no transformation
        }
        
        // First, check if there are any ref+ patterns to resolve
        // This is important - we only want to transform if necessary
        let propsString: string;
        try {
          propsString = JSON.stringify(args.props);
        } catch (e) {
          // Can't stringify (circular reference, etc.) - skip transform
          if (isDebug) {
            pulumi.log.debug(`[SecretResolution] Cannot stringify props for ${resourceType}::${resourceName}, skipping`);
          }
          return undefined;
        }
        
        const hasRefPatterns = propsString.includes('ref+');
        
        if (!hasRefPatterns) {
          if (isDebug) {
            pulumi.log.debug(`[SecretResolution] No ref+ patterns found, skipping transform for: ${resourceType}::${resourceName}`);
          }
          // Return undefined to indicate no transformation needed
          // This preserves provider propagation by not modifying args at all
          return undefined;
        }
        
        if (isDebug) {
          pulumi.log.debug(`[SecretResolution] Transform invoked for: ${resourceType}::${resourceName}`);
          pulumi.log.debug(`[SecretResolution] Processing props (keys: ${Object.keys(args.props).join(', ')})`);
          pulumi.log.debug(`[SecretResolution] Props content preview: ${propsString.substring(0, 200)}`);
        }
        
        // Process args.props recursively to find and resolve ALL ref+ strings
        const resolvedProps = Helpers.resolveRefPlusSecretsDeep(args.props, isDebug, 'props');
        
        // Check if resolution actually changed anything by comparing JSON strings
        let resolvedString: string;
        try {
          resolvedString = JSON.stringify(resolvedProps);
        } catch (e) {
          // Can't stringify resolved props - something went wrong
          pulumi.log.warn(`[SecretResolution] Cannot stringify resolved props for ${resourceType}::${resourceName}, preserving original`);
          return undefined;
        }
        
        // Check if ref+ patterns are still present (resolution didn't work)
        const stillHasRefPatterns = resolvedString.includes('ref+');
        
        if (stillHasRefPatterns) {
          // ref+ patterns still exist - resolution failed
          pulumi.log.warn(`[SecretResolution] ref+ patterns found but not resolved for ${resourceType}::${resourceName}. ` +
            `Secrets may not be available. Ensure vals or sops is configured correctly.`);
          // Return undefined to preserve provider propagation
          return undefined;
        }
        
        // Check if anything actually changed
        const propsChanged = resolvedString !== propsString;
        
        if (!propsChanged) {
          if (isDebug) {
            pulumi.log.debug(`[SecretResolution] No changes after resolution for: ${resourceType}::${resourceName}, preserving default behavior`);
          }
          // Return undefined to preserve provider propagation
          return undefined;
        }
        
        if (isDebug) {
          pulumi.log.debug(`[SecretResolution] Successfully resolved secrets for: ${resourceType}::${resourceName}`);
        }
        
        // Return transformed args with resolved props
        // Pass through opts unchanged to preserve provider propagation
        return {
          props: resolvedProps,
          opts: args.opts,
        };
      } catch (error: any) {
        // Catch any unexpected errors and preserve default behavior
        pulumi.log.warn(`[SecretResolution] Error during transform for ${resourceType}::${resourceName}: ${error.message}. Preserving default behavior.`);
        if (isDebug) {
          pulumi.log.error(`[SecretResolution] Full error: ${error.stack || error.message}`);
        }
        return undefined;
      }
    });
  }
}