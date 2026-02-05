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
 * - crossplane-contrib/provider-http v1.0.8+ must be installed
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
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";
import * as kplus from "cdk8s-plus-33";
import {
  CompositeResourceDefinitionV2,
  CompositeResourceDefinitionV2SpecScope,
  Composition,
  CompositionSpecMode,
} from "#imports/apiextensions.crossplane.io";
import {
  ManagedZone,
  ManagedZoneSpecDeletionPolicy,
} from "#imports/dns.gcp.upbound.io";
import { ServiceAccountIamMember } from "#imports/cloudplatform.gcp.upbound.io";
import {
  ProviderConfig as HttpProviderConfig,
  ProviderConfigSpecCredentialsSource as HttpCredentialsSource,
} from "#imports/http.crossplane.io";
import { BaseConstruct } from "../../../core";

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
 * - Crossplane's GSA must have roles/iam.serviceAccountAdmin (auto-granted by Gcp module)
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
  /**
   * Whether to create the Workload Identity IAM binding via Crossplane (default: true).
   *
   * Requires Crossplane's GSA to have roles/iam.serviceAccountAdmin.
   * This is automatically granted by the Gcp module's enableCrossplaneIamAdmin option.
   *
   * Set to false to skip creating the IAM binding (e.g., if managing it externally).
   */
  createIamBinding?: boolean;
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

  constructor(
    scope: Construct,
    id: string,
    config: DnsCloudflareCompositionConfig = {},
  ) {
    super(scope, id, config);

    // Use this.config for resolved secrets (ref+sops:// patterns are decrypted)
    const httpProviderConfigName =
      this.config.httpProviderConfigName ?? "cloudflare-http";
    const gcpProviderConfig = this.config.gcpProviderConfigName ?? "default";
    const cfSecretName = this.config.cloudflareSecretName ?? "cloudflare-api";
    const cfSecretNamespace =
      this.config.cloudflareSecretNamespace ?? "crossplane-system";

    // Create Cloudflare API secret if credentials are provided
    // The secret format is a JSON object with headers for the HTTP provider
    // ref+sops:// references are resolved by BaseConstruct
    if (this.config.cloudflareApiKey && this.config.cloudflareEmail) {
      // Create secret with individual keys for header injection
      // The provider-http uses {{ secret:namespace:key }} syntax to inject values
      this.secret = new kplus.Secret(this, "cloudflare-secret", {
        metadata: {
          name: cfSecretName,
          namespace: cfSecretNamespace,
        },
        stringData: {
          // Individual keys for secret injection in Request headers
          email: this.config.cloudflareEmail,
          api_key: this.config.cloudflareApiKey,
          // Also keep credentials JSON for ProviderConfig (backward compatibility)
          credentials: JSON.stringify({
            headers: {
              "X-Auth-Key": [this.config.cloudflareApiKey],
              "X-Auth-Email": [this.config.cloudflareEmail],
              "Content-Type": ["application/json"],
            },
          }),
        },
      });

      // Create HTTP ProviderConfig that references the credentials secret
      // This provides default credentials, but Request-level headers take precedence
      this.httpProviderConfig = new HttpProviderConfig(
        this,
        "http-provider-config",
        {
          metadata: {
            name: httpProviderConfigName,
          },
          spec: {
            credentials: {
              source: HttpCredentialsSource.SECRET,
              secretRef: {
                name: cfSecretName,
                namespace: cfSecretNamespace,
                key: "credentials",
              },
            },
          },
        },
      );
    }

    // Setup Workload Identity for Crossplane DNS provider (GKE only)
    // This allows the provider-gcp-dns pod to authenticate using the specified GSA
    if (this.config.workloadIdentity) {
      const wi = this.config.workloadIdentity;
      const providerNamespace = wi.providerNamespace ?? "crossplane-system";
      const providerNamePrefix = wi.providerNamePrefix ?? "provider-gcp";
      // Convention: KSA name matches DeploymentRuntimeConfig service account name
      const providerKsaName = `${providerNamePrefix}-dns`;
      // Convention: GSA follows project naming pattern
      const gcpServiceAccount =
        wi.gcpServiceAccount ??
        `crossplane-provider@${wi.project}.iam.gserviceaccount.com`;

      // Create IAM binding - enabled by default
      // Requires Crossplane GSA to have roles/iam.serviceAccountAdmin
      if (wi.createIamBinding !== false) {
        new ServiceAccountIamMember(this, "dns-provider-wi", {
          metadata: {
            name: "crossplane-dns-provider-wi",
          },
          spec: {
            forProvider: {
              serviceAccountId: `projects/${wi.project}/serviceAccounts/${gcpServiceAccount}`,
              role: "roles/iam.workloadIdentityUser",
              member: `serviceAccount:${wi.project}.svc.id.goog[${providerNamespace}/${providerKsaName}]`,
            },
            providerConfigRef: {
              name: gcpProviderConfig,
            },
          },
        });
      }

      // Annotate the Crossplane DNS provider's KSA to use Workload Identity
      new kplus.k8s.KubeServiceAccount(this, "dns-provider-ksa", {
        metadata: {
          name: providerKsaName,
          namespace: providerNamespace,
          annotations: {
            "iam.gke.io/gcp-service-account": gcpServiceAccount,
          },
        },
      });
    }

    // Create the XRD (CompositeResourceDefinition) using v2 API
    // Note: In Crossplane v2, claimNames is deprecated - use XR directly
    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xdnszonecloudflares.nebula.io",
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XDnsZoneCloudflare",
          plural: "xdnszonecloudflares",
        },
        // XRs that compose cluster-scoped resources (like ManagedZone) must be cluster-scoped
        scope: CompositeResourceDefinitionV2SpecScope.CLUSTER,
        versions: [
          {
            name: "v1alpha1",
            served: true,
            referenceable: true,
            schema: {
              openApiv3Schema: {
                type: "object",
                properties: {
                  spec: {
                    type: "object",
                    required: ["dnsName", "project", "cloudflareZoneId"],
                    properties: {
                      dnsName: {
                        type: "string",
                        description:
                          "DNS name for the zone (e.g., sub.example.com)",
                      },
                      project: {
                        type: "string",
                        description: "GCP project ID",
                      },
                      cloudflareZoneId: {
                        type: "string",
                        description:
                          "Cloudflare zone ID where NS records will be created",
                      },
                      description: {
                        type: "string",
                        description: "Description for the DNS zone",
                      },
                      ttl: {
                        type: "string",
                        description: 'TTL for NS records (default: "3600")',
                        default: "3600",
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      nameServers: {
                        type: "array",
                        items: { type: "string" },
                        description: "Nameservers assigned by GCP",
                      },
                      zoneName: {
                        type: "string",
                        description: "Name of the created ManagedZone",
                      },
                    },
                  },
                },
              },
            },
          },
        ],
      },
    });

    // Create the Composition using Pipeline mode with function-patch-and-transform
    // This is the modern Crossplane v2 approach (Resources mode is deprecated)
    this.composition = new Composition(this, "composition", {
      metadata: {
        name: "dnszone-cloudflare",
        labels: {
          "crossplane.io/xrd": "xdnszonecloudflares.nebula.io",
          "delegation-provider": "cloudflare",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XDnsZoneCloudflare",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          {
            step: "patch-and-transform",
            functionRef: {
              name: "crossplane-contrib-function-patch-and-transform",
            },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [
                // Resource 0: GCP ManagedZone
                this.createManagedZoneResource(gcpProviderConfig),
                // Resources 1-4: HTTP Requests for Cloudflare NS records
                this.createCloudflareNsResource(
                  0,
                  httpProviderConfigName,
                  cfSecretName,
                  cfSecretNamespace,
                ),
                this.createCloudflareNsResource(
                  1,
                  httpProviderConfigName,
                  cfSecretName,
                  cfSecretNamespace,
                ),
                this.createCloudflareNsResource(
                  2,
                  httpProviderConfigName,
                  cfSecretName,
                  cfSecretNamespace,
                ),
                this.createCloudflareNsResource(
                  3,
                  httpProviderConfigName,
                  cfSecretName,
                  cfSecretNamespace,
                ),
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
      name: "gcp-managed-zone",
      base: ManagedZone.manifest({
        spec: {
          forProvider: {
            description: "Managed by Crossplane/Nebula",
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
          type: "FromCompositeFieldPath",
          fromFieldPath: "metadata.name",
          toFieldPath: "metadata.name",
        },
        // Patch DNS name (add trailing dot)
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.dnsName",
          toFieldPath: "spec.forProvider.dnsName",
          transforms: [
            {
              type: "string",
              string: { type: "Format", fmt: "%s." },
            },
          ],
        },
        // Patch project
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.project",
          toFieldPath: "spec.forProvider.project",
        },
        // Patch description (optional)
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.description",
          toFieldPath: "spec.forProvider.description",
        },
        // Export nameservers to XR status
        {
          type: "ToCompositeFieldPath",
          fromFieldPath: "status.atProvider.nameServers",
          toFieldPath: "status.nameServers",
        },
        // Export zone name to XR status
        {
          type: "ToCompositeFieldPath",
          fromFieldPath: "metadata.name",
          toFieldPath: "status.zoneName",
        },
      ],
    };
  }

  /**
   * Creates a Cloudflare NS record resource for the function-patch-and-transform input.
   * Uses provider-http v1.0.8+ to make direct API calls to Cloudflare.
   *
   * Authentication uses secret injection syntax {{ name:namespace:key }} in headers.
   * The provider-http controller resolves these at runtime by reading the secret.
   * Headers are set both globally AND per-mapping to ensure all actions are authenticated.
   *
   * Note: provider-http v1.0.8+ v1alpha2 API uses:
   * - headers: global headers with optional secret injection
   * - payload: contains baseUrl and body (schema is fixed, no custom fields)
   * - mappings: defines actions (CREATE, OBSERVE, UPDATE, REMOVE) with JQ expressions
   *   - Each mapping can have its own headers that override/extend global headers
   *
   * OBSERVE Strategy:
   * - Use Cloudflare's filter API to query by name, type, and content
   * - Parse name/content from payload.body using JQ's fromjson
   * - This handles the case where CREATE fails with "record already exists"
   * - Query URL: baseUrl?name={name}&type=NS&content={content}
   * - Response is an array: { result: [{id, ...}] }, use result[0].id
   *
   * REMOVE Strategy:
   * - After successful OBSERVE, use result[0].id from the response
   */
  private createCloudflareNsResource(
    index: number,
    httpProviderConfigName: string,
    cfSecretName: string = "cloudflare-api",
    cfSecretNamespace: string = "crossplane-system",
  ): object {
    // Cloudflare authentication headers using secret injection
    // The provider-http controller resolves {{ name:namespace:key }} at runtime
    const cfAuthHeaders = {
      "Content-Type": ["application/json"],
      "X-Auth-Email": [`{{ ${cfSecretName}:${cfSecretNamespace}:email }}`],
      "X-Auth-Key": [`{{ ${cfSecretName}:${cfSecretNamespace}:api_key }}`],
    };

    // HTTP provider v1.0.8+ Request manifest using v1alpha2 API
    const httpRequestBase = {
      apiVersion: "http.crossplane.io/v1alpha2",
      kind: "Request",
      spec: {
        forProvider: {
          // Global headers - provider-http resolves secret injection at runtime
          headers: cfAuthHeaders,
          // payload contains only baseUrl and body (schema is fixed)
          // We use JQ's fromjson in mappings to parse name/content from body
          payload: {
            baseUrl:
              "https://api.cloudflare.com/client/v4/zones/ZONE_ID/dns_records",
            body: "{}",
          },
          // mappings define how to CREATE/OBSERVE/REMOVE using JQ expressions
          // Each mapping has explicit headers to ensure authentication works for all actions
          mappings: [
            {
              action: "CREATE",
              method: "POST",
              url: ".payload.baseUrl",
              body: ".payload.body",
              // Explicit headers for CREATE
              headers: cfAuthHeaders,
            },
            {
              action: "OBSERVE",
              method: "GET",
              // Query Cloudflare API by name, type, and content to find existing records
              // Access name and content directly from payload.body (already an object internally)
              // This handles the "record already exists" case where CREATE failed
              // Response: { result: [{ id: "...", ... }] } (array)
              url: '.payload.baseUrl + "?name=" + .payload.body.name + "&type=NS&content=" + .payload.body.content',
              // Explicit headers for OBSERVE
              headers: cfAuthHeaders,
            },
            {
              action: "REMOVE",
              method: "DELETE",
              // Use record ID from OBSERVE response (result is an array from the query)
              url: '.payload.baseUrl + "/" + .response.body.result[0].id',
              // Explicit headers for REMOVE
              headers: cfAuthHeaders,
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
          type: "FromCompositeFieldPath",
          fromFieldPath: "metadata.name",
          toFieldPath: "metadata.name",
          transforms: [
            {
              type: "string",
              string: { type: "Format", fmt: `%s-cf-ns-${index}` },
            },
          ],
        },
        // Patch baseUrl with Cloudflare zone ID
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.cloudflareZoneId",
          toFieldPath: "spec.forProvider.payload.baseUrl",
          transforms: [
            {
              type: "string",
              string: {
                type: "Format",
                fmt: "https://api.cloudflare.com/client/v4/zones/%s/dns_records",
              },
            },
          ],
        },
        // Combine DNS name and nameserver into JSON body in payload
        // TTL is a string in the XRD to avoid fmt conversion issues
        {
          type: "CombineFromComposite",
          combine: {
            variables: [
              { fromFieldPath: "spec.dnsName" },
              { fromFieldPath: `status.nameServers[${index}]` },
              { fromFieldPath: "spec.ttl" },
            ],
            strategy: "string",
            string: {
              fmt: '{"type":"NS","name":"%s","content":"%s","ttl":%s}',
            },
          },
          toFieldPath: "spec.forProvider.payload.body",
          policy: { fromFieldPath: "Required" },
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
    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XDnsZoneCloudflare",
      metadata: {
        name: id,
        // No namespace - XRs are cluster-scoped in Crossplane v2
      },
      spec: {
        dnsName: config.dnsName,
        project: config.project,
        cloudflareZoneId: config.cloudflareZoneId,
        description: config.description ?? `DNS zone for ${config.dnsName}`,
        ttl: config.ttl ?? "3600",
      },
    });
  }
}
