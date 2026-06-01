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
        // Create Hetzner NS rrset with all nameservers at once
        const hetznerToken = d.hetznerApiToken;
        pulumi.all([nsList, d.zoneId]).apply(([servers, zoneId]) => {
          const relativeName = (fqdn || '').split('.')[0] || '@';
          this.createHetznerRrset(zoneId, relativeName, 'NS', servers, 120, hetznerToken);
        });
      }
    }
  }

  private createHetznerRrset(zoneId: string, recordName: string, type: string, values: string[], ttl: number, apiToken: string): void {
    pulumi.output(this.makeHetznerApiCall('POST', `/v1/zones/${zoneId}/rrsets`, {
      name: recordName,
      type: type,
      ttl: ttl,
      records: values.map(v => ({ value: v })),
    }, apiToken)).apply((response: any) => {
      if (response && typeof response === 'object' && 'error' in response) {
        const error = response.error as any;
        // Handle conflict when rrset already exists
        if (error && (error.code === 'conflict' || error.code === 'uniqueness_error')) {
          pulumi.log.info(`Hetzner DNS rrset ${recordName} ${type} already exists, skipping creation`);
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
      hostname: 'api.hetzner.cloud',
      port: 443,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiToken}`,
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
            const limitedBody = body.length > 100000 ? body.substring(0, 100000) + '...' : body;
            const response = JSON.parse(limitedBody);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else if (res.statusCode === 409) {
              // Handle conflict (rrset already exists) gracefully
              resolve(response);
            } else {
              const limitedErrorBody = body.length > 10000 ? body.substring(0, 10000) + '...' : body;
              reject(new Error(`Hetzner API error: ${res.statusCode} - ${limitedErrorBody}`));
            }
          } catch (error) {
            const limitedError = String(error).length > 1000 ? String(error).substring(0, 1000) + '...' : String(error);
            reject(new Error(`Failed to parse Hetzner API response: ${limitedError}`));
          }
        });
      });

      req.on('error', (error) => {
        const limitedError = String(error).length > 1000 ? String(error).substring(0, 1000) + '...' : String(error);
        reject(new Error(`Hetzner API request failed: ${limitedError}`));
      });

      if (data) {
        req.write(JSON.stringify(data));
      }
      req.end();
    }));
  }
}


