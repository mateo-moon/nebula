import * as gcp from '@pulumi/gcp';

export interface DnsConfig {
  domain?: string;
}

export class DnsZone {
  public readonly zone?: gcp.dns.ManagedZone;
  constructor(name: string, cfg: DnsConfig) {
    if (!cfg.domain) return;
    this.zone = new gcp.dns.ManagedZone(`${name}-zone`, {
      name: `${name}-zone`,
      dnsName: cfg.domain.endsWith('.') ? cfg.domain : `${cfg.domain}.`,
      description: 'Managed by Pulumi',
    });
  }
}


