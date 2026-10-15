import { ApiObject, type ApiObjectProps } from "cdk8s";
import { Construct } from "constructs";
import { X509Certificate } from "node:crypto";
import { gzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { canonicalJson, sha256Hex } from "../confidential-guests/canonical";
import { initDataDocument, measuredGuest, type MeasuredArtifact } from "../confidential-guests/measured";
import type { KbsResourcePath } from "../confidential-guests/pull-broker";
import { isDigestImage } from "../confidential-guests/types";
import { measuredFragments } from "../envoy";
import { TRUSTEE_STATE, trusteeBootstrapScript } from "./bootstrap";
import { validateTrusteeAgentPolicy } from "./agent-policy";
import { resourcePath, snpIdentity, trusteePolicies, type TrusteePolicies,
  type TrusteeResourceAdmission, type TrusteeSnpIdentity } from "./policies";

export { trusteePolicies } from "./policies";
export { TngTrustee, tngTrusteePlan, tngTrusteeInitData, tngTrusteeClientPlan } from "./tng";
export type { TngTrusteeConfig } from "./tng";
export type { TrusteePolicies, TrusteeResourceAdmission, TrusteeSnpIdentity } from "./policies";
export { TRUSTEE_STARTUP_METADATA_POLICY, TRUSTEE_DENIED_AGENT_REQUESTS } from "./agent-policy";

export interface TrusteeResource extends TrusteeResourceAdmission {
  /** Versioned resource on the independent bootstrap KBS; contains the bytes to serve. */
  readonly bootstrapPath: KbsResourcePath;
}

export interface TrusteeConfig {
  readonly name: string;
  readonly namespace: string;
  /** Upstream KBS with built-in AS, curl, openssl and coreutils, pinned by digest.
   * The config/storage contract is Trustee revision 71251310045d8be2e95041cf0028691623c73957.
   * A release tag alone does not establish this contract. */
  readonly image: string;
  readonly bootstrap: {
    /** Independently governed root of trust; never this unprovisioned Trustee. */
    readonly url: string;
    /** Public HTTPS trust anchor, embedded in measured AA and CDH configuration.
     * Upstream adds this to its roots. The approved guest must exclude other
     * roots that could authenticate an administrator-controlled impostor. */
    readonly certificatePem: string;
    readonly tlsPrivateKey: KbsResourcePath;
    readonly tlsCertificate: KbsResourcePath;
  };
  readonly resources: readonly TrusteeResource[];
  readonly nodeSelector: Readonly<Record<string, string>>;
  /** NetworkPolicy is defense in depth; the attested policies enforce identity. */
  readonly clients: readonly { readonly namespace: string; readonly podLabels: Readonly<Record<string, string>> }[];
  readonly port?: number;
  /** Public DNS name in the bootstrapped TLS certificate. Defaults to Service FQDN. */
  readonly endpointHost?: string;
  readonly createNamespace?: boolean;
  /** Kata base-memory annotation; effective VM memory also depends on runtime resource accounting. */
  readonly guestMemoryMiB?: number;
  /** Kata base-vCPU annotation; some runtimes add container CPU limits at launch. */
  readonly guestVcpus?: number;
}

export interface TrusteePlan extends TrusteePolicies {
  /** Exact unsigned Deployment to feed to genpolicy (preserves generated-name rules). */
  readonly workload: ApiObjectProps;
  /** Canonical Pod-shaped template used for the measured-artifact hash. */
  readonly pod: ApiObjectProps;
  readonly canonicalPodSha256: string;
  readonly configToml: string;
  readonly aaToml: string;
  readonly cdhToml: string;
  readonly serviceUrl: string;
}

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
  const pod: ApiObjectProps = {
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

/** The deployment owner supplies a reviewed, tested Kata policy for this exact
 * Pod. Hash binding prevents stale artifacts, not semantically unsafe Rego. */
export interface TrusteeAgentPolicy {
  readonly canonicalPodSha256: string;
  readonly policyRego: string;
}

/** Assemble native Init-Data after offline genpolicy generation and owner review. */
export function trusteeInitData(config: TrusteeConfig, reviewed: TrusteeAgentPolicy): MeasuredArtifact {
  const plan = trusteePlan(config);
  if (reviewed.canonicalPodSha256 !== plan.canonicalPodSha256) fail("Pod changed since policy generation");
  validateTrusteeAgentPolicy(reviewed.policyRego);
  const document = stringifyToml({ version: "0.1.0", algorithm: "sha256",
    data: { "policy.rego": reviewed.policyRego, "aa.toml": plan.aaToml, "cdh.toml": plan.cdhToml,
      "trustee.template.sha256": plan.canonicalPodSha256 } });
  const bytes = Buffer.from(document);
  const compressed = gzipSync(bytes, { level: 9 });
  compressed[9] = 255;
  return { canonicalPodSha256: plan.canonicalPodSha256, ccInitData: compressed.toString("base64"), initDataSha256: sha256Hex(bytes) };
}

function bindPolicy(plan: TrusteePlan, policy: MeasuredArtifact): ApiObjectProps {
  const pod = measuredGuest(plan.pod, policy);
  let document: any;
  try { document = parseToml(initDataDocument(policy.ccInitData).toString("utf8"), { unsafeKeyBehaviour: "throw" }); }
  catch { return fail("invalid native Init-Data document"); }
  if (document.version !== "0.1.0" || document.algorithm !== "sha256" ||
      Object.keys(document).sort().join() !== "algorithm,data,version" || !document.data ||
      Object.keys(document.data).sort().join() !== "aa.toml,cdh.toml,policy.rego,trustee.template.sha256" ||
      document.data["trustee.template.sha256"] !== plan.canonicalPodSha256 ||
      !isDeepStrictEqual([document.data["aa.toml"], document.data["cdh.toml"]], [plan.aaToml, plan.cdhToml])) {
    fail("Init-Data must bind the exact bootstrap HTTPS identity and native AA/CDH configuration");
  }
  validateTrusteeAgentPolicy(document.data["policy.rego"]);
  return pod;
}

function deploymentFor(pod: ApiObjectProps): ApiObjectProps {
  const { name, namespace, labels, annotations } = pod.metadata!;
  return { apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace, labels },
    spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels },
      template: { metadata: { labels, annotations }, spec: pod.spec } } };
}

/** Policies to install out of band on the independently controlled root KBS.
 * Never deploys or changes that authority; only this guest's exact pair is admitted. */
export function trusteeBootstrapPolicies(config: TrusteeConfig, policy: MeasuredArtifact,
  guest: Omit<TrusteeSnpIdentity, "initDataSha256">): TrusteePolicies {
  bindPolicy(trusteePlan(config), policy);
  const identity = snpIdentity({ ...guest, initDataSha256: policy.initDataSha256 });
  return trusteePolicies([config.bootstrap.tlsPrivateKey, config.bootstrap.tlsCertificate,
    ...config.resources.map(resource => resource.bootstrapPath)].map(path => ({ path, recipients: [identity] })));
}

/** Declarative deployment, composed like other Nebula modules. Deliberately uses
 * Construct rather than BaseConstruct: no host-side secret resolution is needed. */
export class Trustee extends Construct {
  public readonly deployment: ApiObject;
  public readonly service: ApiObject;
  public readonly networkPolicy: ApiObject;
  public readonly serviceUrl: string;
  public readonly initDataSha256: string;

  constructor(scope: Construct, id: string, config: TrusteeConfig & { readonly policy: MeasuredArtifact }) {
    super(scope, id);
    const plan = trusteePlan(config);
    const pod = bindPolicy(plan, config.policy);
    this.serviceUrl = plan.serviceUrl;
    this.initDataSha256 = config.policy.initDataSha256;
    const { name, namespace } = config;
    if (config.createNamespace !== false) new ApiObject(this, "namespace", {
      apiVersion: "v1", kind: "Namespace", metadata: { name: namespace },
    });
    const labels = pod.metadata!.labels;
    const port = config.port ?? 8443;
    this.deployment = new ApiObject(this, "deployment", deploymentFor(pod));
    this.service = new ApiObject(this, "service", {
      apiVersion: "v1", kind: "Service", metadata: { name, namespace, labels },
      spec: { type: "ClusterIP", selector: labels, ports: [{ name: "https", port, targetPort: port, protocol: "TCP" }] },
    });
    this.networkPolicy = new ApiObject(this, "network-policy", {
      apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name, namespace },
      spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress"], ingress: [{
        from: config.clients.map(client => ({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": client.namespace } },
          podSelector: { matchLabels: { ...client.podLabels } } })),
        ports: [{ port, protocol: "TCP" }],
      }] },
    });
  }
}
