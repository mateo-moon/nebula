/**
 * GCP Authentication utilities for Nebula CLI
 * This is a standalone implementation with no Pulumi dependencies.
 */
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as http from 'http';
import * as url from 'url';
import open from 'open';

// Track ongoing authentication per project
const ongoingAuth: Map<string, Promise<void>> = new Map();

export const GcpAuth = {
  /**
   * Authenticate using project-specific credentials
   */
  async authenticate(projectId: string, region?: string): Promise<void> {
    console.error(`🔐 Starting authentication for project: ${projectId}`);
    
    // Check if authentication is already in progress
    const existingAuth = ongoingAuth.get(projectId);
    if (existingAuth) {
      console.error(`  ⏳ Authentication already in progress for project ${projectId}, waiting...`);
      await existingAuth;
      return;
    }
    
    // Check if existing token is valid
    if (await this.isTokenValid(projectId)) {
      console.error(`  ✅ Valid token found for project: ${projectId}`);
      this.setAccessTokenEnvVar(projectId, region);
      return;
    }
    
    // Run OAuth flow
    const authPromise = this.performAuthentication(projectId, region);
    ongoingAuth.set(projectId, authPromise);
    
    try {
      await authPromise;
    } finally {
      ongoingAuth.delete(projectId);
    }
  },

  async performAuthentication(projectId: string, region?: string): Promise<void> {
    const tokenResponse = await this.runOAuthFlow();
    
    if (tokenResponse) {
      this.writeTokenFile(projectId, tokenResponse);
      this.setAccessTokenEnvVar(projectId, region);
      console.error(`  ✅ Authentication successful for project: ${projectId}`);
    } else {
      throw new Error(`Authentication failed for project: ${projectId}`);
    }
  },

  async isTokenValid(projectId: string): Promise<boolean> {
    const homeDir = os.homedir();
    const tokenPath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
    
    if (!fs.existsSync(tokenPath)) {
      return false;
    }
    
    try {
      const credentials = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      
      if (credentials.type !== 'authorized_user') return false;
      if (!credentials.refresh_token) {
        this.clearCredentials(projectId);
        return false;
      }
      
      const nowMs = Date.now();
      const skewMs = 120 * 1000; // 2 minutes buffer
      let expiresAtMs: number | undefined;
      
      if (typeof credentials.expires_at === 'number') {
        expiresAtMs = credentials.expires_at;
      } else if (typeof credentials.expires_in === 'number' && typeof credentials.fetched_at === 'number') {
        expiresAtMs = credentials.fetched_at + (credentials.expires_in * 1000);
      }
      
      if (expiresAtMs && nowMs + skewMs < expiresAtMs && credentials.access_token) {
        return true;
      }
      
      // Try to refresh
      const refreshed = await this.refreshToken(projectId);
      if (refreshed) {
        return true;
      }
      
      this.clearCredentials(projectId);
      return false;
    } catch {
      this.clearCredentials(projectId);
      return false;
    }
  },

  async refreshToken(projectId: string): Promise<boolean> {
    const homeDir = os.homedir();
    const tokenPath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
    
    try {
      const credentials = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
      
      if (!credentials.refresh_token) {
        return false;
      }
      
      const params = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credentials.client_id,
        client_secret: credentials.client_secret,
        refresh_token: credentials.refresh_token,
      });
      
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      
      if (!response.ok) {
        return false;
      }
      
      const newTokens = await response.json();
      
      const nowMs = Date.now();
      const expiresInSec = Number(newTokens.expires_in || 3600);
      const updatedCredentials = {
        ...credentials,
        access_token: newTokens.access_token,
        expires_in: newTokens.expires_in,
        token_type: newTokens.token_type || 'Bearer',
        fetched_at: nowMs,
        expires_at: nowMs + (expiresInSec * 1000),
      };
      
      fs.writeFileSync(tokenPath, JSON.stringify(updatedCredentials, null, 2));
      console.error('  ✅ Token refresh successful');
      return true;
    } catch {
      return false;
    }
  },

  async runOAuthFlow(): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; token_type?: string } | null> {
    const port = 8085;
    const redirectUri = `http://localhost:${port}/`;
    
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    const state = crypto.randomBytes(32).toString('base64url');
    
    const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com');
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/sqlservice.login');
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('prompt', 'consent');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    
    try {
      const authCode = await this.startCallbackServer(port, state, authUrl.toString());
      
      if (!authCode) {
        return null;
      }
      
      return await this.exchangeCodeForTokens(authCode, redirectUri, codeVerifier);
    } catch (error) {
      console.error(`  ❌ OAuth flow failed: ${error}`);
      return null;
    }
  },

  startCallbackServer(port: number, expectedState: string, authUrl: string): Promise<string | null> {
    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        const parsedUrl = url.parse(req.url || '', true);
        
        if (parsedUrl.pathname === '/') {
          const { code, state, error } = parsedUrl.query;
          
          res.writeHead(200, { 'Content-Type': 'text/html' });
          
          if (error) {
            res.end(`<html><body><h1>Authentication Error</h1><p>${error}</p></body></html>`);
            resolve(null);
          } else if (code && state === expectedState) {
            res.end(`<html><body><h1>Authentication Successful</h1><p>You can close this window.</p></body></html>`);
            resolve(code as string);
          } else {
            res.end(`<html><body><h1>Authentication Failed</h1></body></html>`);
            resolve(null);
          }
          
          setTimeout(() => server.close(), 100);
        }
      });
      
      server.listen(port, () => {
        console.error(`Callback server listening on port ${port}`);
      });
      
      server.on('error', (err: any) => {
        if (err.code === 'EADDRINUSE') {
          console.error(`Port ${port} is already in use`);
        }
        resolve(null);
      });
      
      console.error('Opening browser for authentication...');
      open(authUrl).catch((error) => {
        console.error(`Failed to open browser: ${error}`);
        console.error('Please manually open this URL:', authUrl);
      });
      
      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        resolve(null);
      }, 300000);
    });
  },

  async exchangeCodeForTokens(authCode: string, redirectUri: string, codeVerifier: string): Promise<any | null> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com',
      client_secret: 'd-FL95Q19q7MQmFpd7hHD0Ty',
      code: authCode,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });
    
    try {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
      });
      
      if (!response.ok) {
        console.error(`Token exchange failed: ${response.status}`);
        return null;
      }
      
      return await response.json();
    } catch (error) {
      console.error(`Token exchange error: ${error}`);
      return null;
    }
  },

  writeTokenFile(projectId: string, tokenResponse: { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }): void {
    const homeDir = os.homedir();
    const gcloudDir = path.join(homeDir, '.config', 'gcloud');
    const tokenPath = path.join(gcloudDir, `${projectId}-accesstoken`);
    
    if (!fs.existsSync(gcloudDir)) {
      fs.mkdirSync(gcloudDir, { recursive: true });
    }
    
    const nowMs = Date.now();
    const expiresInSec = Number(tokenResponse.expires_in || 3600);
    
    const credentials = {
      type: 'authorized_user',
      access_token: tokenResponse.access_token,
      refresh_token: tokenResponse.refresh_token || '',
      client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com',
      client_secret: 'd-FL95Q19q7MQmFpd7hHD0Ty',
      quota_project_id: projectId,
      universe_domain: 'googleapis.com',
      expires_in: tokenResponse.expires_in,
      token_type: tokenResponse.token_type || 'Bearer',
      fetched_at: nowMs,
      expires_at: nowMs + (expiresInSec * 1000),
    };
    
    fs.writeFileSync(tokenPath, JSON.stringify(credentials, null, 2));
    console.error(`Tokens written to: ${tokenPath}`);
  },

  setAccessTokenEnvVar(projectId: string, region?: string): void {
    const homeDir = os.homedir();
    const tokenPath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
    
    process.env['GOOGLE_APPLICATION_CREDENTIALS'] = tokenPath;
    process.env['CLOUDSDK_CORE_PROJECT'] = projectId;
    
    const computeZone = region ? `${region}-a` : 'us-central1-a';
    process.env['CLOUDSDK_COMPUTE_ZONE'] = computeZone;
    
    console.error(`Set GOOGLE_APPLICATION_CREDENTIALS=${tokenPath}`);
    console.error(`Set CLOUDSDK_CORE_PROJECT=${projectId}`);
    console.error(`Set CLOUDSDK_COMPUTE_ZONE=${computeZone}`);
  },

  clearCredentials(projectId: string): void {
    const homeDir = os.homedir();
    const tokenPath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
    
    try {
      if (fs.existsSync(tokenPath)) {
        fs.unlinkSync(tokenPath);
        console.error(`Cleared credentials for project: ${projectId}`);
      }
    } catch {
      // Ignore
    }
  },
};
