import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as cloudflare from '@pulumi/cloudflare';
import * as https from 'https';

export type DnsDelegationProvider = 'cloudflare' | 'hetzner';

export interface CloudflareDelegationConfig {
  provider: 'cloudflare';
  zoneId: string;
  email?: string;
}

export interface HetznerDelegationConfig {
  provider: 'hetzner';
  zoneId: string;
  /** Hetzner API token. Can be a plain string or a ref+ secret (e.g., 'ref+sops://...'). */
  hetznerApiToken: string;
}

export type DnsDelegationConfig = CloudflareDelegationConfig | HetznerDelegationConfig;

export type DnsProvider = 'gcp';

export interface DnsConfig {
  provider: DnsProvider;
  dnsDelegations?: DnsDelegationConfig[];
  enabled?: boolean;
  /** Array of domains and subdomains to manage */
  domains: string[]; // e.g. ['example.com', 'sub.example.com', 'another.example.com']
  delegations?: DnsDelegationConfig[]; // optional upstream DNS delegations
}

export interface DnsOutput {
  zones: Map<string, { zoneId: pulumi.Output<string>; nameServers: pulumi.Output<string[]> }>;
}

export class Dns extends pulumi.ComponentResource {
  public readonly zones: Map<string, { zoneId: pulumi.Output<string>; nameServers: pulumi.Output<string[]> }>;

  constructor(name: string, cfg: DnsConfig, opts?: pulumi.ComponentResourceOptions) {
    super('dns', name, {}, opts);

    this.zones = new Map();
    
    if (cfg.enabled === false || !cfg.domains || cfg.domains.length === 0) {
      this.registerOutputs({ zones: this.zones });
      return;
    }

    const domains = cfg.domains;

    // Create zones for each domain
    domains.forEach((domain, index) => {
      const cleanDomain = domain.replace(/\.$/, '');
      const zoneName = `${name}-zone-${index}`;

      if (cfg.provider === 'gcp') {
        const zone = new gcp.dns.ManagedZone(zoneName, {
          name: zoneName,
          dnsName: cleanDomain.endsWith('.') ? cleanDomain : `${cleanDomain}.`,
          description: 'Managed by Pulumi',
        }, { parent: this });
        const zoneInfo = {
          zoneId: zone.id,
          nameServers: zone.nameServers as pulumi.Output<string[]>
        };
        this.zones.set(cleanDomain, zoneInfo);
        this.applyDelegations(`${name}-${index}`, cleanDomain, zoneInfo.nameServers, cfg.delegations);
      } else {
        throw new Error(`Unsupported DNS provider: ${cfg.provider}`);
      }
    });

    this.registerOutputs({ zones: this.zones });
  }

  public get outputs(): DnsOutput {
    return { zones: this.zones };
  }

  private applyDelegations(name: string, fqdn: string, nsList?: pulumi.Output<string[]>, delegations?: DnsDelegationConfig[]) {
    if (!nsList || !delegations || delegations.length === 0) return;
    
    // Create delegation resources using pulumi.all() to avoid serialization issues
    for (const d of delegations) {
      if (d.provider === 'cloudflare') {
        // Create Cloudflare records for each nameserver (use FQDN as originally)
        pulumi.all([nsList, d.zoneId]).apply(([servers, zoneId]) => {
          servers.forEach((ns, idx) => {
            new cloudflare.Record(`${name}-ns-${idx}`, {
              zoneId: zoneId,
              name: fqdn,
              type: 'NS',
              ttl: 3600,
              content: ns,
            }, { parent: this });
          });
        });
      } else if (d.provider === 'hetzner') {
        // Create Hetzner records for each nameserver
        const hetznerToken = d.hetznerApiToken;
        pulumi.all([nsList, d.zoneId]).apply(([servers, zoneId]) => {
          const relativeName = (fqdn || '').split('.')[0] || '@';
          servers.forEach((ns, idx) => {
            // Use a low TTL to speed up delegation propagation
            this.createHetznerRecord(`${name}-ns-${idx}`, zoneId, relativeName, 'NS', ns, 120, hetznerToken);
          });
        });
      }
    }
  }

  private createHetznerRecord(_name: string, zoneId: string, recordName: string, type: string, value: string, ttl: number, apiToken: string): void {
    // Create a custom resource for Hetzner DNS record
    pulumi.output(this.makeHetznerApiCall('POST', '/v1/records', {
      zone_id: zoneId,
      name: recordName,
      type: type,
      value: value,
      ttl: ttl
    }, apiToken)).apply(response => {
      // Handle the case where record already exists (422 error)
      if (response && typeof response === 'object' && 'error' in response) {
        const error = response.error as any;
        if (error && error.code === 422 && error.message && error.message.includes('taken')) {
          pulumi.log.info(`Hetzner DNS record ${recordName} ${type} ${value} already exists, skipping creation`);
          return response;
        }
      }
      return response;
    });
  }

  private makeHetznerApiCall(method: string, path: string, data?: any, apiToken?: string): pulumi.Output<any> {
    if (!apiToken) {
      throw new Error('apiToken is required for Hetzner DNS operations');
    }

    const options = {
      hostname: 'dns.hetzner.com',
      port: 443,
      path: `/api${path}`,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Auth-API-Token': apiToken,
      },
    };

    return pulumi.output(new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () => {
          try {
            // Limit response body size to prevent string length issues
            const limitedBody = body.length > 100000 ? body.substring(0, 100000) + '...' : body;
            const response = JSON.parse(limitedBody);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else if (res.statusCode === 422) {
              // Handle 422 errors (like "taken" records) gracefully
              resolve(response);
            } else {
              // Limit error message size
              const limitedErrorBody = body.length > 10000 ? body.substring(0, 10000) + '...' : body;
              reject(new Error(`Hetzner API error: ${res.statusCode} - ${limitedErrorBody}`));
            }
          } catch (error) {
            // Limit error message size
            const limitedError = String(error).length > 1000 ? String(error).substring(0, 1000) + '...' : String(error);
            reject(new Error(`Failed to parse Hetzner API response: ${limitedError}`));
          }
        });
      });

      req.on('error', (error) => {
        // Limit error message size
        const limitedError = String(error).length > 1000 ? String(error).substring(0, 1000) + '...' : String(error);
        reject(new Error(`Hetzner API request failed: ${limitedError}`));
      });

      if (data) {
        const jsonData = JSON.stringify(data);
        // Limit JSON data size to prevent string length issues
        const limitedData = jsonData.length > 100000 ? jsonData.substring(0, 100000) + '...' : jsonData;
        req.write(limitedData);
      }
      req.end();
    }));
  }
}


