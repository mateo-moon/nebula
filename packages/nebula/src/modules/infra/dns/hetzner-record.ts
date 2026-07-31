/**
 * A single static rrset in a Hetzner Cloud DNS zone, managed via
 * crossplane-contrib/provider-http — the record-only sibling of the NS
 * delegation in `hetzner-composition.ts` (same rrset API, same auth).
 *
 * Emits one provider-http `Request` MR directly: unlike the delegation there
 * is nothing to observe or derive (the values are static), so an
 * XRD/Composition would be pure ceremony. Use for names that must live in the
 * Hetzner parent zone itself — e.g. a zone-apex-avoiding CNAME: a hostname
 * delegated into its own child zone becomes that zone's apex, where a CNAME
 * is illegal; as a plain record in the parent, the CNAME is fine.
 *
 * Prerequisites: the HTTP ProviderConfig + token Secret from
 * `DnsHetznerComposition` (or equivalents named via config).
 */
import { Construct } from "constructs";
import { ApiObject } from "cdk8s";

/** rrset types whose values are DNS names (BIND semantics: a value without a
 * trailing dot gets the parent zone silently appended — a footgun, so the
 * construct appends the dot itself). */
const NAME_VALUED_TYPES = new Set(["CNAME", "NS", "PTR"]);

export interface HetznerDnsRecordConfig {
  /** Hetzner Cloud zone id the rrset lives in (e.g. '1030670'). */
  hetznerZoneId: string;
  /** Relative rrset label within the zone (e.g. 'relay-hoodi'). */
  name: string;
  /** rrset type: 'CNAME', 'A', 'AAAA', 'TXT', ... */
  type: string;
  /** Record values. For name-valued types (CNAME/NS/PTR) a trailing dot is
   * appended when missing. */
  values: string[];
  /** TTL in seconds (default 300). */
  ttl?: number;
  /** HTTP ProviderConfig name (default 'hetzner-http'). */
  httpProviderConfigName?: string;
  /** Secret holding the hcloud token (default 'hetzner-token'). */
  secretName?: string;
  /** Namespace of the token Secret (default 'crossplane-system'). */
  secretNamespace?: string;
}

export class HetznerDnsRecord extends Construct {
  public readonly request: ApiObject;

  constructor(scope: Construct, id: string, config: HetznerDnsRecordConfig) {
    super(scope, id);

    const type = config.type.toUpperCase();
    const values = NAME_VALUED_TYPES.has(type)
      ? config.values.map((v) => (v.endsWith(".") ? v : `${v}.`))
      : config.values;

    const secretName = config.secretName ?? "hetzner-token";
    const secretNamespace = config.secretNamespace ?? "crossplane-system";
    const headers = {
      "Content-Type": ["application/json"],
      Accept: ["application/json"],
      Authorization: [`Bearer {{ ${secretName}:${secretNamespace}:token }}`],
    };

    this.request = new ApiObject(this, "request", {
      apiVersion: "http.crossplane.io/v1alpha2",
      kind: "Request",
      metadata: { name: id },
      spec: {
        forProvider: {
          headers,
          // body is a JSON STRING; provider-http parses it so the JQ mapping
          // urls can read .payload.body.name / .payload.body.type.
          payload: {
            baseUrl: `https://api.hetzner.cloud/v1/zones/${config.hetznerZoneId}/rrsets`,
            body: JSON.stringify({
              name: config.name,
              type,
              ttl: config.ttl ?? 300,
              records: values.map((value) => ({ value })),
            }),
          },
          mappings: [
            {
              action: "CREATE",
              method: "POST",
              url: ".payload.baseUrl",
              body: ".payload.body",
              headers,
            },
            {
              // OBSERVE: GET the rrset by {name}/{type}. 404 => CREATE.
              action: "OBSERVE",
              method: "GET",
              url: '.payload.baseUrl + "/" + .payload.body.name + "/" + .payload.body.type',
              headers,
            },
            {
              // UPDATE: overwrite all values via set_records (PUT only
              // updates labels; change_records does not exist).
              action: "UPDATE",
              method: "POST",
              url: '.payload.baseUrl + "/" + .payload.body.name + "/" + .payload.body.type + "/actions/set_records"',
              body: "{ records: .payload.body.records }",
              headers,
            },
            {
              action: "REMOVE",
              method: "DELETE",
              url: '.payload.baseUrl + "/" + .payload.body.name + "/" + .payload.body.type',
              headers,
            },
          ],
          // Up-to-date when observed record VALUES equal desired (Hetzner
          // nests under .rrset; records carry an extra comment field).
          expectedResponseCheck: {
            type: "CUSTOM",
            logic:
              "(.response.body.rrset.records | map(.value) | sort) == (.payload.body.records | map(.value) | sort)",
          },
          isRemovedCheck: {
            type: "CUSTOM",
            logic: ".response.statusCode == 404",
          },
        },
        providerConfigRef: { name: config.httpProviderConfigName ?? "hetzner-http" },
      },
    });
  }
}
