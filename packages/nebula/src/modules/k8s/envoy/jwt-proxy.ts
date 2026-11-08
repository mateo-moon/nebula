import { isIP } from "node:net";
import { type OidcIssuer, validateOidcIssuer, oidcTokenLifetimeSeconds } from "../../../utils/oidc";

const typed = (name: string) => `type.googleapis.com/envoy.extensions.${name}`;
const endpoint = (host: string, port: number) => ({ address: { socket_address: { address: host, port_value: port } } });
const caPath = "/etc/ssl/certs/ca-certificates.crt";

function tls(serverName: string, ca: object) {
  return {
    name: "envoy.transport_sockets.tls", typed_config: {
      "@type": typed("transport_sockets.tls.v3.UpstreamTlsContext"), sni: serverName,
      common_tls_context: {
        validation_context: {
          trusted_ca: ca,
          match_typed_subject_alt_names: [{ san_type: isIP(serverName) ? "IP_ADDRESS" : "DNS", matcher: { exact: serverName } }]
        }
      },
    }
  };
}

/** The gateway never receives a privileged backend credential. It forwards the
 * verified bearer token so Kubernetes RBAC and audit retain the caller identity. */
export interface EnvoyJwtProxyConfig {
  issuers: Readonly<Record<string, OidcIssuer>>;
  backend: { host: string; port: number; serverName: string; caFile: string };
  maxTokenLifetimeSeconds: number;
}

/** TLS-verifying HTTP JWT proxy. It forwards the original bearer identity and
 * strips caller-supplied impersonation headers; no backend credential is used. */
export class EnvoyJwtProxy {
  public readonly bootstrap: Record<string, any>;
  constructor(config: EnvoyJwtProxyConfig) {
    const c = config;
    if (!Number.isInteger(c.maxTokenLifetimeSeconds) || c.maxTokenLifetimeSeconds < 1) throw new Error("A positive JWT lifetime is required");
    for (const issuer of Object.values(c.issuers)) { validateOidcIssuer(issuer); oidcTokenLifetimeSeconds(issuer, c.maxTokenLifetimeSeconds); }
    if (!Object.keys(c.issuers).length) throw new Error("At least one JWT issuer is required");
    const issuers = Object.entries(c.issuers);
    const providers = Object.fromEntries(issuers.map(([name, i]) => [name, {
      issuer: i.url, audiences: [i.audience], forward: true, require_expiration: true,
      max_lifetime: `${oidcTokenLifetimeSeconds(i, c.maxTokenLifetimeSeconds)}s`,
      from_headers: [{ name: "Authorization", value_prefix: "Bearer " }],
      remote_jwks: { http_uri: { uri: i.jwksUrl, cluster: `jwks-${name}`, timeout: "5s" }, cache_duration: "60s" },
    }]));
    this.bootstrap = {
      static_resources: {
        listeners: [{
          name: "oidc-api", address: { socket_address: { address: "0.0.0.0", port_value: 8080 } },
          filter_chains: [{
            filters: [{
              name: "envoy.filters.network.http_connection_manager", typed_config: {
                "@type": typed("filters.network.http_connection_manager.v3.HttpConnectionManager"), stat_prefix: "kubernetes_oidc",
                stream_idle_timeout: "300s", request_timeout: "0s",
                upgrade_configs: [{ upgrade_type: "websocket" }, { upgrade_type: "SPDY/3.1" }],
                // Never log headers, URLs/query strings or JWTs.
                access_log: [{
                  name: "envoy.access_loggers.stdout", typed_config: {
                    "@type": typed("access_loggers.stream.v3.StdoutAccessLog"),
                    log_format: { json_format: { time: "%START_TIME%", status: "%RESPONSE_CODE%", flags: "%RESPONSE_FLAGS%" } },
                  }
                }],
                route_config: {
                  name: "api", virtual_hosts: [{
                    name: "api", domains: ["*"], routes: [
                      {
                        match: { prefix: "/" }, route: {
                          cluster: "kubernetes", timeout: "0s",
                          max_stream_duration: { max_stream_duration: `${c.maxTokenLifetimeSeconds}s` }
                        }
                      },
                    ]
                  }]
                },
                http_filters: [
                  {
                    name: "envoy.filters.http.jwt_authn", typed_config: {
                      "@type": typed("filters.http.jwt_authn.v3.JwtAuthentication"), providers,
                      rules: [{
                        match: { prefix: "/" }, requires: issuers.length === 1 ? { provider_name: issuers[0]![0] } : {
                          requires_any: { requirements: issuers.map(([provider_name]) => ({ provider_name })) },
                        }
                      }],
                    }
                  },
                  {
                    name: "envoy.filters.http.lua", typed_config: {
                      "@type": typed("filters.http.lua.v3.Lua"), default_source_code: {
                        inline_string: `
function envoy_on_request(handle)
  local remove = {}
  for key, _ in pairs(handle:headers()) do
    if string.find(key, "^impersonate%-") or string.find(key, "^x%-remote%-") or key == "x-forwarded-client-cert" then
      table.insert(remove, key)
    end
  end
  for _, key in ipairs(remove) do handle:headers():remove(key) end
end
` },
                    }
                  },
                  { name: "envoy.filters.http.router", typed_config: { "@type": typed("filters.http.router.v3.Router") } },
                ],
              }
            }]
          }],
        }],
        clusters: [
          {
            name: "kubernetes", type: "STRICT_DNS", connect_timeout: "5s",
            load_assignment: { cluster_name: "kubernetes", endpoints: [{ lb_endpoints: [{ endpoint: endpoint(c.backend.host, c.backend.port) }] }] },
            transport_socket: tls(c.backend.serverName, { filename: c.backend.caFile }),
          },
          ...issuers.map(([name, i]) => {
            const u = new URL(i.jwksUrl);
            return {
              name: `jwks-${name}`, type: "LOGICAL_DNS", connect_timeout: "5s",
              dns_lookup_family: "ALL",
              load_assignment: { cluster_name: `jwks-${name}`, endpoints: [{ lb_endpoints: [{ endpoint: endpoint(u.hostname, Number(u.port || 443)) }] }] },
              transport_socket: tls(u.hostname, i.certificateAuthority ? { inline_string: i.certificateAuthority } : { filename: caPath }),
            };
          }),
        ],
      },
    };
  }
}
