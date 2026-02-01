/**
 * Dns - DNS zone management with delegation support.
 * 
 * GCP provider is auto-injected from config. Domain defaults to config.domain if not specified.
 * 
 * @example
 * ```typescript
 * import { setConfig } from 'nebula';
 * import { Dns } from 'nebula/modules/infra/dns';
 * 
 * setConfig({
 *   backendUrl: 'gs://my-bucket',
 *   gcpProject: 'my-project',
 *   gcpRegion: 'europe-west3',
 *   domain: 'example.com',
 * });
 * 
 * new Dns('my-dns', {
 *   provider: 'gcp',
 *   delegations: [{ provider: 'cloudflare', zoneId: '...' }],
 * });
 * ```
 */
import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as cloudflare from '@pulumi/cloudflare';
import * as https from 'https';
import { BaseModule } from '../../../core/base-module';
import { getConfig } from '../../../core/config';

export type DnsDelegationProvider = 'cloudflare' | 'hetzner';

export interface CloudflareDelegationConfig {
  provider: 'cloudflare';
  zoneId: string;
  email?: string;
}

export interface HetznerDelegationConfig {
  provider: 'hetzner';
  zoneId: string;
  hetznerApiToken: string;
}

export type DnsDelegationConfig = CloudflareDelegationConfig | HetznerDelegationConfig;

export type DnsProvider = 'gcp';

export interface DnsConfig {
  provider: DnsProvider;
  dnsDelegations?: DnsDelegationConfig[];
  enabled?: boolean;
  /** Domains to manage. Defaults to [config.domain] if not specified. */
  domains?: string[];
  delegations?: DnsDelegationConfig[];
}

export interface DnsOutput {
  zones: Map<string, { zoneId: pulumi.Output<string>; nameServers: pulumi.Output<string[]> }>;
}

export class Dns extends BaseModule {
  public readonly zones: Map<string, { zoneId: pulumi.Output<string>; nameServers: pulumi.Output<string[]> }>;

  constructor(name: string, cfg: DnsConfig, opts?: pulumi.ComponentResourceOptions) {
    super('nebula:Dns', name, cfg as unknown as Record<string, unknown>, opts, { needsGcp: true });

    this.zones = new Map();
    
    // Get domains from config if not specified
    const nebulaConfig = getConfig();
    const domains = cfg.domains ?? (nebulaConfig?.domain ? [nebulaConfig.domain] : []);
    
    if (cfg.enabled === false || domains.length === 0) {
      this.registerOutputs({ zones: this.zones });
      return;
    }

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
    
    for (const d of delegations) {
      if (d.provider === 'cloudflare') {
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
        const hetznerToken = d.hetznerApiToken;
        pulumi.all([nsList, d.zoneId]).apply(([servers, zoneId]) => {
          const relativeName = (fqdn || '').split('.')[0] || '@';
          servers.forEach((ns, idx) => {
            this.createHetznerRecord(`${name}-ns-${idx}`, zoneId, relativeName, 'NS', ns, 120, hetznerToken);
          });
        });
      }
    }
  }

  private createHetznerRecord(_name: string, zoneId: string, recordName: string, type: string, value: string, ttl: number, apiToken: string): void {
    pulumi.output(this.makeHetznerApiCall('POST', '/v1/records', {
      zone_id: zoneId,
      name: recordName,
      type: type,
      value: value,
      ttl: ttl
    }, apiToken)).apply(response => {
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
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            const limitedBody = body.length > 100000 ? body.substring(0, 100000) + '...' : body;
            const response = JSON.parse(limitedBody);
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(response);
            } else if (res.statusCode === 422) {
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
        const jsonData = JSON.stringify(data);
        const limitedData = jsonData.length > 100000 ? jsonData.substring(0, 100000) + '...' : jsonData;
        req.write(limitedData);
      }
      req.end();
    }));
  }
}
