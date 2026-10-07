import type { Container } from "cdk8s-plus-33/lib/imports/k8s";
import { isDigestImage } from "../confidential-guests/types";

export interface EnvoyTlsFiles {
  certificateChain: string;
  privateKey: string;
  trustedCa: string;
  /** Pin the public CA bytes in a measured bootstrap instead of trusting a
   * mutable file's contents. The certificate and private key still use files. */
  trustedCaPem?: string;
}

export interface EnvoyTcpRoute {
  name: string;
  /** Inbound terminates mutual TLS at the Pod; outbound originates it. */
  direction: "inbound" | "outbound";
  listenPort: number;
  upstream: { host: string; port: number };
  /** Exact URI SAN of the only peer allowed on this route. */
  peerIdentity: string;
}

export interface EnvoyTcpProxyConfig {
  name?: string;
  image: string;
  tls: EnvoyTlsFiles;
  routes: readonly EnvoyTcpRoute[];
}

const port = (value: number) => Number.isInteger(value) && value > 0 && value <= 65535;
const name = (value: string) => /^[a-z][a-z0-9-]{0,62}$/.test(value);

/** A sidecar building block, usable in an ordinary Pod or a measured CoCo Pod.
 * The caller provisions certificate files and mounts. No private material is
 * embedded in the bootstrap, and the module does not expose an admin listener.
 */
export class EnvoyTcpProxy {
  public readonly bootstrap: Record<string, unknown>;
  public readonly container: Container;

  constructor(config: EnvoyTcpProxyConfig) {
    if (!isDigestImage(config.image)) throw new Error("Envoy image must be pinned by sha256 digest");
    if (!name(config.name ?? "envoy")) throw new Error("invalid Envoy container name");
    for (const file of [config.tls.certificateChain, config.tls.privateKey, config.tls.trustedCa]) {
      if (typeof file !== "string" || !/^\/[a-zA-Z0-9_./-]+$/.test(file) || file.split("/").includes("..")) {
        throw new Error("TLS files require absolute, normalized paths");
      }
    }
    if (!config.routes.length) throw new Error("Envoy requires at least one route");
    if (config.tls.trustedCaPem !== undefined && !/^-----BEGIN CERTIFICATE-----\n[\s\S]+\n-----END CERTIFICATE-----\s*$/.test(config.tls.trustedCaPem)) {
      throw new Error("trustedCaPem must contain a public PEM certificate");
    }
    const names = new Set<string>();
    const ports = new Set<number>();
    for (const route of config.routes) {
      if (!name(route.name) || names.has(route.name)) throw new Error("route names must be distinct DNS labels");
      if (!port(route.listenPort) || ports.has(route.listenPort) || !port(route.upstream.port)) {
        throw new Error("listener ports must be valid and distinct");
      }
      if (!["inbound", "outbound"].includes(route.direction)) throw new Error("invalid route direction");
      if (!/^[a-zA-Z0-9.:-]+$/.test(route.upstream.host)) throw new Error("invalid upstream host");
      if (route.direction === "inbound" && !["127.0.0.1", "::1", "localhost"].includes(route.upstream.host)) {
        throw new Error("inbound plaintext upstream must stay on loopback");
      }
      if (!/^spiffe:\/\/[a-z0-9.-]+\/[a-zA-Z0-9_./-]+$/.test(route.peerIdentity) ||
          route.peerIdentity.split("/").includes("..")) {
        throw new Error("peer identity requires an exact SPIFFE URI SAN");
      }
      names.add(route.name); ports.add(route.listenPort);
    }
    const address = (host: string, p: number) => ({ socket_address: { address: host, port_value: p } });
    const tlsContext = (peer: string) => ({
      tls_params: { tls_minimum_protocol_version: "TLSv1_3", tls_maximum_protocol_version: "TLSv1_3" },
      tls_certificates: [{ certificate_chain: { filename: config.tls.certificateChain },
        private_key: { filename: config.tls.privateKey } }],
      validation_context: { trusted_ca: config.tls.trustedCaPem ? { inline_string: config.tls.trustedCaPem } : { filename: config.tls.trustedCa },
        match_typed_subject_alt_names: [{ san_type: "URI", matcher: { exact: peer } }] },
    });
    const socket = (route: EnvoyTcpRoute) => ({ name: "envoy.transport_sockets.tls", typed_config: {
      "@type": `type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.${route.direction === "inbound" ? "DownstreamTlsContext" : "UpstreamTlsContext"}`,
      common_tls_context: tlsContext(route.peerIdentity),
      ...(route.direction === "inbound" ? { require_client_certificate: true } : {}),
    } });
    this.bootstrap = { static_resources: {
      listeners: config.routes.map(route => ({ name: route.name,
        address: address(route.direction === "inbound" ? "0.0.0.0" : "127.0.0.1", route.listenPort),
        filter_chains: [{ ...(route.direction === "inbound" ? { transport_socket: socket(route) } : {}),
          filters: [{ name: "envoy.filters.network.tcp_proxy", typed_config: {
            "@type": "type.googleapis.com/envoy.extensions.filters.network.tcp_proxy.v3.TcpProxy",
            stat_prefix: route.name, cluster: route.name,
          } }] }],
      })),
      clusters: config.routes.map(route => ({ name: route.name, type: "STRICT_DNS", connect_timeout: "5s",
        dns_lookup_family: "V4_ONLY",
        load_assignment: { cluster_name: route.name, endpoints: [{ lb_endpoints: [{ endpoint: {
          address: address(route.upstream.host, route.upstream.port),
        } }] }] },
        ...(route.direction === "outbound" ? { transport_socket: socket(route) } : {}),
      })),
    } };
    this.container = {
      name: config.name ?? "envoy", image: config.image, imagePullPolicy: "IfNotPresent",
      command: ["/usr/local/bin/envoy"],
      // Inline JSON is also YAML. In a CoCo guest these exact bytes are argv
      // in the measured policy, avoiding a mutable host-mounted ConfigMap.
      args: ["--config-yaml", JSON.stringify(this.bootstrap), "--disable-hot-restart", "--concurrency", "1", "--log-level", "warning"],
      securityContext: { runAsUser: 10001, runAsGroup: 10001, runAsNonRoot: true,
        allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
      ports: config.routes.filter(route => route.direction === "inbound")
        .map(route => ({ name: route.name, containerPort: route.listenPort, protocol: "TCP" })),
    };
  }
}
