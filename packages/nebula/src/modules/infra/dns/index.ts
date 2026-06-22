import { Construct } from 'constructs';
import {
  ManagedZone as CpManagedZone,
  ManagedZoneSpecDeletionPolicy,
  RecordSet as CpRecordSet,
  RecordSetSpecDeletionPolicy,
} from '#imports/dns.gcp.upbound.io';
import {
  Zone as CpRoute53Zone,
  ZoneSpecDeletionPolicy,
} from '#imports/route53.aws.upbound.io';
import {
  DnsDelegation,
  DnsDelegationConfig,
  GcpDelegationConfig,
  CloudflareDelegationConfig,
  HetznerDelegationConfig,
  ManualDelegationConfig,
} from './delegation';
import { BaseConstruct } from '../../../core';
import { mapDeletionPolicy } from '../_shared';

// Re-export delegation types
export { DnsDelegation } from './delegation';
export type {
  DnsDelegationConfig,
  GcpDelegationConfig,
  CloudflareDelegationConfig,
  HetznerDelegationConfig,
  ManualDelegationConfig,
} from './delegation';

// Re-export Cloudflare Composition classes (Crossplane v2)
export {
  DnsCloudflareComposition,
  DnsZoneCloudflare,
} from './cloudflare-composition';
export type {
  DnsCloudflareCompositionConfig,
  DnsZoneCloudflareConfig,
  DnsGkeWorkloadIdentityConfig,
  DnsWorkloadIdentityConfig, // @deprecated - use DnsGkeWorkloadIdentityConfig
} from './cloudflare-composition';

export interface DnsZoneConfig {
  /** Zone name (used as resource name) */
  name: string;
  /** DNS name (e.g., "example.com.") - trailing dot added if missing */
  dnsName: string;
  /** Description */
  description?: string;
  /** Labels */
  labels?: Record<string, string>;
  /** Enable DNSSEC */
  dnssec?: boolean;
  /** Force destroy (delete all records on zone deletion) */
  forceDestroy?: boolean;
  /** Delegation config - where to create NS records pointing to this zone */
  delegation?: DnsDelegationConfig;
}

export interface DnsRecordConfig {
  /** Record name (e.g., "www" or "@" for apex) */
  name: string;
  /** Record type (A, AAAA, CNAME, MX, TXT, etc.) */
  type: string;
  /** TTL in seconds */
  ttl?: number;
  /** Record data values */
  rrdatas: string[];
}

/** DNS backend that owns the hosted zones. */
export type DnsProvider = 'gcp' | 'aws';

export interface DnsConfig {
  /**
   * DNS backend (defaults to `'gcp'`). `'gcp'` provisions Cloud DNS managed
   * zones (and optionally record sets + delegation); `'aws'` provisions
   * Route53 hosted zones (records are left to external-dns).
   */
  provider?: DnsProvider;
  /** GCP project ID (required when `provider` is `'gcp'`). */
  project?: string;
  /** DNS zones to create */
  zones: DnsZoneConfig[];
  /** DNS records to create (optional; GCP provider only) */
  records?: Array<DnsRecordConfig & { zoneName: string }>;
  /** ProviderConfig name to use */
  providerConfigRef?: string;
  /** Deletion policy */
  deletionPolicy?: ManagedZoneSpecDeletionPolicy;
}

export class Dns extends BaseConstruct<DnsConfig> {
  /** GCP Cloud DNS managed zones (populated for the `gcp` provider). */
  public readonly zones: Record<string, CpManagedZone> = {};
  /** AWS Route53 hosted zones (populated for the `aws` provider). */
  public readonly awsZones: Record<string, CpRoute53Zone> = {};
  public readonly records: Record<string, CpRecordSet> = {};
  public readonly delegations: Record<string, DnsDelegation> = {};

  constructor(scope: Construct, id: string, config: DnsConfig) {
    super(scope, id, config);

    const provider: DnsProvider = this.config.provider ?? 'gcp';
    const providerConfigRef = this.config.providerConfigRef ?? 'default';
    const deletionPolicy = this.config.deletionPolicy ?? ManagedZoneSpecDeletionPolicy.DELETE;

    // AWS Route53 path: basic hosted zones, mirroring the GCP zone shape.
    // Records and delegation stay GCP-only (external-dns manages Route53 records).
    if (provider === 'aws') {
      this.createRoute53Zones(providerConfigRef, deletionPolicy);
      return;
    }

    // GCP Cloud DNS path (default; unchanged behavior).
    const project = this.config.project;
    if (!project) {
      throw new Error("Dns: `project` is required when provider is 'gcp'.");
    }

    // Create DNS zones
    for (const zoneConfig of this.config.zones) {
      // Ensure DNS name ends with a dot
      const dnsName = zoneConfig.dnsName.endsWith('.')
        ? zoneConfig.dnsName
        : `${zoneConfig.dnsName}.`;

      // Create zone name from DNS name (replace dots with dashes)
      const zoneName = zoneConfig.name || dnsName.replace(/\./g, '-').slice(0, -1);

      const zone = new CpManagedZone(this, `zone-${zoneConfig.name}`, {
        metadata: {
          name: zoneName,
        },
        spec: {
          forProvider: {
            dnsName: dnsName,
            description: zoneConfig.description ?? `Managed by Crossplane`,
            project: project,
            labels: zoneConfig.labels,
            forceDestroy: zoneConfig.forceDestroy ?? true,
            ...(zoneConfig.dnssec ? {
              dnssecConfig: [{
                state: 'on',
              }],
            } : {}),
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
          deletionPolicy: deletionPolicy,
        },
      });

      this.zones[zoneConfig.name] = zone;

      // Handle delegation
      // Note: GCP assigns nameservers dynamically when zones are created, so they
      // are NOT known at synthesis time. The child zone's nameservers must be
      // supplied explicitly (delegation.nameservers) after the zone is created;
      // there is no managedZoneRef that auto-populates an NS record's rrdatas.
      // For external providers (Cloudflare, Hetzner), manual setup is required.
      if (zoneConfig.delegation) {
        if (zoneConfig.delegation.provider === 'gcp') {
          // GCP delegation emits an NS RecordSet in the parent zone. The child
          // zone's nameservers must be provided via delegation.nameservers; if
          // omitted, DnsDelegation logs a warning and creates nothing.
          this.delegations[zoneConfig.name] = new DnsDelegation(
            this,
            `delegation-${zoneConfig.name}`,
            zoneConfig.delegation,
            {
              id: zoneName,
              dnsName: dnsName,
              nameservers: zoneConfig.delegation.nameservers ?? [],
              deletionPolicy: mapDeletionPolicy<'Orphan' | 'Delete'>(deletionPolicy) ?? 'Delete',
            },
          );
        } else if (zoneConfig.delegation.provider !== 'manual') {
          // For Cloudflare/Hetzner, create a delegation object that outputs instructions
          // Nameservers must be obtained after zone creation
          console.warn(`[DNS] Zone '${zoneConfig.name}': External delegation to ${zoneConfig.delegation.provider} requires manual setup.`);
          console.warn(`[DNS] After zone is created, get nameservers with:`);
          console.warn(`[DNS]   kubectl get managedzone.dns.gcp.upbound.io ${zoneName} -o jsonpath='{.status.atProvider.nameServers}'`);
          
          this.delegations[zoneConfig.name] = new DnsDelegation(
            this,
            `delegation-${zoneConfig.name}`,
            zoneConfig.delegation,
            {
              id: zoneName,
              dnsName: dnsName,
              nameservers: [], // Must be configured after zone creation
              deletionPolicy: mapDeletionPolicy<'Orphan' | 'Delete'>(deletionPolicy) ?? 'Delete',
            },
          );
        }
      }
    }

    // Create DNS records
    if (this.config.records) {
      for (const recordConfig of this.config.records) {
        const zoneConfig = this.config.zones.find(z => z.name === recordConfig.zoneName);
        const zone = this.zones[recordConfig.zoneName];
        if (!zone || !zoneConfig) {
          throw new Error(`Zone '${recordConfig.zoneName}' not found for record '${recordConfig.name}'`);
        }

        // Build full DNS name (GCP requires FQDN with trailing dot)
        const zoneDnsName = zoneConfig.dnsName.endsWith('.') 
          ? zoneConfig.dnsName 
          : `${zoneConfig.dnsName}.`;
        const recordName = recordConfig.name === '@'
          ? zoneDnsName
          : `${recordConfig.name}.${zoneDnsName}`;

        // metadata.name must be a valid RFC-1123 subdomain. The raw record name
        // can be '@' (apex) or contain '_' (e.g. _dmarc, _acme-challenge, DKIM
        // selectors, SRV _sip._tcp), all of which are illegal in metadata.name
        // and would make kubectl apply hard-fail. Slugify it (the DNS name on
        // spec.forProvider.name above is computed separately and stays correct).
        const safeRecordName =
          recordConfig.name === '@'
            ? 'apex'
            : recordConfig.name
                .toLowerCase()
                .replace(/[^a-z0-9-]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'record';
        const recordId = `${recordConfig.zoneName}-${safeRecordName}-${recordConfig.type}`.toLowerCase();

        this.records[recordId] = new CpRecordSet(this, `record-${recordId}`, {
          metadata: {
            name: recordId,
          },
          spec: {
            forProvider: {
              name: recordName,
              managedZoneRef: {
                name: zone.metadata.name!,
              },
              type: recordConfig.type,
              ttl: recordConfig.ttl ?? 300,
              rrdatas: recordConfig.rrdatas,
              project: project,
            },
            providerConfigRef: {
              name: providerConfigRef,
            },
            deletionPolicy:
              mapDeletionPolicy<RecordSetSpecDeletionPolicy>(deletionPolicy) ??
              RecordSetSpecDeletionPolicy.DELETE,
          },
        });
      }
    }
  }

  /**
   * Provision AWS Route53 hosted zones, mirroring the GCP zone shape.
   *
   * This is intentionally a basic hosted-zone path: record sets and NS
   * delegation are not emitted here (external-dns manages Route53 records, and
   * the GCP-specific delegation flow does not apply). `dnssec` is also a no-op
   * for Route53 (it requires a separate KeySigningKey resource).
   */
  private createRoute53Zones(
    providerConfigRef: string,
    deletionPolicy: ManagedZoneSpecDeletionPolicy,
  ): void {
    for (const zoneConfig of this.config.zones) {
      // Route53 zone names are conventionally stored without a trailing dot.
      const dnsName = zoneConfig.dnsName.replace(/\.$/, '');
      const zoneName = zoneConfig.name || dnsName.replace(/\./g, '-');

      if (zoneConfig.dnssec) {
        console.warn(
          `[DNS] Zone '${zoneConfig.name}': DNSSEC is not configured for the aws provider (requires a separate Route53 KeySigningKey).`,
        );
      }
      if (zoneConfig.delegation) {
        console.warn(
          `[DNS] Zone '${zoneConfig.name}': delegation is GCP-only and is ignored for the aws provider.`,
        );
      }

      this.awsZones[zoneConfig.name] = new CpRoute53Zone(this, `zone-${zoneConfig.name}`, {
        metadata: {
          name: zoneName,
        },
        spec: {
          forProvider: {
            name: dnsName,
            comment: zoneConfig.description ?? 'Managed by Crossplane',
            forceDestroy: zoneConfig.forceDestroy ?? true,
            ...(zoneConfig.labels ? { tags: zoneConfig.labels } : {}),
          },
          providerConfigRef: {
            name: providerConfigRef,
          },
          deletionPolicy:
            mapDeletionPolicy<ZoneSpecDeletionPolicy>(deletionPolicy) ??
            ZoneSpecDeletionPolicy.DELETE,
        },
      });
    }

    if (this.config.records && this.config.records.length > 0) {
      console.warn(
        '[DNS] DNS records are not provisioned for the aws provider; external-dns manages Route53 records.',
      );
    }
  }
}

export { ManagedZoneSpecDeletionPolicy } from '#imports/dns.gcp.upbound.io';
export { ZoneSpecDeletionPolicy as Route53ZoneSpecDeletionPolicy } from '#imports/route53.aws.upbound.io';
