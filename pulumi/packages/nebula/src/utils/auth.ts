// Authentication utilities
// This file contains authentication-related helper functions

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as http from 'http';
import * as url from 'url';
import { spawn } from 'child_process';
import open from 'open';

/**
 * Authentication utilities organized by cloud provider
 */
export class Auth {
  // Track ongoing authentication per project to prevent concurrent flows for the same project
  private static ongoingAuth: Map<string, Promise<any>> = new Map();

  /**
   * Google Cloud Platform authentication utilities
   */
  static GCP = {
    /**
     * Authenticate using project-specific credentials
     * @param projectId - The GCP project ID
     * @param region - The GCP region (optional)
     */
    async authenticate(projectId: string, region?: string): Promise<void> {
      console.error(`🔐 Starting authentication for project: ${projectId}`);
      
      // Check if authentication is already in progress for this specific project
      const existingAuth = Auth.ongoingAuth.get(projectId);
      if (existingAuth) {
        console.error(`  ⏳ Authentication already in progress for project ${projectId}, waiting...`);
        await existingAuth;
        return;
      }
      
      // Step 1: Check if existing token is valid
      if (await this.isTokenValid(projectId)) {
        console.error(`  ✅ Valid token found for project: ${projectId}`);
        this.setAccessTokenEnvVar(projectId, region);
        return;
      }
      
      // Step 2: Run OAuth flow to simulate gcloud auth application-default login
      const authPromise = this.performAuthentication(projectId, region);
      Auth.ongoingAuth.set(projectId, authPromise);
      
      try {
        await authPromise;
      } finally {
        Auth.ongoingAuth.delete(projectId);
      }
    },

    /**
     * Perform the actual authentication flow
     * @param projectId - The GCP project ID
     * @param region - The GCP region (optional)
     */
    async performAuthentication(projectId: string, region?: string): Promise<void> {
      const tokenResponse = await this.simulateApplicationDefaultLogin();
      
      if (tokenResponse) {
        // Step 3: Write tokens to file
        this.writeTokenFile(projectId, tokenResponse);
        
        // Step 4: Set environment variable
        this.setAccessTokenEnvVar(projectId, region);
        
        console.error(`  ✅ Authentication successful for project: ${projectId}`);
      } else {
        const errorMsg = `Authentication failed for project: ${projectId}. OAuth flow did not complete successfully.`;
        console.error(`  ❌ ${errorMsg}`);
        throw new Error(errorMsg);
      }
    },

    /**
     * Refresh access token using refresh token
     * @param projectId - The GCP project ID
     * @returns New token response or null
     */
    async refreshAccessToken(projectId: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; token_type?: string } | null> {
      const homeDir = os.homedir();
      const accessTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
      
      try {
        // Read existing credentials
        const credentialContent = fs.readFileSync(accessTokenFilePath, 'utf8');
        const credentials = JSON.parse(credentialContent);
        
        if (!credentials.refresh_token) {
          console.error('No refresh token available for token renewal');
          return null;
        }
        
        // Exchange refresh token for new access token
        const tokenUrl = 'https://oauth2.googleapis.com/token';
        const params = new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: credentials.client_id,
          client_secret: credentials.client_secret,
          refresh_token: credentials.refresh_token
        });
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
        
        const response = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString(),
          signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        
        if (!response.ok) {
          console.error(`Token refresh failed: ${response.status} ${response.statusText}`);
          const errorText = await response.text();
          console.error('Error response:', errorText);
          
          // Check for invalid_rapt error and clear credentials
          try {
            const errorData = JSON.parse(errorText);
            if (errorData.error === 'invalid_grant' && errorData.error_subtype === 'invalid_rapt') {
              console.error('Invalid RAPT error detected - clearing expired credentials');
              this.clearExpiredCredentials(projectId);
            }
          } catch {
            // Ignore JSON parsing errors
          }
          
          return null;
        }
        
        const newTokens = await response.json();
        console.error('  ✅ Token refresh successful');
        
        // Update the credential file with new tokens
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
        
        fs.writeFileSync(accessTokenFilePath, JSON.stringify(updatedCredentials, null, 2));
        
        return {
          access_token: newTokens.access_token,
          refresh_token: credentials.refresh_token, // Keep existing refresh token
          expires_in: newTokens.expires_in,
          token_type: newTokens.token_type
        };
        
      } catch (error: any) {
        if (error.name === 'AbortError') {
          console.error('Token refresh request timed out');
        } else {
          console.error(`Token refresh error: ${error}`);
        }
        return null;
      }
    },

    /**
     * Check if existing token is valid and refresh if needed
     * @param projectId - The GCP project ID
     * @returns True if token is valid (or was successfully refreshed)
     */
    async isTokenValid(projectId: string): Promise<boolean> {
      const homeDir = os.homedir();
      const accessTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
      
      // Check if token file exists
      if (!fs.existsSync(accessTokenFilePath)) {
        return false;
      }
      
      try {
        // Read and parse the credential file
        const credentialContent = fs.readFileSync(accessTokenFilePath, 'utf8');
        const credentials = JSON.parse(credentialContent);
        
        // Basic structure check
        if (credentials.type !== 'authorized_user') return false;
        if (!credentials.refresh_token) {
          console.error('No refresh token found - will need to re-authenticate');
          this.clearExpiredCredentials(projectId);
          return false;
        }
        
        // Determine if the token is still valid
        const nowMs = Date.now();
        const skewMs = 120 * 1000; // refresh 2 minutes before expiry
        let expiresAtMs: number | undefined = undefined;
        
        if (typeof credentials.expires_at === 'number') {
          expiresAtMs = credentials.expires_at;
        } else if (typeof credentials.expires_at === 'string') {
          const parsed = Date.parse(credentials.expires_at);
          if (!Number.isNaN(parsed)) expiresAtMs = parsed;
        } else if (typeof credentials.expires_in === 'number' && typeof credentials.fetched_at === 'number') {
          expiresAtMs = credentials.fetched_at + (credentials.expires_in * 1000);
        }
        
        if (expiresAtMs && nowMs + skewMs < expiresAtMs && credentials.access_token) {
          // Current token is still valid
          return true;
        }
        
        // Expired or unknown expiry: try to refresh
        const refreshedTokens = await this.refreshAccessToken(projectId);
        if (refreshedTokens) {
          console.error('Token refreshed successfully');
          return true;
        }
        console.error('Token refresh failed - will need to re-authenticate');
        this.clearExpiredCredentials(projectId);
        return false;
      } catch (error) {
        // If command fails, token is expired or invalid
        console.error('Token validation failed:', error);
        // Clear expired credentials to ensure fresh authentication
        this.clearExpiredCredentials(projectId);
        return false;
      }
    },

    /**
     * Parse OAuth URL and extract parameters
     * @param oauthUrl - The OAuth URL to parse
     * @returns Parsed OAuth parameters or null
     */
    parseOAuthUrl(oauthUrl: string): any | null {
      try {
        const url = new URL(oauthUrl);
        const params = url.searchParams;
        
        return {
          responseType: params.get('response_type'),
          clientId: params.get('client_id'),
          redirectUri: params.get('redirect_uri'),
          scope: params.get('scope'),
          state: params.get('state'),
          accessType: params.get('access_type'),
          codeChallenge: params.get('code_challenge'),
          codeChallengeMethod: params.get('code_challenge_method')
        };
      } catch (error) {
        console.error(`Failed to parse OAuth URL: ${error}`);
        return null;
      }
    },

    /**
     * Simulate gcloud auth application-default login using OAuth flow
     * @param oauthUrl - Optional OAuth URL to use instead of generating one
     * @returns Token response with access_token, refresh_token, etc. or null
     */
    async simulateApplicationDefaultLogin(oauthUrl?: string): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; token_type?: string } | null> {
      const port = 8085;
      const redirectUri = `http://localhost:${port}/`;
      
      let authUrl: URL;
      let state: string;
      let codeVerifier: string;
      
      if (oauthUrl) {
        // Parse the provided OAuth URL
        const parsedParams = this.parseOAuthUrl(oauthUrl);
        if (!parsedParams) {
          console.error('Failed to parse provided OAuth URL');
          return null;
        }
        
        // Extract parameters from the provided URL
        state = parsedParams.state || this.generateRandomString(32);
        codeVerifier = this.generateCodeVerifier(); // Generate new verifier for security
        
        // Create auth URL with parsed parameters
        authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
        authUrl.searchParams.set('response_type', parsedParams.responseType || 'code');
        authUrl.searchParams.set('client_id', parsedParams.clientId || '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com');
        authUrl.searchParams.set('redirect_uri', redirectUri); // Use our local server
        authUrl.searchParams.set('scope', parsedParams.scope || 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/sqlservice.login');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('access_type', parsedParams.accessType || 'offline');
        authUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
        authUrl.searchParams.set('code_challenge', this.generateCodeChallenge(codeVerifier));
        authUrl.searchParams.set('code_challenge_method', parsedParams.codeChallengeMethod || 'S256');
        
        console.error('Using provided OAuth URL parameters');
      } else {
        // Generate PKCE parameters
        codeVerifier = this.generateCodeVerifier();
        const codeChallenge = this.generateCodeChallenge(codeVerifier);
        state = this.generateRandomString(32);
        
        // OAuth URL parameters
        authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com');
        authUrl.searchParams.set('redirect_uri', redirectUri);
        authUrl.searchParams.set('scope', 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/sqlservice.login');
        authUrl.searchParams.set('state', state);
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        
        console.error('Generated OAuth URL parameters');
      }
      
        console.error('  🔗 Starting OAuth flow...');
        console.error('  🌐 Auth URL:', authUrl.toString());
      
      try {
        // Start local server to handle callback
        const authCode = await this.startCallbackServer(port, state, codeVerifier);
        
        if (!authCode) {
          console.error('Failed to get authorization code');
          return null;
        }
        
        // Exchange authorization code for tokens
        const tokens = await this.exchangeCodeForTokens(authCode, redirectUri, codeVerifier);
        
        if (!tokens) {
          console.error('Failed to exchange code for tokens');
          return null;
        }
        
        console.error('  ✅ OAuth flow completed successfully');
        return {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          token_type: tokens.token_type
        };
        
      } catch (error) {
        console.error(`  ❌ OAuth flow failed: ${error}`);
        return null;
      }
    },

    /**
     * Generate PKCE code verifier
     * @returns Code verifier string
     */
    generateCodeVerifier(): string {
      return crypto.randomBytes(32).toString('base64url');
    },

    /**
     * Generate PKCE code challenge from verifier
     * @param codeVerifier - The code verifier
     * @returns Code challenge string
     */
    generateCodeChallenge(codeVerifier: string): string {
      return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
    },

    /**
     * Generate random string for state parameter
     * @param length - Length of the string
     * @returns Random string
     */
    generateRandomString(length: number): string {
      return crypto.randomBytes(length).toString('base64url');
    },

    /**
     * Start local HTTP server to handle OAuth callback
     * @param port - Port to listen on
     * @param expectedState - Expected state parameter
     * @param codeVerifier - PKCE code verifier for token exchange
     * @returns Authorization code or null
     */
    startCallbackServer(port: number, expectedState: string, codeVerifier: string): Promise<string | null> {
      return new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          const parsedUrl = url.parse(req.url || '', true);
          
          if (parsedUrl.pathname === '/') {
            const { code, state, error } = parsedUrl.query;
            
            // Send response to browser
            res.writeHead(200, { 'Content-Type': 'text/html' });
            if (error) {
              res.end(`
                <html>
                  <body>
                    <h1>Authentication Error</h1>
                    <p>Error: ${error}</p>
                    <p>You can close this window.</p>
                  </body>
                </html>
              `);
              resolve(null);
            } else if (code && state === expectedState) {
              res.end(`
                <html>
                  <body>
                    <h1>Authentication Successful</h1>
                    <p>You can close this window and return to the application.</p>
                  </body>
                </html>
              `);
              resolve(code as string);
            } else {
              res.end(`
                <html>
                  <body>
                    <h1>Authentication Failed</h1>
                    <p>Invalid state parameter or missing authorization code.</p>
                    <p>You can close this window.</p>
                  </body>
                </html>
              `);
              resolve(null);
            }
            
            // Close server after handling request
            setTimeout(() => {
              server.close();
            }, 100);
          }
        });
        
        server.listen(port, () => {
          console.error(`Callback server listening on port ${port}`);
        });
        
        server.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE') {
            console.error(`Port ${port} is already in use - authentication already in progress`);
            resolve(null);
          } else {
            console.error(`Server error: ${err.message}`);
            resolve(null);
          }
        });
        
        // Open browser to OAuth URL
        const codeChallenge = this.generateCodeChallenge(codeVerifier);
        
        const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
        authUrl.searchParams.set('response_type', 'code');
        authUrl.searchParams.set('client_id', '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com');
        authUrl.searchParams.set('redirect_uri', `http://localhost:${port}/`);
        authUrl.searchParams.set('scope', 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/sqlservice.login');
        authUrl.searchParams.set('state', expectedState);
        authUrl.searchParams.set('access_type', 'offline');
        authUrl.searchParams.set('prompt', 'consent'); // Force consent to get refresh token
        authUrl.searchParams.set('code_challenge', codeChallenge);
        authUrl.searchParams.set('code_challenge_method', 'S256');
        
        console.error('Opening browser for authentication...');
        open(authUrl.toString()).catch((error) => {
          console.error(`Failed to open browser: ${error}`);
          console.error('Please manually open this URL:', authUrl.toString());
        });
        
        // Timeout after 5 minutes
        const timeoutId = setTimeout(() => {
          server.close();
          resolve(null);
        }, 300000);
        
        // Ensure cleanup on resolution
        const originalResolve = resolve;
        resolve = (value: string | null) => {
          clearTimeout(timeoutId);
          server.close();
          originalResolve(value);
        };
      });
    },

    /**
     * Exchange authorization code for access token
     * @param authCode - Authorization code from callback
     * @param redirectUri - Redirect URI used in OAuth flow
     * @param codeVerifier - PKCE code verifier
     * @returns Token response or null
     */
    async exchangeCodeForTokens(authCode: string, redirectUri: string, codeVerifier: string): Promise<any | null> {
      const tokenUrl = 'https://oauth2.googleapis.com/token';
      
      const params = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: '764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com',
        client_secret: 'd-FL95Q19q7MQmFpd7hHD0Ty',
        code: authCode,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      });
      
      try {
        const response = await fetch(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: params.toString()
        });
        
        if (!response.ok) {
          console.error(`Token exchange failed: ${response.status} ${response.statusText}`);
          const errorText = await response.text();
          console.error('Error response:', errorText);
          return null;
        }
        
        const tokens = await response.json();
        console.error('Token exchange successful');
        return tokens;
        
      } catch (error) {
        console.error(`Token exchange error: ${error}`);
        return null;
      }
    },

    /**
     * Run gcloud auth login and extract access token
     * @returns Access token or null
     */
    runGcloudAuthLogin(): Promise<string | null> {
      return new Promise((resolve) => {
        console.error('Launching gcloud auth login...');
        
        // Execute gcloud auth login with HTTP logging and no activate
        const command = 'CLOUDSDK_CORE_LOG_HTTP_REDACT_TOKEN=false gcloud auth login --log-http --no-activate';
        const child = spawn('sh', ['-c', command], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env }
        });
        
        let stdout = '';
        let stderr = '';
        
        child.stdout?.on('data', (data) => {
          stdout += data.toString();
        });
        
        child.stderr?.on('data', (data) => {
          stderr += data.toString();
        });
        
        child.on('close', (code) => {
          console.error(`gcloud auth login exited with code: ${code}`);
          console.error('Raw stdout:', stdout);
          console.error('Raw stderr:', stderr);
          
          // Extract access token from output
          let accessToken = this.extractAccessTokenFromOutput(stdout);
          if (!accessToken) {
            accessToken = this.extractAccessTokenFromOutput(stderr);
          }
          
          if (accessToken) {
            console.error('Access token extracted successfully');
            resolve(accessToken);
          } else {
            console.error('Failed to extract access token from output');
            console.error('Looking for pattern: "access_token": "..."');
            resolve(null);
          }
        });
        
        child.on('error', (error: Error) => {
          console.error(`gcloud auth login failed: ${error.message}`);
          resolve(null);
        });
        
        // Set a timeout to kill the process if it takes too long
        setTimeout(() => {
          if (!child.killed) {
            console.error('Killing gcloud auth login process due to timeout');
            child.kill();
            resolve(null);
          }
        }, 30000); // 30 second timeout
      });
    },

    /**
     * Extract access token from gcloud auth login output
     * @param output - Output from gcloud auth login command
     * @returns Access token or null
     */
    extractAccessTokenFromOutput(output: string): string | null {
      // Look for access_token pattern in the output
      const tokenMatch = output.match(/"access_token":\s*"([^"]+)"/);
      return tokenMatch?.[1] || null;
    },

    /**
     * Write tokens to file as proper credential JSON
     * @param projectId - The GCP project ID
     * @param tokenResponse - The token response containing access_token, refresh_token, etc.
     */
    writeTokenFile(projectId: string, tokenResponse: { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string }): void {
      const homeDir = os.homedir();
      const gcloudConfigDir = path.join(homeDir, '.config', 'gcloud');
      const accessTokenFilePath = path.join(gcloudConfigDir, `${projectId}-accesstoken`);
      
      // Create directory if it doesn't exist
      if (!fs.existsSync(gcloudConfigDir)) {
        fs.mkdirSync(gcloudConfigDir, { recursive: true });
      }
      
      // Create proper credential JSON structure
      const nowMs = Date.now();
      const expiresInSec = Number(tokenResponse.expires_in || 3600);
      const credentialData = {
        type: "authorized_user",
        access_token: tokenResponse.access_token,
        refresh_token: tokenResponse.refresh_token || "",
        // Add minimal required fields for gcloud compatibility
        client_id: "764086051850-6qr4p6gpi6hn506pt8ejuq83di341hur.apps.googleusercontent.com",
        client_secret: "d-FL95Q19q7MQmFpd7hHD0Ty",
        quota_project_id: projectId,
        universe_domain: "googleapis.com",
        // Add token metadata
        expires_in: tokenResponse.expires_in,
        token_type: tokenResponse.token_type || "Bearer",
        fetched_at: nowMs,
        expires_at: nowMs + (expiresInSec * 1000),
      };
      
      // Write credential JSON to file
      fs.writeFileSync(accessTokenFilePath, JSON.stringify(credentialData, null, 2));
      
      console.error(`Tokens written to: ${accessTokenFilePath}`);
      if (tokenResponse.refresh_token) {
        console.error('Refresh token included for automatic token renewal');
      } else {
        console.error('WARNING: No refresh token received');
      }
    },

    /**
     * Clear expired credentials for a project
     * @param projectId - The GCP project ID
     */
    clearExpiredCredentials(projectId: string): void {
      const homeDir = os.homedir();
      const accessTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
      
      try {
        if (fs.existsSync(accessTokenFilePath)) {
          fs.unlinkSync(accessTokenFilePath);
          console.error(`Cleared expired credentials for project: ${projectId}`);
        }
      } catch (error) {
        console.error(`Failed to clear credentials for project ${projectId}:`, error);
      }
    },

    /**
     * Set CLOUDSDK_AUTH_ACCESS_TOKEN_FILE environment variable
     * @param projectId - The GCP project ID
     * @param region - The GCP region (optional)
     */
    setAccessTokenEnvVar(projectId: string, region?: string): void {
      const homeDir = os.homedir();
      const accessTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${projectId}-accesstoken`);
      
      // Set environment variables for current process
      process.env['GOOGLE_APPLICATION_CREDENTIALS'] = accessTokenFilePath;
      process.env['CLOUDSDK_CORE_PROJECT'] = projectId;
      
      // Set compute zone based on region, default to us-central1-a if no region provided
      const computeZone = region ? `${region}-a` : 'us-central1-a';
      process.env['CLOUDSDK_COMPUTE_ZONE'] = computeZone;
      
      console.error(`Set GOOGLE_APPLICATION_CREDENTIALS=${accessTokenFilePath}`);
      console.error(`Set CLOUDSDK_CORE_PROJECT=${projectId}`);
      console.error(`Set CLOUDSDK_COMPUTE_ZONE=${computeZone}`);
    },

    /**
     * Manually refresh access token for a project
     * @param projectId - The GCP project ID
     * @returns True if refresh was successful
     */
    async refreshToken(projectId: string): Promise<boolean> {
      console.error(`Refreshing token for project: ${projectId}`);
      
      const refreshedTokens = await this.refreshAccessToken(projectId);
      if (refreshedTokens) {
        console.error(`Token refresh successful for project: ${projectId}`);
        return true;
      } else {
        console.error(`Token refresh failed for project: ${projectId}`);
        return false;
      }
    },

    /**
     * Try to reuse credentials from another project for this project
     * This is useful when using SSO with Google - same account can access multiple projects
     * @param targetProjectId - The project ID to create credentials for
     * @param sourceProjectId - The project ID to copy credentials from
     * @param region - The GCP region (optional)
     * @returns True if credentials were successfully reused, false otherwise
     */
    async tryReuseCredentials(targetProjectId: string, sourceProjectId: string, region?: string): Promise<boolean> {
      const homeDir = os.homedir();
      const sourceTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${sourceProjectId}-accesstoken`);
      const targetTokenFilePath = path.join(homeDir, '.config', 'gcloud', `${targetProjectId}-accesstoken`);
      
      // Check if source credentials exist
      if (!fs.existsSync(sourceTokenFilePath)) {
        return false;
      }
      
      try {
        // Read source credentials
        const sourceCredentialContent = fs.readFileSync(sourceTokenFilePath, 'utf8');
        const sourceCredentials = JSON.parse(sourceCredentialContent);
        
        // Check if source has a valid refresh token
        if (!sourceCredentials.refresh_token || sourceCredentials.type !== 'authorized_user') {
          return false;
        }
        
        // Try to refresh the token to verify it's still valid
        const refreshedTokens = await this.refreshAccessToken(sourceProjectId);
        if (!refreshedTokens) {
          return false;
        }
        
        // Copy credentials to target project, updating quota_project_id
        const nowMs = Date.now();
        const expiresInSec = Number(refreshedTokens.expires_in || 3600);
        const targetCredentials = {
          ...sourceCredentials,
          access_token: refreshedTokens.access_token,
          quota_project_id: targetProjectId,
          expires_in: refreshedTokens.expires_in,
          token_type: refreshedTokens.token_type || 'Bearer',
          fetched_at: nowMs,
          expires_at: nowMs + (expiresInSec * 1000),
        };
        
        // Ensure directory exists
        const gcloudConfigDir = path.join(homeDir, '.config', 'gcloud');
        if (!fs.existsSync(gcloudConfigDir)) {
          fs.mkdirSync(gcloudConfigDir, { recursive: true });
        }
        
        // Write credentials for target project
        fs.writeFileSync(targetTokenFilePath, JSON.stringify(targetCredentials, null, 2));
        
        // Set environment variable
        this.setAccessTokenEnvVar(targetProjectId, region);
        
        console.error(`  ✅ Reused credentials from project ${sourceProjectId} for project ${targetProjectId}`);
        return true;
      } catch (error) {
        console.error(`  ⚠️  Failed to reuse credentials from ${sourceProjectId} for ${targetProjectId}: ${error}`);
        return false;
      }
    },

  };

  /**
   * Amazon Web Services authentication utilities
   */
  static AWS = {
    // AWS authentication methods will be implemented here
  };

  /**
   * Azure authentication utilities
   */
  static Azure = {
    // Azure authentication methods will be implemented here
  };
}