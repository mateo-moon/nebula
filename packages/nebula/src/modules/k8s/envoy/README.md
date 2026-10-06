# Envoy TCP mutual TLS

`EnvoyTcpProxy` builds a sidecar container and inline bootstrap for a paired
TCP channel. Add its `container` to the application Pod, provide certificate
files at the configured paths, and expose only inbound TLS ports in a Service
and NetworkPolicy. Each route requires TLS 1.3 and an exact SPIFFE URI SAN.
The issuing CA must authorize each identity only to its intended workload.

Inbound routes terminate mutual TLS and connect to a loopback application
listener. Outbound routes accept plaintext only on loopback and authenticate
the remote server. TCP preserves HTTP, WebSocket and other application
protocols without adding application authentication code. There is no admin
listener. Both images and confidential guest launch policies must be pinned.

For a CoCo workload, put the proxy **inside the same confidential Pod VM** as
the application. Include its exact inline bootstrap in the measured policy.
Provision its private key through a Trustee-backed CoCo sealed-secret volume
mounted under `/sealed`; mount pointers rather than plaintext credentials.
The module deliberately leaves certificate issuance, attestation policy,
rotation and resource storage to the deployment. Plain Kubernetes Secrets
are suitable only when the host is trusted.

Application ports must bind to loopback, or be blocked from remote traffic by
the deployment. A NetworkPolicy is useful defense in depth, but its labels
do not establish a cryptographic identity. Plaintext exists at each endpoint;
an ordinary endpoint's host remains trusted. Install a separate confidential
endpoint when that host must be excluded from the trust boundary.

```ts
const proxy = new EnvoyTcpProxy({
  image: approvedEnvoyDigest,
  tls: { certificateChain: "/sealed/tls/cert.pem", privateKey: "/sealed/tls/key.pem", trustedCa: "/sealed/tls/ca.pem" },
  routes: [{ name: "api", direction: "outbound", listenPort: 18080,
    upstream: { host: "server.namespace.svc", port: 18443 },
    peerIdentity: "spiffe://example.test/pair-1/server" }],
});
```
