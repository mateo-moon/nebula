import { Construct } from 'constructs';
import { ApiObject } from 'cdk8s';
import {
  RecordSet as CpRecordSet,
  RecordSetSpecDeletionPolicy,
} from '#imports/dns.gcp.upbound.io';

// TODO: Cloudflare delegation requires a working Crossplane provider
// The cdloh/provider-cloudflare is not published to xpkg.upbound.io
// Options:
// 1. Build and push cdloh/provider-cloudflare image to your own registry
// 2. Wait for official Upbound Cloudflare provider
// 3. Use manual delegation and create NS records via Cloudflare dashboard/API
//
// import {
//   Record as CfRecord,
//   RecordSpecDeletionPolicy as CfRecordSpecDeletionPolicy,
// } from '#imports/dns.cloudflare.upbound.io';

// TODO: Hetzner delegation requires a Crossplane provider
// There is no official Crossplane provider for Hetzner DNS
// Options:
// 1. Create a custom provider using provider-jet or upjet
// 2. Use a Kubernetes Job to call Hetzner DNS API
// 3. Use manual delegation

/** Delegation to a GCP parent zone */
export interface GcpDelegationConfig {
  provider: 'gcp';
  /** Parent zone name (Crossplane resource name) */
  parentZoneName: string;
  /** GCP project ID for the parent zone */
  project: string;
  /** TTL for NS records (default: 3600) */
  ttl?: number;
  /** ProviderConfig name for GCP */
  providerConfigRef?: string;
}

/** 
 * Delegation to Cloudflare
 * 
 * TODO: Not yet implemented - requires Crossplane provider for Cloudflare
 * For now, use 'manual' delegation and create NS records in Cloudflare dashboard
 */
export interface CloudflareDelegationConfig {
  provider: 'cloudflare';
  /** Cloudflare zone ID */
  zoneId: string;
  /** TTL for NS records (default: 3600, use 1 for automatic) */
  ttl?: number;
  /** ProviderConfig name for Cloudflare */
  providerConfigRef?: string;
}

/**
 * Delegation to Hetzner DNS
 * 
 * TODO: Not yet implemented - requires Crossplane provider for Hetzner
 * For now, use 'manual' delegation and create NS records in Hetzner dashboard
 */
export interface HetznerDelegationConfig {
  provider: 'hetzner';
  /** Hetzner DNS zone ID */
  zoneId: string;
  /** TTL for NS records (default: 3600) */
  ttl?: number;
}

/** Manual delegation (outputs nameservers for manual setup) */
export interface ManualDelegationConfig {
  provider: 'manual';
}

export type DnsDelegationConfig = 
  | GcpDelegationConfig 
  | CloudflareDelegationConfig 
  | HetznerDelegationConfig
  | ManualDelegationConfig;

export interface DelegationOptions {
  /** Unique identifier for the delegation */
  id: string;
  /** DNS name of the zone being delegated (e.g., "sub.example.com") */
  dnsName: string;
  /** 
   * Nameservers to delegate to.
   * 
   * IMPORTANT: GCP assigns nameservers dynamically when zones are created.
   * These are NOT known at synthesis time. Options:
   * 
   * 1. Leave empty and configure manually after zone creation
   * 2. Use a Crossplane Composition to patch nameservers from zone status
   * 3. Pre-create zone, get nameservers, then add delegation config
   */
  nameservers?: string[];
  /** Deletion policy */
  deletionPolicy?: 'Delete' | 'Orphan';
}

/**
 * Creates NS delegation records in a parent zone.
 * 
 * Currently supported:
 * - GCP Cloud DNS (fully implemented)
 * - Manual (no records created, for manual setup)
 * 
 * Planned but not yet implemented:
 * - Cloudflare (requires Crossplane provider)
 * - Hetzner (requires Crossplane provider)
 */
export class DnsDelegation extends Construct {
  public readonly records: ApiObject[] = [];
  
  /** Nameservers that should be configured in the parent zone (empty if not yet known) */
  public readonly nameservers: string[];
  
  /** Instructions for manual delegation setup */
  public readonly manualSetupInstructions?: string;

  constructor(scope: Construct, id: string, delegation: DnsDelegationConfig, options: DelegationOptions) {
    super(scope, id);
    
    this.nameservers = options.nameservers ?? [];

    if (delegation.provider === 'manual') {
      // For manual delegation, no records created
      this.manualSetupInstructions = this.getManualInstructions(options);
      return;
    }

    if (delegation.provider === 'gcp') {
      this.createGcpDelegation(delegation, options);
    } else if (delegation.provider === 'cloudflare') {
      // TODO: Cloudflare delegation not yet implemented
      // Treating as manual delegation for now
      console.warn(`[DNS Delegation] Cloudflare delegation for '${options.dnsName}' is not yet automated.`);
      console.warn(`[DNS Delegation] Please manually create NS records in Cloudflare zone ${delegation.zoneId}`);
      this.manualSetupInstructions = this.getCloudflareInstructions(delegation, options);
    } else if (delegation.provider === 'hetzner') {
      // TODO: Hetzner delegation not yet implemented
      // Treating as manual delegation for now
      console.warn(`[DNS Delegation] Hetzner delegation for '${options.dnsName}' is not yet automated.`);
      console.warn(`[DNS Delegation] Please manually create NS records in Hetzner zone ${delegation.zoneId}`);
      this.manualSetupInstructions = this.getHetznerInstructions(delegation, options);
    }
  }
  
  private getManualInstructions(options: DelegationOptions): string {
    const nsInfo = options.nameservers?.length 
      ? `Create NS records pointing to:\n${options.nameservers.map(ns => `  - ${ns}`).join('\n')}`
      : `Get nameservers after zone creation:\n  kubectl get managedzone.dns.gcp.upbound.io <zone-name> -o jsonpath='{.status.atProvider.nameServers}'`;
    return `Manual delegation required for '${options.dnsName}'.\n${nsInfo}`;
  }
  
  private getCloudflareInstructions(delegation: CloudflareDelegationConfig, options: DelegationOptions): string {
    const nsInfo = options.nameservers?.length
      ? options.nameservers.map(ns => `  - ${ns.replace(/\.$/, '')}`).join('\n')
      : `  (Get nameservers after zone creation)`;
    return `Cloudflare delegation for '${options.dnsName}':\n` +
      `Zone ID: ${delegation.zoneId}\n` +
      `Create NS records with name '${options.dnsName.replace(/\.$/, '')}' pointing to:\n${nsInfo}`;
  }
  
  private getHetznerInstructions(delegation: HetznerDelegationConfig, options: DelegationOptions): string {
    const nsInfo = options.nameservers?.length
      ? options.nameservers.map(ns => `  - ${ns.replace(/\.$/, '')}`).join('\n')
      : `  (Get nameservers after zone creation)`;
    return `Hetzner delegation for '${options.dnsName}':\n` +
      `Zone ID: ${delegation.zoneId}\n` +
      `Create NS records with name '${options.dnsName.replace(/\.$/, '')}' pointing to:\n${nsInfo}`;
  }

  private createGcpDelegation(delegation: GcpDelegationConfig, options: DelegationOptions): void {
    // GCP-to-GCP delegation requires nameservers to be known
    // These must be obtained after the child zone is created
    if (!options.nameservers?.length) {
      console.warn(`[DNS Delegation] GCP delegation for '${options.dnsName}' skipped - no nameservers provided.`);
      console.warn(`[DNS Delegation] Get nameservers with: kubectl get managedzone.dns.gcp.upbound.io <zone> -o jsonpath='{.status.atProvider.nameServers}'`);
      console.warn(`[DNS Delegation] Then add nameservers to delegation config and re-apply.`);
      return;
    }

    const providerConfigRef = delegation.providerConfigRef ?? 'default';
    const ttl = delegation.ttl ?? 3600;
    const dnsName = options.dnsName.endsWith('.') ? options.dnsName : `${options.dnsName}.`;
    
    const deletionPolicy = options.deletionPolicy === 'Orphan'
      ? RecordSetSpecDeletionPolicy.ORPHAN
      : RecordSetSpecDeletionPolicy.DELETE;

    // Create NS record set in parent zone
    const nsRecord = new CpRecordSet(this, 'ns-record', {
      metadata: {
        name: `${options.id}-ns`,
      },
      spec: {
        forProvider: {
          name: dnsName,
          managedZoneRef: {
            name: delegation.parentZoneName,
          },
          type: 'NS',
          ttl: ttl,
          rrdatas: options.nameservers.map(ns => ns.endsWith('.') ? ns : `${ns}.`),
          project: delegation.project,
        },
        providerConfigRef: {
          name: providerConfigRef,
        },
        deletionPolicy: deletionPolicy,
      },
    });

    this.records.push(nsRecord);
  }

  // TODO: Implement Cloudflare delegation when provider is available
  // private createCloudflareDelegation(delegation: CloudflareDelegationConfig, options: DelegationOptions): void {
  //   // Requires: import { Record as CfRecord } from '#imports/dns.cloudflare.upbound.io';
  //   // Create individual NS records for each nameserver in the Cloudflare zone
  // }

  // TODO: Implement Hetzner delegation when provider is available
  // private createHetznerDelegation(delegation: HetznerDelegationConfig, options: DelegationOptions): void {
  //   // Requires a Crossplane provider for Hetzner DNS
  //   // Create NS records via Hetzner DNS API
  // }
}

/**
 * IMPORTANT: GCP assigns nameservers dynamically when a zone is created.
 * The nameservers follow patterns like ns-cloud-{a,b,c,d,e}{1,2,3,4}.googledomains.com
 * but the specific set is determined by GCP at creation time.
 * 
 * To get the actual nameservers after zone creation:
 * 
 * Using kubectl:
 *   kubectl get managedzone.dns.gcp.upbound.io <zone-name> -o jsonpath='{.status.atProvider.nameServers}'
 * 
 * Using gcloud:
 *   gcloud dns managed-zones describe <zone-name> --format='value(nameServers)'
 * 
 * For Crossplane Compositions, use patches to reference the zone's nameServers status field.
 */
