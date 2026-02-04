import { Construct } from 'constructs';
import {
  ManagedZone as CpManagedZone,
  ManagedZoneSpecDeletionPolicy,
  RecordSet as CpRecordSet,
  RecordSetSpecDeletionPolicy,
} from '#imports/dns.gcp.upbound.io';
import {
  DnsDelegation,
  DnsDelegationConfig,
  GcpDelegationConfig,
  CloudflareDelegationConfig,
  HetznerDelegationConfig,
  ManualDelegationConfig,
} from './delegation';
import { BaseConstruct } from '../../../core';

// Re-export delegation types
export { DnsDelegation } from './delegation';
export type {
  DnsDelegationConfig,
  GcpDelegationConfig,
  CloudflareDelegationConfig,
  HetznerDelegationConfig,
  ManualDelegationConfig,
} from './delegation';

// Re-export Cloudflare Composition classes
export {
  DnsCloudflareComposition,
  DnsZoneCloudflareClaim,
} from './cloudflare-composition';
export type {
  DnsCloudflareCompositionConfig,
  DnsZoneCloudflareClaimConfig,
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

export interface DnsConfig {
  /** GCP project ID */
  project: string;
  /** DNS zones to create */
  zones: DnsZoneConfig[];
  /** DNS records to create (optional) */
  records?: Array<DnsRecordConfig & { zoneName: string }>;
  /** ProviderConfig name to use */
  providerConfigRef?: string;
  /** Deletion policy */
  deletionPolicy?: ManagedZoneSpecDeletionPolicy;
}

export class Dns extends BaseConstruct<DnsConfig> {
  public readonly zones: Record<string, CpManagedZone> = {};
  public readonly records: Record<string, CpRecordSet> = {};
  public readonly delegations: Record<string, DnsDelegation> = {};

  constructor(scope: Construct, id: string, config: DnsConfig) {
    super(scope, id, config);

    const providerConfigRef = this.config.providerConfigRef ?? 'default';
    const deletionPolicy = this.config.deletionPolicy ?? ManagedZoneSpecDeletionPolicy.DELETE;

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
            project: this.config.project,
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
      // Note: GCP assigns nameservers dynamically when zones are created.
      // For GCP-to-GCP delegation, use managedZoneRef which resolves this automatically.
      // For external providers (Cloudflare, Hetzner), manual setup is required after zone creation.
      if (zoneConfig.delegation) {
        if (zoneConfig.delegation.provider === 'gcp') {
          // GCP delegation uses managedZoneRef - no explicit nameservers needed
          this.delegations[zoneConfig.name] = new DnsDelegation(
            this,
            `delegation-${zoneConfig.name}`,
            zoneConfig.delegation,
            {
              id: zoneName,
              dnsName: dnsName,
              nameservers: [], // Not used for GCP - managedZoneRef handles this
              deletionPolicy: deletionPolicy === ManagedZoneSpecDeletionPolicy.ORPHAN ? 'Orphan' : 'Delete',
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
              deletionPolicy: deletionPolicy === ManagedZoneSpecDeletionPolicy.ORPHAN ? 'Orphan' : 'Delete',
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

        const recordId = `${recordConfig.zoneName}-${recordConfig.name}-${recordConfig.type}`.toLowerCase();

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
              project: this.config.project,
            },
            providerConfigRef: {
              name: providerConfigRef,
            },
            deletionPolicy: deletionPolicy === ManagedZoneSpecDeletionPolicy.ORPHAN
              ? RecordSetSpecDeletionPolicy.ORPHAN
              : RecordSetSpecDeletionPolicy.DELETE,
          },
        });
      }
    }
  }
}

export { ManagedZoneSpecDeletionPolicy } from '#imports/dns.gcp.upbound.io';
