/**
 * Hetzner DNS Delegation via Crossplane Composition
 *
 * Mirrors `cloudflare-composition.ts`, but:
 *  - the *child* zone is an AWS Route53 hosted zone (route53.aws.upbound.io
 *    `Zone`) instead of a GCP ManagedZone, and
 *  - the *parent* (where the NS delegation record lives) is a Hetzner zone, so
 *    the NS record is written through the **Hetzner Cloud DNS rrset API**
 *    (`https://api.hetzner.cloud/v1`) via crossplane-contrib/provider-http.
 *
 * This module creates:
 * 1. A CompositeResourceDefinition (XRD) for `XDnsZoneHetzner`.
 * 2. A Composition that
 *      (a) provisions/adopts the Route53 hosted zone and reads back its
 *          dynamically-assigned nameservers (`status.atProvider.nameServers`),
 *      (b) writes a single Hetzner **NS rrset** in the parent zone pointing at
 *          those nameservers, via provider-http (CREATE/OBSERVE/UPDATE/REMOVE).
 * 3. An HTTP ProviderConfig (`credentials.source: None`) for the Hetzner API.
 * 4. (optional) the `hetzner-token` Secret holding the hcloud API token.
 * 5. (optional) the provider-http `Provider` package install itself.
 *
 * Why provider-http (not a Hetzner-native provider): there is no maintained
 * Crossplane provider for Hetzner Cloud DNS; the HTTP provider gives direct,
 * declarative control of the rrset endpoints with the standard hcloud Bearer
 * auth.
 *
 * IMPORTANT — this targets the *new* DNS-in-Cloud rrset API
 * (`api.hetzner.cloud/v1/zones/{zoneId}/rrsets`), authenticated with
 * `Authorization: Bearer <hcloud-token>` — NOT the legacy standalone DNS API
 * (`dns.hetzner.com/api/v1`, `Auth-API-Token` header). One NS rrset holds ALL
 * nameservers in a single `records` array (do NOT create one rrset per NS).
 *
 * Nameserver sourcing (the reason this pattern is worth copying): the
 * Composition CREATES/ADOPTS the Route53 zone and reads its live nameservers,
 * so the delegation tracks AWS's dynamically-assigned NS set. Because the two
 * Nuconstruct zones already exist, the per-XR `adoptZoneId` sets the composed
 * zone's `crossplane.io/external-name` so upjet *observes/imports* the existing
 * hosted zone instead of creating a duplicate.
 *
 * Prerequisites:
 * - crossplane-contrib/provider-http v1.0.8+ installed (this class can emit it).
 * - function-patch-and-transform (already installed by the Crossplane module).
 * - An hcloud API token with DNS write scope (ref+sops:// supported).
 *
 * @example
 * ```typescript
 * // One-time setup: XRD + Composition + provider-http ProviderConfig + secret.
 * new DnsHetznerComposition(chart, 'dns-hetzner-setup', {
 *   httpProviderConfigName: 'hetzner-http',
 *   awsProviderConfigName: 'default',
 *   hetznerApiToken: 'ref+sops://.secrets/secrets.yaml#hetzner/api-token',
 * });
 *
 * // Per-zone: delegate stage.nuconstruct.xyz from the Hetzner parent zone 1030670,
 * // adopting the existing Route53 hosted zone Z020643437.
 * new DnsZoneHetzner(chart, 'stage-nuconstruct-xyz', {
 *   dnsName: 'stage.nuconstruct.xyz',
 *   hetznerZoneId: '1030670',
 *   adoptZoneId: 'Z020643437',
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
  Zone as CpRoute53Zone,
  ZoneSpecDeletionPolicy,
} from "#imports/route53.aws.upbound.io";
import {
  ProviderConfig as HttpProviderConfig,
  ProviderConfigSpecCredentialsSource as HttpCredentialsSource,
} from "#imports/http.crossplane.io";
import { Provider as CrossplaneProvider } from "#imports/pkg.crossplane.io";
import { BaseConstruct, syncWave } from "../../../core";

/** Default provider-http package version (latest GitHub release, pinned). */
const DEFAULT_PROVIDER_HTTP_VERSION = "v1.0.14";

export interface DnsHetznerCompositionConfig {
  /** Name of the HTTP ProviderConfig used for Hetzner API calls (default: 'hetzner-http'). */
  httpProviderConfigName?: string;
  /** Name of the AWS (provider-aws) ProviderConfig used for the Route53 Zone (default: 'default'). */
  awsProviderConfigName?: string;
  /** Name of the Secret holding the hcloud token (default: 'hetzner-token'). */
  hetznerSecretName?: string;
  /** Namespace of the hcloud token secret (default: 'crossplane-system'). */
  hetznerSecretNamespace?: string;
  /**
   * Hetzner Cloud API token (hcloud token). When provided, creates the
   * `hetzner-token` Secret and the HTTP ProviderConfig automatically.
   * The token is injected as `Authorization: Bearer {{ secret:ns:key }}` —
   * it never lands in the Request spec/status/logs.
   * Supports ref+sops:// references for vals integration.
   * @example 'ref+sops://.secrets/secrets.yaml#hetzner/api-token'
   */
  hetznerApiToken?: string;
  /**
   * Whether this class also installs the provider-http `Provider` package
   * (default: true). Set false if the package is installed elsewhere (e.g. the
   * Crossplane module). The package is emitted at syncWave(-20) so its CRDs land
   * before the XRD (-10)/Composition (-5).
   */
  installProvider?: boolean;
  /** provider-http package version to install (default: 'v1.0.14'). */
  providerHttpVersion?: string;
}

/**
 * Creates the XRD + Composition for Hetzner DNS delegation (one-time setup).
 */
export class DnsHetznerComposition extends BaseConstruct<DnsHetznerCompositionConfig> {
  public readonly xrd: CompositeResourceDefinitionV2;
  public readonly composition: Composition;
  public readonly secret?: kplus.Secret;
  public readonly httpProviderConfig?: HttpProviderConfig;
  public readonly provider?: CrossplaneProvider;

  constructor(
    scope: Construct,
    id: string,
    config: DnsHetznerCompositionConfig = {},
  ) {
    super(scope, id, config);

    // this.config has ref+sops:// references resolved by BaseConstruct.
    const httpProviderConfigName =
      this.config.httpProviderConfigName ?? "hetzner-http";
    const awsProviderConfig = this.config.awsProviderConfigName ?? "default";
    const secretName = this.config.hetznerSecretName ?? "hetzner-token";
    const secretNamespace =
      this.config.hetznerSecretNamespace ?? "crossplane-system";

    // 1) Install the provider-http package (before XRD/Composition).
    if (this.config.installProvider !== false) {
      this.provider = new CrossplaneProvider(this, "provider-http", {
        metadata: {
          name: "provider-http",
          annotations: syncWave(-20),
        },
        spec: {
          package: `xpkg.upbound.io/crossplane-contrib/provider-http:${
            this.config.providerHttpVersion ?? DEFAULT_PROVIDER_HTTP_VERSION
          }`,
        },
      });
    }

    // 2) hcloud token Secret + HTTP ProviderConfig (auth is per-Request via
    //    {{ secret:ns:key }} injection, so the ProviderConfig carries NO creds).
    if (this.config.hetznerApiToken) {
      this.secret = new kplus.Secret(this, "hetzner-secret", {
        metadata: {
          name: secretName,
          namespace: secretNamespace,
          annotations: syncWave(-15),
        },
        stringData: {
          // Single key `token`, injected as `Bearer {{ hetzner-token:crossplane-system:token }}`.
          token: this.config.hetznerApiToken,
        },
      });

      this.httpProviderConfig = new HttpProviderConfig(
        this,
        "http-provider-config",
        {
          metadata: {
            name: httpProviderConfigName,
            annotations: syncWave(-12),
          },
          spec: {
            // No global credentials: each Request injects the Bearer token itself.
            credentials: {
              source: HttpCredentialsSource.NONE,
            },
          },
        },
      );
    }

    // 3) XRD (Crossplane v2 — no claimNames; XR is used directly).
    this.xrd = new CompositeResourceDefinitionV2(this, "xrd", {
      metadata: {
        name: "xdnszonehetzners.nebula.io",
        annotations: syncWave(-10),
      },
      spec: {
        group: "nebula.io",
        names: {
          kind: "XDnsZoneHetzner",
          plural: "xdnszonehetzners",
        },
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
                    required: ["dnsName", "hetznerZoneId", "recordName"],
                    properties: {
                      dnsName: {
                        type: "string",
                        description:
                          "FQDN of the child zone, e.g. stage.nuconstruct.xyz. Becomes the Route53 hosted-zone name.",
                      },
                      hetznerZoneId: {
                        type: "string",
                        description:
                          "Hetzner Cloud parent zone id (numeric id or zone name) that holds the NS delegation, e.g. 1030670 (nuconstruct.xyz).",
                      },
                      recordName: {
                        type: "string",
                        description:
                          'Relative label of the NS rrset in the parent zone, e.g. "stage" for stage.nuconstruct.xyz. Use "@" for the apex.',
                      },
                      adoptZoneId: {
                        type: "string",
                        description:
                          "Existing Route53 hosted-zone id to adopt (sets crossplane.io/external-name). Omit to create a new hosted zone.",
                      },
                      description: {
                        type: "string",
                        description: "Comment for the Route53 hosted zone.",
                      },
                      ttl: {
                        type: "string",
                        description:
                          'TTL (seconds) for the NS rrset (default: "86400"). String to avoid fmt conversion issues.',
                        default: "86400",
                      },
                    },
                  },
                  status: {
                    type: "object",
                    properties: {
                      nameServers: {
                        type: "array",
                        items: { type: "string" },
                        description:
                          "Live Route53 nameservers delegated into Hetzner.",
                      },
                      zoneName: {
                        type: "string",
                        description: "Name of the composed Route53 Zone resource.",
                      },
                      route53ZoneId: {
                        type: "string",
                        description: "Observed Route53 hosted-zone id.",
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

    // 4) Composition (Pipeline mode + function-patch-and-transform).
    this.composition = new Composition(this, "composition", {
      metadata: {
        name: "dnszone-hetzner",
        annotations: syncWave(-5),
        labels: {
          "crossplane.io/xrd": "xdnszonehetzners.nebula.io",
          "delegation-provider": "hetzner",
        },
      },
      spec: {
        compositeTypeRef: {
          apiVersion: "nebula.io/v1alpha1",
          kind: "XDnsZoneHetzner",
        },
        mode: CompositionSpecMode.PIPELINE,
        pipeline: [
          // Step 1: provision/adopt the Route53 hosted zone, export nameservers.
          {
            step: "route53-zone",
            functionRef: { name: "function-patch-and-transform" },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [this.createRoute53ZoneResource(awsProviderConfig)],
            },
          },
          // Step 2: write the single Hetzner NS rrset (depends on status.nameServers).
          {
            step: "hetzner-ns-rrset",
            functionRef: { name: "function-patch-and-transform" },
            input: {
              apiVersion: "pt.fn.crossplane.io/v1beta1",
              kind: "Resources",
              resources: [
                this.createHetznerNsRrsetResource(
                  httpProviderConfigName,
                  secretName,
                  secretNamespace,
                ),
              ],
            },
          },
        ],
      },
    });
  }

  /**
   * Composed Route53 hosted zone. Mirrors the Cloudflare composition's
   * ManagedZone resource: the load-bearing patch exports
   * `status.atProvider.nameServers` -> `status.nameServers` for the delegation.
   *
   * Adoption: when `spec.adoptZoneId` is set it is patched onto the
   * `crossplane.io/external-name` annotation, so upjet observes/imports the
   * existing hosted zone instead of creating a new one (no Required policy =>
   * the patch is skipped when adoptZoneId is absent, i.e. create-new mode).
   *
   * Deletion policy is ORPHAN: these are shared, pre-existing zones that
   * external-dns and the cluster depend on — deleting the XR must never delete
   * the live AWS hosted zone.
   */
  private createRoute53ZoneResource(awsProviderConfig: string): object {
    return {
      name: "route53-zone",
      base: CpRoute53Zone.manifest({
        spec: {
          forProvider: {
            // name/comment are patched from the XR below.
            forceDestroy: false,
          },
          providerConfigRef: {
            name: awsProviderConfig,
          },
          deletionPolicy: ZoneSpecDeletionPolicy.ORPHAN,
        },
      }),
      patches: [
        // metadata.name = XR name.
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "metadata.name",
          toFieldPath: "metadata.name",
        },
        // Adopt an existing hosted zone by external-name (optional — skipped if unset).
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.adoptZoneId",
          toFieldPath: "metadata.annotations[crossplane.io/external-name]",
        },
        // Route53 zone name = the child FQDN (no trailing dot).
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.dnsName",
          toFieldPath: "spec.forProvider.name",
        },
        // Comment (optional).
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.description",
          toFieldPath: "spec.forProvider.comment",
        },
        // Export live nameservers to XR status (the delegation source).
        {
          type: "ToCompositeFieldPath",
          fromFieldPath: "status.atProvider.nameServers",
          toFieldPath: "status.nameServers",
        },
        // Export the observed hosted-zone id (informational).
        {
          type: "ToCompositeFieldPath",
          fromFieldPath: "status.atProvider.zoneId",
          toFieldPath: "status.route53ZoneId",
        },
        // Export the composed zone's resource name (informational).
        {
          type: "ToCompositeFieldPath",
          fromFieldPath: "metadata.name",
          toFieldPath: "status.zoneName",
        },
      ],
    };
  }

  /**
   * The single Hetzner NS rrset, managed via provider-http against the new
   * hcloud DNS rrset API. One rrset holds ALL nameservers (records array).
   *
   * Endpoints (baseUrl = https://api.hetzner.cloud/v1/zones/{zoneId}/rrsets):
   *  - CREATE  POST   {baseUrl}                              body: full rrset {name,type,ttl,records}
   *  - OBSERVE GET    {baseUrl}/{name}/NS                    404 => CREATE
   *  - UPDATE  POST   {baseUrl}/{name}/NS/actions/set_records body: {records:[...]} (overwrite-all)
   *  - REMOVE  DELETE {baseUrl}/{name}/NS
   *
   * Notes on the reconcile semantics (provider-http):
   *  - Existence: the OBSERVE GET returns 404 when the rrset is absent; a
   *    non-2xx first observation makes provider-http fire CREATE.
   *  - Up-to-date: the OBSERVE response nests the rrset under `.rrset`, so the
   *    DEFAULT (subset) comparison does not work — a CUSTOM expectedResponseCheck
   *    compares the observed record VALUES against the desired ones (sorted),
   *    firing UPDATE (set_records, the idempotent overwrite) on drift.
   *  - isRemovedCheck confirms deletion when the GET returns 404.
   *
   * Auth: `Authorization: Bearer {{ secret:ns:token }}` — resolved at runtime by
   * provider-http; the token never appears in spec/status/logs.
   *
   * Trailing dots: Route53 returns nameservers WITHOUT a trailing dot; Hetzner
   * uses BIND zonefile semantics, so each value gets a trailing "." appended to
   * be treated as an absolute FQDN (otherwise the parent zone is auto-appended).
   *
   * Route53 default delegation sets always return exactly 4 nameservers, so the
   * body combines 4 fixed positions (status.nameServers[0..3]).
   */
  private createHetznerNsRrsetResource(
    httpProviderConfigName: string,
    secretName: string,
    secretNamespace: string,
  ): object {
    // Hetzner auth + content headers. The Bearer token is injected from the Secret.
    const hetznerHeaders = {
      "Content-Type": ["application/json"],
      Accept: ["application/json"],
      Authorization: [`Bearer {{ ${secretName}:${secretNamespace}:token }}`],
    };

    const httpRequestBase = {
      apiVersion: "http.crossplane.io/v1alpha2",
      kind: "Request",
      spec: {
        forProvider: {
          headers: hetznerHeaders,
          // payload.body is a JSON STRING; provider-http parses it so JQ can read
          // .payload.body.name / .payload.body.records / .payload.body.ttl.
          // baseUrl + body are patched in from the XR (see patches).
          payload: {
            baseUrl: "https://api.hetzner.cloud/v1/zones/ZONE_ID/rrsets",
            body: "{}",
          },
          mappings: [
            {
              // CREATE: POST the full rrset object to the collection URL.
              action: "CREATE",
              method: "POST",
              url: ".payload.baseUrl",
              body: ".payload.body",
              headers: hetznerHeaders,
            },
            {
              // OBSERVE: GET the rrset by {name}/{type}. 404 => CREATE.
              action: "OBSERVE",
              method: "GET",
              url: '.payload.baseUrl + "/" + .payload.body.name + "/NS"',
              headers: hetznerHeaders,
            },
            {
              // UPDATE: overwrite all records via the set_records action.
              // change_records does NOT exist (404); PUT only updates labels.
              action: "UPDATE",
              method: "POST",
              url:
                '.payload.baseUrl + "/" + .payload.body.name + "/NS/actions/set_records"',
              body: "{ records: .payload.body.records }",
              headers: hetznerHeaders,
            },
            {
              // REMOVE: DELETE the rrset by {name}/{type}.
              action: "REMOVE",
              method: "DELETE",
              url: '.payload.baseUrl + "/" + .payload.body.name + "/NS"',
              headers: hetznerHeaders,
            },
          ],
          // Up-to-date when the observed record VALUES equal the desired ones.
          // (Hetzner nests the rrset under `.rrset`; records carry an extra
          // `comment` field, so compare by `.value` only, order-insensitive.)
          expectedResponseCheck: {
            type: "CUSTOM",
            logic:
              "(.response.body.rrset.records | map(.value) | sort) == (.payload.body.records | map(.value) | sort)",
          },
          // Deletion is confirmed once the GET returns 404.
          isRemovedCheck: {
            type: "CUSTOM",
            logic: ".response.statusCode == 404",
          },
        },
        providerConfigRef: {
          name: httpProviderConfigName,
        },
      },
    };

    return {
      name: "hetzner-ns-rrset",
      base: httpRequestBase,
      patches: [
        // metadata.name = "<xr>-hetzner-ns".
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "metadata.name",
          toFieldPath: "metadata.name",
          transforms: [
            {
              type: "string",
              string: { type: "Format", fmt: "%s-hetzner-ns" },
            },
          ],
        },
        // baseUrl gets the parent Hetzner zone id.
        {
          type: "FromCompositeFieldPath",
          fromFieldPath: "spec.hetznerZoneId",
          toFieldPath: "spec.forProvider.payload.baseUrl",
          policy: { fromFieldPath: "Required" },
          transforms: [
            {
              type: "string",
              string: {
                type: "Format",
                fmt: "https://api.hetzner.cloud/v1/zones/%s/rrsets",
              },
            },
          ],
        },
        // Build the rrset body from the label, ttl and the 4 live nameservers.
        // ttl is inserted raw (unquoted JSON number); each NS gets a trailing dot.
        // Required policy gates the whole Request on status.nameServers existing,
        // i.e. the Route53 zone must report its nameservers first.
        {
          type: "CombineFromComposite",
          combine: {
            variables: [
              { fromFieldPath: "spec.recordName" },
              { fromFieldPath: "spec.ttl" },
              { fromFieldPath: "status.nameServers[0]" },
              { fromFieldPath: "status.nameServers[1]" },
              { fromFieldPath: "status.nameServers[2]" },
              { fromFieldPath: "status.nameServers[3]" },
            ],
            strategy: "string",
            string: {
              fmt:
                '{"name":"%s","type":"NS","ttl":%s,"records":[{"value":"%s."},{"value":"%s."},{"value":"%s."},{"value":"%s."}]}',
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
 * Configuration for a DNS zone with Hetzner delegation (Composite Resource).
 */
export interface DnsZoneHetznerConfig {
  /** FQDN of the child zone, e.g. 'stage.nuconstruct.xyz'. */
  dnsName: string;
  /** Hetzner Cloud parent zone id (e.g. '1030670' for nuconstruct.xyz). */
  hetznerZoneId: string;
  /**
   * Relative label of the NS rrset in the parent zone (e.g. 'stage').
   * Defaults to the first label of `dnsName`.
   */
  recordName?: string;
  /** Existing Route53 hosted-zone id to adopt (e.g. 'Z020643437'). Omit to create new. */
  adoptZoneId?: string;
  /** Comment for the Route53 hosted zone. */
  description?: string;
  /** TTL (seconds) for the NS rrset (default: '86400'). */
  ttl?: string;
}

/**
 * An XR (Composite Resource) for a DNS zone delegated from Hetzner.
 *
 * Prerequisites: `DnsHetznerComposition` must be deployed first.
 */
export class DnsZoneHetzner extends Construct {
  public readonly xr: ApiObject;

  constructor(scope: Construct, id: string, config: DnsZoneHetznerConfig) {
    super(scope, id);

    const recordName = config.recordName ?? config.dnsName.split(".")[0];

    this.xr = new ApiObject(this, "xr", {
      apiVersion: "nebula.io/v1alpha1",
      kind: "XDnsZoneHetzner",
      metadata: {
        name: id,
        annotations: syncWave(0),
      },
      spec: {
        dnsName: config.dnsName,
        hetznerZoneId: config.hetznerZoneId,
        recordName,
        ...(config.adoptZoneId ? { adoptZoneId: config.adoptZoneId } : {}),
        description: config.description ?? `DNS zone for ${config.dnsName}`,
        ttl: config.ttl ?? "86400",
      },
    });
  }
}
