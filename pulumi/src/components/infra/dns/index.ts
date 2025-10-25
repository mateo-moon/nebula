import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';
import * as https from 'https';

export type DnsDelegationProvider = 'cloudflare' | 'hetzner';

export interface DnsDelegationConfig {
  provider: DnsDelegationProvider;
  zoneId: string;
  email?: string;
}

export type DnsProvider = 'gcp' | 'aws' | 'hetzner';

export interface DnsConfig {
  provider: DnsProvider;
  dnsDelegations?: DnsDelegationConfig[];
  enabled?: boolean;
  domain?: string; // e.g. example.com or sub.example.com
  delegations?: DnsDelegationConfig[]; // optional upstream DNS delegations
}

export interface DnsOutput {
  zoneId?: pulumi.Output<string>;
  nameServers?: pulumi.Output<string[]>;
}

export class Dns extends pulumi.ComponentResource {
  public readonly zoneId?: pulumi.Output<string>;
  public readonly nameServers?: pulumi.Output<string[]>;

  constructor(name: string, cfg: DnsConfig, opts?: pulumi.ComponentResourceOptions) {
    super('dns', name, {}, opts);

    if (cfg.enabled === false || !cfg.domain) {
      this.registerOutputs({});
      return;
    }

    const domain = cfg.domain.replace(/\.$/, '');

    if (cfg.provider === 'gcp') {
      const zone = new gcp.dns.ManagedZone(`${name}-zone`, {
        name: `${name}-zone`,
        dnsName: domain.endsWith('.') ? domain : `${domain}.`,
        description: 'Managed by Pulumi',
      }, { parent: this });
      this.zoneId = zone.id;
      this.nameServers = zone.nameServers as pulumi.Output<string[]>;
      this.applyDelegations(name, domain, this.nameServers, cfg.delegations);
    } else if (cfg.provider === 'aws') {
      const zone = new aws.route53.Zone(`${name}-zone`, {
        name: domain,
        comment: 'Managed by Pulumi',
        forceDestroy: true,
      }, { parent: this });
      // nameServers are available after creation
      this.zoneId = zone.id;
      this.nameServers = zone.nameServers as pulumi.Output<string[]>;
      this.applyDelegations(name, domain, this.nameServers, cfg.delegations);
    } else if (cfg.provider === 'hetzner') {
      // Create Hetzner DNS zone using custom implementation
      const hetznerZone = this.createHetznerZone(name, domain);
      this.zoneId = hetznerZone.zoneId;
      this.nameServers = hetznerZone.nameServers;
      this.applyDelegations(name, domain, this.nameServers, cfg.delegations);
    } else {
      throw new Error(`Unsupported DNS provider: ${cfg.provider}`);
    }

    const outputs: any = {};
    if (this.zoneId) outputs.zoneId = this.zoneId;
    if (this.nameServers) outputs.nameServers = this.nameServers;
    this.registerOutputs(outputs);
  }

  public get outputs(): DnsOutput {
    const o: any = {};
    if (this.zoneId) o.zoneId = this.zoneId;
    if (this.nameServers) o.nameServers = this.nameServers;
    return o as DnsOutput;
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
        pulumi.all([nsList, d.zoneId]).apply(([servers, zoneId]) => {
          const relativeName = (fqdn || '').split('.')[0] || '@';
          servers.forEach((ns, idx) => {
            // Use a low TTL to speed up delegation propagation
            this.createHetznerRecord(`${name}-ns-${idx}`, zoneId, relativeName, 'NS', ns, 120);
          });
        });
      }
    }
  }

  private createHetznerZone(_name: string, domain: string): { zoneId: pulumi.Output<string>; nameServers: pulumi.Output<string[]> } {
    // Create a custom resource for Hetzner DNS zone
    const zoneId = this.makeHetznerApiCall('POST', '/v1/zones', {
      name: domain,
      // Lower default TTL for all records in the zone to speed propagation
      ttl: 120
    }).apply((response: any) => response.zone.id as string);

    const nameServers = zoneId.apply(id => 
      this.makeHetznerApiCall('GET', `/v1/zones/${id}`)
        .apply((response: any) => response.zone.ns as string[])
    );

    return { zoneId, nameServers };
  }

  private createHetznerRecord(_name: string, zoneId: string, recordName: string, type: string, value: string, ttl: number): void {
    // Create a custom resource for Hetzner DNS record
    pulumi.output(this.makeHetznerApiCall('POST', `/v1/records`, {
      zone_id: zoneId,
      name: recordName,
      type: type,
      value: value,
      ttl: ttl
    })).apply(response => {
      // Handle the case where record already exists (422 error)
      if (response && typeof response === 'object' && 'error' in response) {
        const error = response.error as any;
        if (error && error.code === 422 && error.message && error.message.includes('taken')) {
          console.log(`Hetzner DNS record ${recordName} ${type} ${value} already exists, skipping creation`);
          return response;
        }
      }
      return response;
    });
  }

  private makeHetznerApiCall(method: string, path: string, data?: any): pulumi.Output<any> {
    const config = new pulumi.Config('hetzner');
    const apiToken = config.requireSecret('apiToken');
    
    // Use pulumi.output() with Promise to avoid serialization issues
    return pulumi.output(apiToken).apply((resolvedToken) => {
      if (!resolvedToken) {
        throw new Error('hetzner:apiToken is required for Hetzner DNS operations');
      }

      const options = {
        hostname: 'dns.hetzner.com',
        port: 443,
        path: `/api${path}`,
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Auth-API-Token': resolvedToken,
        },
      };

      return new Promise((resolve, reject) => {
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
      });
    });
  }
}


