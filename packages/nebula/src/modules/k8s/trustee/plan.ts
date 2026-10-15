import { X509Certificate } from "node:crypto";
import { stringify as stringifyToml } from "smol-toml";
import { canonicalJson, sha256Hex } from "../confidential-guests/canonical";
import { isDigestImage } from "../confidential-guests/types";
import { measuredFragments } from "../envoy";
import { TRUSTEE_STATE, trusteeBootstrapScript } from "./bootstrap";
import { deploymentFor, type TrusteePodManifest } from "./manifests";
import { resourcePath, trusteePolicies } from "./policies";
import type { TrusteeConfig, TrusteePlan } from "./types";
import { publicConfig } from "./validation";

const fail = (reason: string): never => { throw new TypeError(`Trustee: ${reason}`); };
function label(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) fail("invalid DNS label");
}
function selector(value: Readonly<Record<string, string>>): void {
  if (!value || Array.isArray(value) || !Object.keys(value).length || Object.entries(value).some(([key, item]) =>
    !/^(?:[a-z0-9.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(key) ||
    typeof item !== "string" || !/^(?:[A-Za-z0-9][A-Za-z0-9_.-]{0,61}[A-Za-z0-9]|[A-Za-z0-9])?$/.test(item))) {
    fail("nonempty, valid label selectors are required");
  }
}
function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(`invalid ${name}`);
  return value;
}
function bootstrapUrl(config: TrusteeConfig, endpointHost: string): string {
  let url: URL;
  try { url = new URL(config.bootstrap.url); } catch { return fail("bootstrap URL must be an HTTPS origin"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", endpointHost, config.name,
        `${config.name}.${config.namespace}`, `${config.name}.${config.namespace}.svc`,
        `${config.name}.${config.namespace}.svc.cluster.local`].includes(url.hostname.toLowerCase())) {
    fail("bootstrap must be a separate HTTPS origin, without credentials, path, query or fragment");
  }
  const pem = config.bootstrap.certificatePem;
  if (typeof pem !== "string") fail("bootstrap requires one public PEM trust certificate");
  let certificate: X509Certificate;
  try { certificate = new X509Certificate(pem); } catch { return fail("invalid bootstrap X.509 certificate"); }
  // X509Certificate alone accepts a leading certificate with trailing content.
  // Require exactly its public PEM encoding, allowing only whitespace changes.
  if (pem.replace(/\s/g, "") !== certificate.toString().replace(/\s/g, "")) {
    fail("bootstrap requires exactly one public PEM trust certificate");
  }
  return url.origin;
}

/** Compose upstream Trustee inside one SNP Pod. No plaintext Kubernetes Secrets,
 * mutable config mounts, remote AS/RVPS, host storage or privileged helpers. */
export function trusteePlan(config: TrusteeConfig): TrusteePlan {
  publicConfig("Trustee", config);
  label(config.name); label(config.namespace);
  if (config.namespace === "default" || config.namespace.startsWith("kube-")) fail("use a dedicated namespace");
  if (!isDigestImage(config.image)) fail("the built-in-AS KBS image must be pinned by sha256 digest");
  selector(config.nodeSelector);
  if (!Array.isArray(config.clients) || !config.clients.length) fail("declare at least one allowed client selector");
  for (const client of config.clients) { label(client.namespace); selector(client.podLabels); }
  if (config.createNamespace !== undefined && typeof config.createNamespace !== "boolean") fail("invalid createNamespace");
  if (!Array.isArray(config.resources) || !config.resources.length || config.resources.length > 32) fail("supply one to 32 resources");
  const port = integer(config.port ?? 8443, 1024, 65535, "port");
  if (port === 8006) fail("port 8006 is reserved for the guest-local CDH API");
  const memory = integer(config.guestMemoryMiB ?? 2048, 1024, 65536, "guestMemoryMiB");
  const vcpus = integer(config.guestVcpus ?? 2, 1, 64, "guestVcpus");
  const host = config.endpointHost ?? `${config.name}.${config.namespace}.svc.cluster.local`;
  if (typeof host !== "string" || host.length > 253 || !host.includes(".") ||
      host.split(".").some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) fail("endpointHost must be a DNS name");
  const url = bootstrapUrl(config, host);
  const bootstrapPaths = [config.bootstrap.tlsPrivateKey, config.bootstrap.tlsCertificate,
    ...config.resources.map(item => item.bootstrapPath)].map(resourcePath);
  if (new Set(bootstrapPaths).size !== bootstrapPaths.length) fail("bootstrap TLS and resource paths must be distinct");
  const policies = trusteePolicies(config.resources);
  const root = `${TRUSTEE_STATE}/current`;
  const configToml = stringifyToml({
    session_storage_type: "Memory",
    http_server: { sockets: [`0.0.0.0:${port}`], insecure_http: false, tls_profile: "modern",
      private_key: `${root}/tls/key.pem`, certificate: `${root}/tls/cert.pem`, payload_request_size: 2 },
    attestation_token: { insecure_header_jwk: false, trusted_certs_paths: [`${root}/issuer/cert.pem`],
      trusted_jwk_sets: [], extra_teekey_paths: [] },
    attestation_service: { type: "coco_as_builtin", policy_id_map: {},
      rvps_config: { type: "BuiltIn" }, attestation_token_broker: { duration_min: 5,
        signer: { key_path: `${root}/issuer/key.pem`, cert_path: `${root}/issuer/cert.pem` } } },
    admin: { authorization_mode: "DenyAll" },
    storage_backend: { storage_type: "LocalFs", backends: { local_fs: { dir_path: `${root}/storage` } } },
    plugins: [{ name: "resource", storage_backend_type: "kvstorage" }],
  });
  const aaToml = stringifyToml({ token_configs: { kbs: { url, cert: config.bootstrap.certificatePem,
    tee_key_algorithm: "ECDH-ES+A256KW-P256" } }, log: { level: "off" } });
  const cdhToml = stringifyToml({ socket: "unix:///run/confidential-containers/cdh.sock", credentials: [],
    kbc: { name: "cc_kbc", url, kbs_cert: config.bootstrap.certificatePem }, log: { level: "off" } });
  const script = trusteeBootstrapScript(configToml, policies, { ...config.bootstrap, resources: config.resources }, host);
  const labels = { "app.kubernetes.io/name": "trustee", "app.kubernetes.io/instance": config.name };
  const pod: TrusteePodManifest = {
    apiVersion: "v1", kind: "Pod", metadata: { name: config.name, namespace: config.namespace, labels,
      annotations: {
        "io.containerd.cri.runtime-handler": "kata-qemu-snp",
        "io.katacontainers.config.hypervisor.default_memory": String(memory),
        "io.katacontainers.config.hypervisor.default_vcpus": String(vcpus),
        "io.katacontainers.config.hypervisor.kernel_params":
          "agent.guest_components_procs=api-server-rest agent.guest_components_rest_api=resource",
      } },
    spec: {
      runtimeClassName: "kata-qemu-snp", automountServiceAccountToken: false, enableServiceLinks: false,
      nodeSelector: { ...config.nodeSelector }, restartPolicy: "Always",
      securityContext: { runAsUser: 10001, runAsGroup: 10001, runAsNonRoot: true, fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" } },
      containers: [{ name: "trustee", image: config.image, imagePullPolicy: "Always",
        // Fragment public instructions for the pinned Kata policy parser. There
        // are no credentials in argv and no host-mounted bootstrap script.
        command: ["/bin/sh", "-ec", 'exec /bin/sh -ec "$(printf \'%s\' "$@" | base64 -d)"', "trustee-bootstrap"],
        args: measuredFragments(Buffer.from(script).toString("base64")),
        env: [{ name: "RUST_LOG", value: "off" }, { name: "RUST_BACKTRACE", value: "0" },
          { name: "HOME", value: TRUSTEE_STATE }],
        securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } },
        ports: [{ name: "https", containerPort: port, protocol: "TCP" }],
        readinessProbe: { tcpSocket: { port }, periodSeconds: 10 },
        resources: { requests: { cpu: "250m", memory: "256Mi" }, limits: { cpu: String(vcpus), memory: `${memory - 512}Mi` } },
        volumeMounts: [{ name: "state", mountPath: TRUSTEE_STATE }, { name: "tmp", mountPath: "/tmp" }],
      }],
      volumes: [{ name: "state", emptyDir: { medium: "Memory", sizeLimit: "256Mi" } },
        { name: "tmp", emptyDir: { medium: "Memory", sizeLimit: "64Mi" } }],
    },
  };
  return { pod, workload: deploymentFor(pod), canonicalPodSha256: sha256Hex(canonicalJson(pod)), configToml, aaToml, cdhToml,
    serviceUrl: `https://${host}:${port}`, ...policies };
}
