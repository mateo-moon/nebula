/**
 * GCP Helper utilities for Nebula CLI
 * This is a standalone implementation with no Pulumi dependencies.
 */
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as https from 'https';
import * as YAML from 'yaml';
import { Storage } from '@google-cloud/storage';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { GcpAuth } from './auth';

export const GcpHelpers = {
  /**
   * Get access token from credentials file
   */
  async getAccessToken(projectId: string): Promise<string | null> {
    const homeDir = os.homedir();
    const tokenPath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
    
    if (!fs.existsSync(tokenPath)) {
      return null;
    }
    
    try {
      const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      const now = Date.now();
      const expiresAt = tokenData.expires_at || 0;
      
      if (now >= expiresAt && tokenData.refresh_token) {
        const refreshed = await GcpAuth.refreshToken(projectId);
        if (refreshed) {
          const updatedData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
          return updatedData.access_token || null;
        }
      }
      
      return tokenData.access_token || null;
    } catch {
      return null;
    }
  },

  /**
   * Enable a GCP API
   */
  async enableGcpApi(projectId: string, apiName: string, accessToken: string): Promise<boolean> {
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
        res.on('data', (chunk) => { data += chunk.toString(); });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 204 || res.statusCode === 409) {
            resolve(true);
          } else if (res.statusCode === 400) {
            try {
              const error = JSON.parse(data);
              const msg = error.error?.message || '';
              if (msg.includes('already enabled') || msg.includes('already exists')) {
                resolve(true);
              } else {
                resolve(false);
              }
            } catch {
              resolve(false);
            }
          } else {
            resolve(false);
          }
        });
      });
      
      req.on('error', () => resolve(false));
      req.setTimeout(30000, () => { req.destroy(); resolve(false); });
      req.write(postData);
      req.end();
    });
  },

  /**
   * Enable required GCP APIs
   */
  async enableGcpApis(projectId: string): Promise<void> {
    const accessToken = await this.getAccessToken(projectId);
    if (!accessToken) {
      console.error('⚠ No valid access token found. Skipping GCP API enablement.');
      return;
    }
    
    const requiredApis = [
      'compute.googleapis.com',
      'container.googleapis.com',
      'iam.googleapis.com',
      'storage.googleapis.com',
      'cloudkms.googleapis.com',
      'secretmanager.googleapis.com',
      'dns.googleapis.com',
      'logging.googleapis.com',
      'monitoring.googleapis.com',
      'serviceusage.googleapis.com',
    ];
    
    process.stderr.write(`🔧 Enabling required GCP APIs for project: ${projectId}\n`);
    
    let enabled = 0;
    let failed = 0;
    
    await Promise.all(requiredApis.map(async (api) => {
      const success = await this.enableGcpApi(projectId, api, accessToken);
      if (success) enabled++; else failed++;
    }));
    
    if (enabled > 0) {
      process.stderr.write(`  ✅ Enabled ${enabled} GCP APIs\n`);
    }
    if (failed > 0) {
      process.stderr.write(`  ⚠️  Failed to enable ${failed} GCP APIs\n`);
    }
  },

  /**
   * Ensure GCS bucket exists
   */
  async ensureGcsBucket(config: { bucket: string; projectId?: string; location?: string }): Promise<void> {
    const credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    
    if (!credentialsFile || !fs.existsSync(credentialsFile)) {
      console.error('No credentials file available for GCS bucket creation');
      return;
    }
    
    try {
      let projectId = config.projectId;
      if (!projectId) {
        const creds = JSON.parse(fs.readFileSync(credentialsFile, 'utf8'));
        projectId = creds.quota_project_id || creds.project_id;
      }
      
      const storage = new Storage({
        keyFilename: credentialsFile,
        ...(projectId ? { projectId } : {}),
      });
      
      const [exists] = await storage.bucket(config.bucket).exists();
      
      if (exists) {
        console.error(`  ✅ GCS bucket ${config.bucket} already exists`);
        return;
      }
      
      console.error(`  📦 Creating GCS bucket: ${config.bucket}`);
      await storage.createBucket(config.bucket, {
        ...(config.location ? { location: config.location } : {}),
        ...(projectId ? { projectId } : {}),
      });
      console.error(`  ✅ GCS bucket ${config.bucket} created successfully`);
    } catch (err: any) {
      console.error(`Failed to create GCS bucket ${config.bucket}:`, err?.message || err);
      throw err;
    }
  },

  /**
   * Ensure KMS key exists
   */
  async ensureKmsKey(providerUrl: string, options?: { skipInteractiveAuth?: boolean }): Promise<void> {
    const url = new URL(providerUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    
    if (pathParts.length < 6) {
      throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    }
    
    const [projectId, , location, , keyRingId, , cryptoKeyId] = pathParts;
    if (!projectId || !location || !keyRingId || !cryptoKeyId) {
      throw new Error(`Invalid gcpkms URL: ${providerUrl}`);
    }
    
    const credentialsFile = process.env['GOOGLE_APPLICATION_CREDENTIALS'];
    
    if (!credentialsFile || !fs.existsSync(credentialsFile)) {
      if (!options?.skipInteractiveAuth) {
        console.error('No credentials file found, attempting to authenticate...');
        await GcpAuth.authenticate(projectId, location);
      } else {
        throw new Error('No credentials available for KMS key creation');
      }
    }
    
    try {
      const kmsClient = new KeyManagementServiceClient({
        ...(credentialsFile && fs.existsSync(credentialsFile) ? { keyFilename: credentialsFile } : {}),
        projectId,
      });
      
      const keyRingPath = kmsClient.keyRingPath(projectId, location, keyRingId);
      const cryptoKeyPath = kmsClient.cryptoKeyPath(projectId, location, keyRingId, cryptoKeyId);
      
      // Check/create key ring
      try {
        await kmsClient.getKeyRing({ name: keyRingPath });
        console.error(`  ✅ Key ring ${keyRingPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.error(`  🔐 Creating key ring: ${keyRingPath}`);
          await kmsClient.createKeyRing({
            parent: kmsClient.locationPath(projectId, location),
            keyRingId,
          });
          console.error(`  ✅ Key ring created`);
        } else {
          throw error;
        }
      }
      
      // Check/create crypto key
      try {
        await kmsClient.getCryptoKey({ name: cryptoKeyPath });
        console.error(`  ✅ Crypto key ${cryptoKeyPath} already exists`);
      } catch (error: any) {
        if (error.code === 5) { // NOT_FOUND
          console.error(`  🔐 Creating crypto key: ${cryptoKeyPath}`);
          await kmsClient.createCryptoKey({
            parent: keyRingPath,
            cryptoKeyId,
            cryptoKey: { purpose: 'ENCRYPT_DECRYPT' },
          });
          console.error(`  ✅ Crypto key created`);
        } else {
          throw error;
        }
      }
    } catch (error: any) {
      console.error(`Failed to ensure GCP KMS key: ${error.message}`);
      throw error;
    }
  },

  /**
   * Ensure .sops.yaml config exists
   */
  ensureSopsConfig(opts: { gcpKmsResourceId: string; patterns: string[]; workDir?: string }): void {
    const startDir = opts.workDir ? path.resolve(opts.workDir) : process.cwd();
    const targetDir = this.findNearestProjectRoot(startDir);
    const sopsPath = path.resolve(targetDir, '.sops.yaml');
    
    // Read existing config
    let existingConfig: any = null;
    try {
      if (fs.existsSync(sopsPath)) {
        existingConfig = YAML.parse(fs.readFileSync(sopsPath, 'utf8'));
      }
    } catch {
      // Ignore
    }
    
    const newRule = {
      gcp_kms: opts.gcpKmsResourceId,
      path_regex: opts.patterns.join('|'),
    };
    
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
    
    fs.writeFileSync(sopsPath, '# Generated by Nebula CLI\n' + YAML.stringify(cfg, { indent: 2 }));
  },

  /**
   * Find nearest directory with package.json
   */
  findNearestProjectRoot(startDir: string): string {
    let currentDir = path.resolve(startDir);
    const root = path.parse(currentDir).root;
    
    while (currentDir !== root) {
      if (fs.existsSync(path.join(currentDir, 'package.json'))) {
        return currentDir;
      }
      currentDir = path.dirname(currentDir);
    }
    
    return startDir;
  },
};
