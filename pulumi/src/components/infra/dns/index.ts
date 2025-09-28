import * as pulumi from '@pulumi/pulumi';
import * as gcp from '@pulumi/gcp';
import * as aws from '@pulumi/aws';
import * as cloudflare from '@pulumi/cloudflare';

export type DnsDelegationProvider = 'cloudflare' | 'hetzner';

export interface DnsDelegationConfig {
  provider: DnsDelegationProvider;
  zoneId: string;
  email?: string;
}

export type DnsProvider = 'gcp' | 'aws';

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
    super('nebula:infra:dns:Module', name, {}, opts);

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
    } else {
      throw new Error(`Unsupported DNS provider: ${cfg.provider}`);
    }

    this.registerOutputs({ zoneId: this.zoneId, nameServers: this.nameServers });
  }

  public get outputs(): DnsOutput {
    return { zoneId: this.zoneId, nameServers: this.nameServers };
  }

  private applyDelegations(name: string, fqdn: string, nsList?: pulumi.Output<string[]>, delegations?: DnsDelegationConfig[]) {
    if (!nsList || !delegations || delegations.length === 0) return;
    nsList.apply(async (servers) => {
      for (const d of delegations) {
        if (d.provider === 'cloudflare') {
          servers.forEach((ns, idx) => {
            new cloudflare.Record(`${name}-ns-${idx}`, {
              zoneId: d.zoneId,
              name: fqdn,
              type: 'NS',
              ttl: 3600,
              content: ns,
            }, { parent: this });
          });
        } else if (d.provider === 'hetzner') {
          // Placeholder: implement Hetzner DNS in future
        }
      }
    });
  }
}


