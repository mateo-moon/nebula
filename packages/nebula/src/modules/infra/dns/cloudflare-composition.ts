/**
 * Cloudflare DNS Delegation via Crossplane Composition
 * 
 * This module creates:
 * 1. A CompositeResourceDefinition (XRD) for DnsZoneCloudflare
 * 2. A Composition that creates GCP ManagedZone and delegates to Cloudflare via HTTP provider
 * 
 * The HTTP provider is used instead of a Cloudflare-specific provider because:
 * - Existing Cloudflare Crossplane providers are outdated
 * - HTTP provider gives direct control over API calls
 * - Easier to maintain and update
 * 
 * Prerequisites:
 * - crossplane-contrib/provider-http must be installed
 * - Cloudflare API token must be stored in a Secret
 * 
 * @example
 * ```typescript
 * // First, deploy the XRD and Composition (one-time setup)
 * new DnsCloudflareComposition(chart, 'dns-cloudflare-setup', {
 *   httpProviderConfigName: 'http-provider',
 *   gcpProviderConfigName: 'gcp-provider',
 *   cloudflareSecretName: 'cloudflare-api',
 *   cloudflareSecretNamespace: 'crossplane-system',
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
import {
  CompositeResourceDefinition,
  Composition,
  CompositionSpecMode,
} from '#imports/apiextensions.crossplane.io';
import {
  ManagedZone,
  ManagedZoneSpecDeletionPolicy,
} from '#imports/dns.gcp.upbound.io';
import { BaseConstruct } from '../../../core';

export interface DnsCloudflareCompositionConfig {
  /** Name of the HTTP ProviderConfig to use for Cloudflare API calls */
  httpProviderConfigName?: string;
  /** Name of the GCP ProviderConfig to use for ManagedZone */
  gcpProviderConfigName?: string;
  /** Name of the Secret containing Cloudflare API token */
  cloudflareSecretName?: string;
  /** Namespace of the Cloudflare secret */
  cloudflareSecretNamespace?: string;
  /** Key in the secret containing the API token (default: 'token') */
  cloudflareSecretKey?: string;
}

/**
 * Creates the XRD and Composition for Cloudflare DNS delegation.
 * 
 * This should be deployed once to set up the infrastructure for creating
 * DNS zones with automatic Cloudflare delegation.
 */
export class DnsCloudflareComposition extends BaseConstruct<DnsCloudflareCompositionConfig> {
  public readonly xrd: CompositeResourceDefinition;
  public readonly composition: Composition;

  constructor(scope: Construct, id: string, config: DnsCloudflareCompositionConfig = {}) {
    super(scope, id, config);

    const httpProviderConfig = config.httpProviderConfigName ?? 'http-provider';
    const gcpProviderConfig = config.gcpProviderConfigName ?? 'default';
    const cfSecretName = config.cloudflareSecretName ?? 'cloudflare-api';
    const cfSecretNamespace = config.cloudflareSecretNamespace ?? 'crossplane-system';
    const cfSecretKey = config.cloudflareSecretKey ?? 'token';

    // Create the XRD (CompositeResourceDefinition)
    // Note: In Crossplane v2, claimNames is deprecated - use XR directly
    this.xrd = new CompositeResourceDefinition(this, 'xrd', {
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
                      type: 'integer',
                      description: 'TTL for NS records (default: 3600)',
                      default: 3600,
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
                this.createCloudflareNsResource(0, httpProviderConfig, cfSecretName, cfSecretNamespace, cfSecretKey),
                this.createCloudflareNsResource(1, httpProviderConfig, cfSecretName, cfSecretNamespace, cfSecretKey),
                this.createCloudflareNsResource(2, httpProviderConfig, cfSecretName, cfSecretNamespace, cfSecretKey),
                this.createCloudflareNsResource(3, httpProviderConfig, cfSecretName, cfSecretNamespace, cfSecretKey),
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
   * Uses provider-http to make direct API calls to Cloudflare.
   * 
   * Note: HTTP provider Request is defined inline as there are no typed imports.
   * The provider-http CRD would need to be added to cdk8s.yaml for typed support.
   */
  private createCloudflareNsResource(
    index: number,
    httpProviderConfig: string,
    secretName: string,
    secretNamespace: string,
    secretKey: string,
  ): object {
    // HTTP provider Request manifest (no typed import available)
    const httpRequestBase = {
      apiVersion: 'http.crossplane.io/v1alpha2',
      kind: 'Request',
      spec: {
        forProvider: {
          // URL will be patched with zone ID
          url: 'https://api.cloudflare.com/client/v4/zones/ZONE_ID/dns_records',
          method: 'POST',
          headers: {
            'Content-Type': ['application/json'],
          },
          secretInjectionConfigs: [{
            secretRef: {
              name: secretName,
              namespace: secretNamespace,
            },
            secretKey: secretKey,
            responsePath: 'request.headers.Authorization[0]',
            setValueAs: 'Bearer',
          }],
          // Body will be patched with combined values
          body: '{}',
        },
        providerConfigRef: {
          name: httpProviderConfig,
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
        // Patch URL with Cloudflare zone ID
        {
          type: 'FromCompositeFieldPath',
          fromFieldPath: 'spec.cloudflareZoneId',
          toFieldPath: 'spec.forProvider.url',
          transforms: [{
            type: 'string',
            string: { type: 'Format', fmt: 'https://api.cloudflare.com/client/v4/zones/%s/dns_records' },
          }],
        },
        // Combine DNS name and nameserver into JSON body
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
          toFieldPath: 'spec.forProvider.body',
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
  /** TTL for NS records (default: 3600) */
  ttl?: number;
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
        ttl: config.ttl ?? 3600,
      },
    });
  }
}
