/**
 * Cloudflare DNS Delegation via Crossplane Composition
 * 
 * This module creates:
 * 1. A CompositeResourceDefinition (XRD) for DnsZoneCloudflare
 * 2. A Composition that creates GCP ManagedZone and delegates to Cloudflare via HTTP provider
 * 3. An HTTP ProviderConfig for Cloudflare API authentication
 * 
 * The HTTP provider is used instead of a Cloudflare-specific provider because:
 * - Existing Cloudflare Crossplane providers are outdated
 * - HTTP provider gives direct control over API calls
 * - Easier to maintain and update
 * 
 * Prerequisites:
 * - crossplane-contrib/provider-http v1.0.3+ must be installed
 * - Cloudflare API credentials (API Key + Email)
 * 
 * @example
 * ```typescript
 * // First, deploy the XRD and Composition (one-time setup)
 * // Uses API Key + Email authentication (ref+sops:// supported for vals integration)
 * new DnsCloudflareComposition(chart, 'dns-cloudflare-setup', {
 *   gcpProviderConfigName: 'default',
 *   httpProviderConfigName: 'cloudflare-http',
 *   cloudflareApiKey: 'ref+sops://../.secrets/secrets.yaml#cloudflare/api_key',
 *   cloudflareEmail: 'ref+sops://../.secrets/secrets.yaml#cloudflare/email',
 * });
 * 
 * // Then, create zones using XR (Composite Resource)
 * new DnsZoneCloudflare(chart, 'my-zone', {
 *   dnsName: 'sub.example.com',
 *   project: 'my-gcp-project',
 *   cloudflareZoneId: 'abc123',
 * });
 * ```
 */
import { Construct } from 'constructs';
import { ApiObject } from 'cdk8s';
import * as kplus from 'cdk8s-plus-33';
import {
  CompositeResourceDefinitionV2,
  Composition,
  CompositionSpecMode,
} from '#imports/apiextensions.crossplane.io';
import {
  ManagedZone,
  ManagedZoneSpecDeletionPolicy,
} from '#imports/dns.gcp.upbound.io';
import {
  ServiceAccountIamMember,
} from '#imports/cloudplatform.gcp.upbound.io';
import {
  ProviderConfig as HttpProviderConfig,
  ProviderConfigSpecCredentialsSource as HttpCredentialsSource,
} from '#imports/http.crossplane.io';
import { BaseConstruct } from '../../../core';

/** 
 * Workload Identity configuration for GKE clusters.
 * 
 * Uses conventions:
 * - GSA: crossplane-provider@{project}.iam.gserviceaccount.com
 * - KSA: provider-gcp-dns (requires GcpProvider with enableDeterministicServiceAccounts: true)
 * 
 * Prerequisites:
 * - GcpProvider must be deployed with enableDeterministicServiceAccounts: true
 * - The GSA must have roles/dns.admin permission
 */
export interface DnsGkeWorkloadIdentityConfig {
  /** GCP project ID */
  project: string;
  /** 
   * GCP Service Account email (optional).
   * Default: crossplane-provider@{project}.iam.gserviceaccount.com
   */
  gcpServiceAccount?: string;
  /**
   * Provider name prefix (optional).
   * Must match GcpProvider's name config.
   * Default: 'provider-gcp'
   */
  providerNamePrefix?: string;
  /** Namespace where Crossplane providers run (default: 'crossplane-system') */
  providerNamespace?: string;
}

/** @deprecated Use DnsGkeWorkloadIdentityConfig instead */
export type DnsWorkloadIdentityConfig = DnsGkeWorkloadIdentityConfig;

export interface DnsCloudflareCompositionConfig {
  /** Name of the HTTP ProviderConfig to use for Cloudflare API calls (default: 'cloudflare-http') */
  httpProviderConfigName?: string;
  /** Name of the GCP ProviderConfig to use for ManagedZone */
  gcpProviderConfigName?: string;
  /** Name of the Secret containing Cloudflare credentials (default: 'cloudflare-api') */
  cloudflareSecretName?: string;
  /** Namespace of the Cloudflare secret (default: 'crossplane-system') */
  cloudflareSecretNamespace?: string;
  /** 
   * Cloudflare API Key. If provided along with email, creates the secret and ProviderConfig automatically.
   * The secret stores credentials that are injected as X-Auth-Key header.
   * Supports ref+sops:// references for vals integration.
   * @example 'ref+sops://../.secrets/secrets.yaml#cloudflare/api_key'
   */
  cloudflareApiKey?: string;
  /** 
   * Cloudflare account email. Required when using cloudflareApiKey.
   * Stored in secret and injected as X-Auth-Email header.
   * Supports ref+sops:// references for vals integration.
   * @example 'ref+sops://../.secrets/secrets.yaml#cloudflare/email'
   */
  cloudflareEmail?: string;
  /**
   * Workload Identity configuration for GKE.
   * When provided, creates IAM bindings and KSA annotations for Crossplane DNS provider.
   * Required when using injectedIdentity credentials on GKE.
   * 
   * Prerequisites:
   * - GcpProvider must be deployed with enableDeterministicServiceAccounts: true
   * - The GSA (default: crossplane-provider@{project}.iam.gserviceaccount.com) must have roles/dns.admin
   */
  workloadIdentity?: DnsGkeWorkloadIdentityConfig;
}

/**
 * Creates the XRD and Composition for Cloudflare DNS delegation.
 * 
 * This should be deployed once to set up the infrastructure for creating
 * DNS zones with automatic Cloudflare delegation.
 */
export class DnsCloudflareComposition extends BaseConstruct<DnsCloudflareCompositionConfig> {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  public readonly secret?: kplus.Secret;
  public readonly httpProviderConfig?: HttpProviderConfig;

  constructor(scope: Construct, id: string, config: DnsCloudflareCompositionConfig = {}) {
    super(scope, id, config);

    // Use this.config for resolved secrets (ref+sops:// patterns are decrypted)
    const httpProviderConfigName = this.config.httpProviderConfigName ?? 'cloudflare-http';
    const gcpProviderConfig = this.config.gcpProviderConfigName ?? 'default';
    const cfSecretName = this.config.cloudflareSecretName ?? 'cloudflare-api';
    const cfSecretNamespace = this.config.cloudflareSecretNamespace ?? 'crossplane-system';

    // Create Cloudflare API secret if credentials are provided
    // The secret format is a JSON object with headers for the HTTP provider
    // ref+sops:// references are resolved by BaseConstruct
    if (this.config.cloudflareApiKey && this.config.cloudflareEmail) {
      // Create secret with credentials as JSON containing the auth headers
      // The HTTP provider reads this as the credentials blob
      const credentialsJson = JSON.stringify({
        headers: {
          'X-Auth-Key': [this.config.cloudflareApiKey],
          'X-Auth-Email': [this.config.cloudflareEmail],
          'Content-Type': ['application/json'],
        },
      });

      this.secret = new kplus.Secret(this, 'cloudflare-secret', {
        metadata: {
          name: cfSecretName,
          namespace: cfSecretNamespace,
        },
        stringData: {
          credentials: credentialsJson,
        },
      });

      // Create HTTP ProviderConfig that references the credentials secret
      this.httpProviderConfig = new HttpProviderConfig(this, 'http-provider-config', {
        metadata: {
          name: httpProviderConfigName,
        },
        spec: {
          credentials: {
            source: HttpCredentialsSource.SECRET,
            secretRef: {
              name: cfSecretName,
              namespace: cfSecretNamespace,
              key: 'credentials',
            },
          },
        },
      });
    }

    // Setup Workload Identity for Crossplane DNS provider (GKE only)
    // This allows the provider-gcp-dns pod to authenticate using the specified GSA
    if (this.config.workloadIdentity) {
      const wi = this.config.workloadIdentity;
      const providerNamespace = wi.providerNamespace ?? 'crossplane-system';
      const providerNamePrefix = wi.providerNamePrefix ?? 'provider-gcp';
      // Convention: KSA name matches DeploymentRuntimeConfig service account name
      const providerKsaName = `${providerNamePrefix}-dns`;
      // Convention: GSA follows project naming pattern
      const gcpServiceAccount = wi.gcpServiceAccount ?? `crossplane-provider@${wi.project}.iam.gserviceaccount.com`;

      // Create IAM binding: allow KSA to impersonate GSA
      new ServiceAccountIamMember(this, 'dns-provider-wi', {
        metadata: {
          name: 'crossplane-dns-provider-wi',
        },
        spec: {
          forProvider: {
            serviceAccountId: `projects/${wi.project}/serviceAccounts/${gcpServiceAccount}`,
            role: 'roles/iam.workloadIdentityUser',
            member: `serviceAccount:${wi.project}.svc.id.goog[${providerNamespace}/${providerKsaName}]`,
          },
          providerConfigRef: {
            name: gcpProviderConfig,
          },
        },
      });

      // Annotate the Crossplane DNS provider's KSA to use Workload Identity
      new kplus.k8s.KubeServiceAccount(this, 'dns-provider-ksa', {
        metadata: {
          name: providerKsaName,
          namespace: providerNamespace,
          annotations: {
            'iam.gke.io/gcp-service-account': gcpServiceAccount,
          },
        },
      });
    }

    // Create the XRD (CompositeResourceDefinition) using v2 API
    // Note: In Crossplane v2, claimNames is deprecated - use XR directly
    this.xrd = new CompositeResourceDefinitionV2(this, 'xrd', {
      metadata: {
        name: 'xdnszonecloudflares.nebula.io',
      },
      spec: {
        group: 'nebula.io',
        names: {
          kind: 'XDnsZoneCloudflare',
          plural: 'xdnszonecloudflares',
        },
        // claimNames removed - Crossplane v2 uses XRs directly (cluster-scoped)
        versions: [{
          name: 'v1alpha1',
          served: true,
          referenceable: true,
          schema: {
            openApiv3Schema: {
              type: 'object',
              properties: {
                spec: {
                  type: 'object',
                  required: ['dnsName', 'project', 'cloudflareZoneId'],
                  properties: {
                    dnsName: {
                      type: 'string',
                      description: 'DNS name for the zone (e.g., sub.example.com)',
                    },
                    project: {
                      type: 'string',
                      description: 'GCP project ID',
                    },
                    cloudflareZoneId: {
                      type: 'string',
                      description: 'Cloudflare zone ID where NS records will be created',
                    },
                    description: {
                      type: 'string',
                      description: 'Description for the DNS zone',
                    },
                    ttl: {
                      type: 'string',
                      description: 'TTL for NS records (default: "3600")',
                      default: '3600',
                    },
                  },
                },
                status: {
                  type: 'object',
                  properties: {
                    nameServers: {
                      type: 'array',
                      items: { type: 'string' },
                      description: 'Nameservers assigned by GCP',
                    },
                    zoneName: {
                      type: 'string',
                      description: 'Name of the created ManagedZone',
                    },
                  },
                },
              },
            },
          },
        }],
      },
    });

    // Create the Composition using Pipeline mode with function-patch-and-transform
    // This is the modern Crossplane v2 approach (Resources mode is deprecated)
    this.composition = new Composition(this, 'composition', {
      metadata: {
        name: 'dnszone-cloudflare',
        labels: {
          'crossplane.io/xrd': 'xdnszonecloudflares.nebula.io',
          'delegation-provider': 'cloudflare',
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: 'nebula.io/v1alpha1',
          kind: 'XDnsZoneCloudflare',
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: 'patch-and-transform',
            functionRef: {
              name: 'crossplane-contrib-function-patch-and-transform',
            },
            input: {
              apiVersion: 'pt.fn.crossplane.io/v1beta1',
              kind: 'Resources',
              resources: [
                // Resource 0: GCP ManagedZone
                this.createManagedZoneResource(gcpProviderConfig),
                // Resources 1-4: HTTP Requests for Cloudflare NS records
                this.createCloudflareNsResource(0, httpProviderConfigName),
                this.createCloudflareNsResource(1, httpProviderConfigName),
                this.createCloudflareNsResource(2, httpProviderConfigName),
                this.createCloudflareNsResource(3, httpProviderConfigName),
              ],
            },
          },
        ],
      },
    });
  }

  /**
   * Creates the GCP ManagedZone resource definition for the function-patch-and-transform input.
   */
  private createManagedZoneResource(gcpProviderConfig: string): object {
    return {
      name: 'gcp-managed-zone',
      base: ManagedZone.manifest({
        spec: {
          forProvider: {
            description: 'Managed by Crossplane/Nebula',
            forceDestroy: true,
          },
          providerConfigRef: {
            name: gcpProviderConfig,
          },
          deletionPolicy: ManagedZoneSpecDeletionPolicy.DELETE,
        },
      }),
      patches: [
        // Patch zone name from XR metadata
        {
          type: 'FromCompositeFieldPath',
          fromFieldPath: 'metadata.name',
          toFieldPath: 'metadata.name',
        },
        // Patch DNS name (add trailing dot)
        {
          type: 'FromCompositeFieldPath',
          fromFieldPath: 'spec.dnsName',
          toFieldPath: 'spec.forProvider.dnsName',
          transforms: [{
            type: 'string',
            string: { type: 'Format', fmt: '%s.' },
          }],
        },
        // Patch project
        {
          type: 'FromCompositeFieldPath',
          fromFieldPath: 'spec.project',
          toFieldPath: 'spec.forProvider.project',
        },
        // Patch description (optional)
        {
          type: 'FromCompositeFieldPath',
          fromFieldPath: 'spec.description',
          toFieldPath: 'spec.forProvider.description',
        },
        // Export nameservers to XR status
        {
          type: 'ToCompositeFieldPath',
          fromFieldPath: 'status.atProvider.nameServers',
          toFieldPath: 'status.nameServers',
        },
        // Export zone name to XR status
        {
          type: 'ToCompositeFieldPath',
          fromFieldPath: 'metadata.name',
          toFieldPath: 'status.zoneName',
        },
      ],
    };
  }

  /**
   * Creates a Cloudflare NS record resource for the function-patch-and-transform input.
   * Uses provider-http v1.0.3+ to make direct API calls to Cloudflare.
   * 
   * Authentication is handled via ProviderConfig which injects headers from the credentials secret.
   * 
   * Note: provider-http v1.0.3+ v1alpha2 API uses:
   * - payload: contains the actual data (baseUrl, body)
   * - mappings: defines actions with JQ expressions referencing .payload
   */
  private createCloudflareNsResource(
    index: number,
    httpProviderConfigName: string,
  ): object {
    // HTTP provider v1.0.3+ Request manifest using v1alpha2 API
    // payload contains the actual data, mappings use JQ to reference it
    const httpRequestBase = {
      apiVersion: 'http.crossplane.io/v1alpha2',
      kind: 'Request',
      spec: {
        forProvider: {
          // payload contains the actual request data
          payload: {
            baseUrl: 'https://api.cloudflare.com/client/v4/zones/ZONE_ID/dns_records',
            body: '{}',
          },
          // mappings define how to CREATE/OBSERVE/REMOVE using JQ expressions
          mappings: [
            {
              action: 'CREATE',
              url: '.payload.baseUrl',
              body: '.payload.body',
            },
            {
              action: 'OBSERVE',
              method: 'GET',
              // After creation, we'd need the record ID - for now just observe via POST url
              url: '.payload.baseUrl',
            },
            {
              action: 'REMOVE',
              method: 'DELETE',
              url: '.payload.baseUrl',
            },
          ],
        },
        providerConfigRef: {
          name: httpProviderConfigName,
        },
      },
    };

    return {
      name: `cloudflare-ns-${index}`,
      base: httpRequestBase,
      patches: [
        // Patch metadata name
        {
          type: 'FromCompositeFieldPath',
          fromFieldPath: 'metadata.name',
          toFieldPath: 'metadata.name',
          transforms: [{
            type: 'string',
            string: { type: 'Format', fmt: `%s-cf-ns-${index}` },
          }],
        },
        // Patch baseUrl with Cloudflare zone ID
        {
          type: 'FromCompositeFieldPath',
          fromFieldPath: 'spec.cloudflareZoneId',
          toFieldPath: 'spec.forProvider.payload.baseUrl',
          transforms: [{
            type: 'string',
            string: { type: 'Format', fmt: 'https://api.cloudflare.com/client/v4/zones/%s/dns_records' },
          }],
        },
        // Combine DNS name and nameserver into JSON body in payload
        // TTL is a string in the XRD to avoid fmt conversion issues
        {
          type: 'CombineFromComposite',
          combine: {
            variables: [
              { fromFieldPath: 'spec.dnsName' },
              { fromFieldPath: `status.nameServers[${index}]` },
              { fromFieldPath: 'spec.ttl' },
            ],
            strategy: 'string',
            string: { fmt: '{"type":"NS","name":"%s","content":"%s","ttl":%s}' },
          },
          toFieldPath: 'spec.forProvider.payload.body',
          policy: { fromFieldPath: 'Required' },
        },
      ],
    };
  }
}

/**
 * Configuration for a DNS zone with Cloudflare delegation (Composite Resource)
 */
export interface DnsZoneCloudflareConfig {
  /** DNS name for the zone (e.g., sub.example.com) */
  dnsName: string;
  /** GCP project ID */
  project: string;
  /** Cloudflare zone ID where NS records will be created */
  cloudflareZoneId: string;
  /** Description for the DNS zone */
  description?: string;
  /** TTL for NS records (default: "3600") */
  ttl?: string;
}

/**
 * Creates an XR (Composite Resource) for a DNS zone with automatic Cloudflare delegation.
 * 
 * In Crossplane v2, Claims are deprecated. This creates the XR directly (cluster-scoped).
 * 
 * Prerequisites: DnsCloudflareComposition must be deployed first.
 */
export class DnsZoneCloudflare extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: DnsZoneCloudflareConfig) {
    super(scope, id);

    // Create the XR (Composite Resource) directly - Crossplane v2 approach
    // XRs are cluster-scoped (no namespace)
    this.xr = new ApiObject(this, 'xr', {
      apiVersion: 'nebula.io/v1alpha1',
      kind: 'XDnsZoneCloudflare',
      metadata: {
        name: id,
        // No namespace - XRs are cluster-scoped in Crossplane v2
      },
      spec: {
        dnsName: config.dnsName,
        project: config.project,
        cloudflareZoneId: config.cloudflareZoneId,
        description: config.description ?? `DNS zone for ${config.dnsName}`,
        ttl: config.ttl ?? '3600',
      },
    });
  }
}
