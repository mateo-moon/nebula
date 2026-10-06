import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvoyTcpProxy, type EnvoyTcpProxyConfig } from "../src/modules/k8s/envoy";

const config = (): EnvoyTcpProxyConfig => ({
  image: `docker.io/envoyproxy/envoy@sha256:${"a".repeat(64)}`,
  tls: { certificateChain: "/sealed/tls/cert.pem", privateKey: "/sealed/tls/key.pem", trustedCa: "/sealed/tls/ca.pem" },
  routes: [
    { name: "api", direction: "inbound", listenPort: 15445, upstream: { host: "127.0.0.1", port: 8545 }, peerIdentity: "spiffe://example.test/pair-1/client" },
    { name: "peer", direction: "outbound", listenPort: 19060, upstream: { host: "peer.example.test", port: 19443 }, peerIdentity: "spiffe://example.test/pair-1/server" },
  ],
});

test("inbound requires TLS 1.3, a client certificate and the exact peer SAN", () => {
  const { bootstrap, container } = new EnvoyTcpProxy(config());
  const resources: any = bootstrap.static_resources;
  const tls = resources.listeners[0].filter_chains[0].transport_socket.typed_config;
  assert.equal(tls.require_client_certificate, true);
  assert.equal(tls.common_tls_context.tls_params.tls_minimum_protocol_version, "TLSv1_3");
  assert.deepEqual(tls.common_tls_context.validation_context.match_typed_subject_alt_names,
    [{ san_type: "URI", matcher: { exact: "spiffe://example.test/pair-1/client" } }]);
  assert.equal(resources.clusters[0].transport_socket, undefined);
  assert.equal(resources.clusters[0].load_assignment.endpoints[0].lb_endpoints[0].endpoint.address.socket_address.address, "127.0.0.1");
  assert.deepEqual(container.ports?.map(port => port.containerPort), [15445]);
  assert.equal(bootstrap.admin, undefined);
  assert.equal(container.securityContext?.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext?.readOnlyRootFilesystem, true);
  assert.equal(container.securityContext?.runAsNonRoot, true);
});

test("outbound plaintext listener stays local and verifies the server identity", () => {
  const { bootstrap, container } = new EnvoyTcpProxy(config());
  const resources: any = bootstrap.static_resources;
  assert.equal(resources.listeners[1].address.socket_address.address, "127.0.0.1");
  assert.equal(resources.listeners[1].filter_chains[0].transport_socket, undefined);
  assert.equal(resources.clusters[1].transport_socket.typed_config.common_tls_context.validation_context
    .match_typed_subject_alt_names[0].matcher.exact, "spiffe://example.test/pair-1/server");
  assert.deepEqual(JSON.parse(container.args![1]), bootstrap);
});

test("unsafe or ambiguous routes and credentials fail before rendering", () => {
  const reject = (change: (c: EnvoyTcpProxyConfig) => void) => {
    const c = config(); change(c); assert.throws(() => new EnvoyTcpProxy(c));
  };
  reject(c => { c.image = "envoyproxy/envoy:latest"; });
  reject(c => { c.tls.privateKey = "relative/key.pem"; });
  reject(c => { c.tls.privateKey = "/sealed/../host/key.pem"; });
  reject(c => { c.tls.privateKey = undefined as any; });
  reject(c => { c.routes[0].upstream.host = "other-pod.example.test"; });
  reject(c => { c.routes[0].peerIdentity = "spiffe://example.test/*"; });
  reject(c => { c.routes[0].listenPort = 0; });
  reject(c => { c.routes[1].listenPort = c.routes[0].listenPort; });
  reject(c => { c.routes[1].name = c.routes[0].name; });
  reject(c => { c.routes = []; });
});
