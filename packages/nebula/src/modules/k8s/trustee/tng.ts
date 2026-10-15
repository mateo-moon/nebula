import { ApiObject, type ApiObjectProps } from "cdk8s";
import { Construct } from "constructs";
import { createPublicKey } from "node:crypto";
import { gzipSync } from "node:zlib";
import { parse, stringify } from "smol-toml";
import { canonicalJson, sha256Hex } from "../confidential-guests/canonical";
import { initDataDocument, measuredGuest, type MeasuredArtifact } from "../confidential-guests/measured";
import { isDigestImage } from "../confidential-guests/types";
import { measuredFragments } from "../envoy";
import { validateTrusteeAgentPolicy } from "./agent-policy";
import type { TrusteeAgentPolicy } from "./index";

export { tngTrusteeClientPlan } from "./client-plan";

/** Self-sufficient, ephemeral Trustee. Only the owner's PUBLIC administration
 * key enters the manifest. Both server images must be public and digest pinned. */
export interface TngTrusteeConfig {
  readonly name: string;
  readonly namespace: string;
  readonly kbsImage: string;
  readonly tngImage: string;
  readonly ownerPublicKeyPem: string;
  readonly nodeSelector: Readonly<Record<string, string>>;
  readonly clients: readonly { readonly namespace: string; readonly podLabels: Readonly<Record<string, string>> }[];
  readonly createNamespace?: boolean;
}

const STATE = "/run/trustee";
const fail = (message: string): never => { throw new TypeError(`TngTrustee: ${message}`); };
const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const write = (path: string, text: string) =>
  `printf '%s' ${quote(Buffer.from(text).toString("base64"))} | base64 -d > ${quote(path)}`;
const denyResource = "package policy\ndefault allow := false\n";
const denyAttestation = 'package policy\ndefault trust_claims := {"hardware": 97, "executables": 33, "configuration": 36}\nextensions := []\n';

function label(value: string): void {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) fail("invalid DNS label");
}
function selector(value: Readonly<Record<string, string>>): void {
  if (!value || Array.isArray(value) || !Object.keys(value).length || Object.entries(value).some(([key, item]) =>
    !/^(?:[a-z0-9.-]+\/)?[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(key) ||
    typeof item !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(item))) fail("invalid or empty selector");
}
function publicKey(pem: string): string {
  if (typeof pem !== "string" || !/^-----BEGIN [P]UBLIC KEY-----\n[\s\S]+\n-----END [P]UBLIC KEY-----\s*$/.test(pem)) {
    fail("supply exactly one SPKI public key, never private material");
  }
  let key;
  try { key = createPublicKey(pem); } catch { return fail("invalid owner public key"); }
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    fail("the owner JWT key must use P-256 / ES256");
  }
  const normalized = key.export({ format: "pem", type: "spki" }).toString();
  if (pem.replace(/\s/g, "") !== normalized.replace(/\s/g, "")) fail("unexpected public-key content");
  return normalized;
}
function deployment(pod: ApiObjectProps): ApiObjectProps {
  const { name, namespace, labels, annotations } = pod.metadata!;
  return { apiVersion: "apps/v1", kind: "Deployment", metadata: { name, namespace, labels },
    spec: { replicas: 1, strategy: { type: "Recreate" }, selector: { matchLabels: labels },
      template: { metadata: { labels, annotations }, spec: pod.spec } } };
}

export function tngTrusteePlan(config: TngTrusteeConfig) {
  label(config.name); label(config.namespace);
  if (config.namespace === "default" || config.namespace.startsWith("kube-")) fail("use a dedicated namespace");
  if (!isDigestImage(config.kbsImage) || !isDigestImage(config.tngImage)) fail("both images must be pinned by digest");
  selector(config.nodeSelector);
  if (!Array.isArray(config.clients) || !config.clients.length) fail("declare network client selectors");
  for (const client of config.clients) { label(client.namespace); selector(client.podLabels); }
  const owner = publicKey(config.ownerPublicKeyPem);
  const root = `${STATE}/current`;
  const kbsConfig = stringify({
    session_storage_type: "Memory",
    // Plaintext exists only on loopback INSIDE the attested guest. TNG owns the
    // only public listener; the guest policy must freeze its loopback/network.
    http_server: { sockets: ["127.0.0.1:8080"], insecure_http: true, payload_request_size: 2 },
    attestation_token: { insecure_header_jwk: false, trusted_certs_paths: [`${root}/issuer/cert.pem`],
      trusted_jwk_sets: [], extra_teekey_paths: [] },
    attestation_service: { type: "coco_as_builtin", policy_id_map: {}, rvps_config: { type: "BuiltIn" },
      attestation_token_broker: { duration_min: 5,
        signer: { key_path: `${root}/issuer/key.pem`, cert_path: `${root}/issuer/cert.pem` } } },
    admin: { authorization_mode: "AuthenticatedAuthorization",
      authentication: { bearer_jwt: { identity_providers: [{ issuer: "nebula-owner", audience: config.name,
        public_key_uri: `${root}/owner.pub` }] } },
      authorization: { regex_acl: { acls: [{ role: "owner",
        allowed_endpoints: "^/kbs/v0/(resource/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+|resource-policy|attestation-policy)$" }] } } },
    storage_backend: { storage_type: "LocalFs", backends: { local_fs: { dir_path: `${root}/storage` } } },
    plugins: [{ name: "resource", storage_backend_type: "kvstorage" }],
  });
  const tngConfig = { add_egress: [{ mapping: {
    in: { host: "0.0.0.0", port: 8443 }, out: { host: "127.0.0.1", port: 8080 } },
    attest: { aa_provider: "coco_asr", asr_addr: "http://127.0.0.1:8006", refresh_interval: 0 },
    rats_tls: { multiplex: false } }] };
  const kbsScript = `set -eu
umask 077
ulimit -c 0
test "$(stat -f -c %T ${STATE})" = tmpfs
test "$(stat -f -c %T /tmp)" = tmpfs
mkdir -p ${root}/issuer ${root}/storage/kbs ${root}/storage/repository ${root}/storage/attestation_service_policy ${root}/storage/reference_value
openssl ecparam -name prime256v1 -genkey -noout -out ${root}/issuer/key.pem 2>/dev/null
openssl req -new -x509 -key ${root}/issuer/key.pem -sha256 -days 2 -subj '/CN=trustee-local-issuer' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,digitalSignature,keyCertSign' -out ${root}/issuer/cert.pem >/dev/null 2>&1
${write(`${root}/owner.pub`, owner)}
${write(`${root}/kbs.toml`, kbsConfig)}
${write(`${root}/storage/kbs/resource-policy.rego`, denyResource)}
${write(`${root}/storage/attestation_service_policy/default_cpu.rego`, denyAttestation)}
${write(`${root}/storage/attestation_service_policy/default_gpu.rego`, denyAttestation)}
exec /usr/local/bin/kbs --config-file ${root}/kbs.toml >/dev/null 2>&1
`;
  const tngScript = `set -eu
umask 077
ulimit -c 0
test "$(stat -f -c %T /tmp)" = tmpfs
${write("/tmp/tng.json", JSON.stringify(tngConfig))}
exec tng launch --config-file /tmp/tng.json
`;
  const labels = { "app.kubernetes.io/name": "tng-trustee", "app.kubernetes.io/instance": config.name };
  const securityContext = { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } };
  const container = (name: string, image: string, script: string, tmp: string) => ({ name, image, imagePullPolicy: "Always",
    command: ["/bin/sh", "-ec", 'exec /bin/sh -ec "$(printf \'%s\' "$@" | base64 -d)"', name],
    args: measuredFragments(Buffer.from(script).toString("base64")),
    env: [{ name: "RUST_LOG", value: "off" }, { name: "RUST_BACKTRACE", value: "0" }, { name: "HOME", value: "/tmp" }],
    securityContext, resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "1", memory: "1Gi" } },
    volumeMounts: [{ name: tmp, mountPath: "/tmp" }] });
  const kbs = container("trustee", config.kbsImage, kbsScript, "kbs-tmp");
  kbs.volumeMounts.push({ name: "state", mountPath: STATE });
  const tng = container("tng", config.tngImage, tngScript, "tng-tmp");
  tng.env[0].value = "error";
  const pod: ApiObjectProps = { apiVersion: "v1", kind: "Pod", metadata: { name: config.name, namespace: config.namespace, labels,
    annotations: { "io.containerd.cri.runtime-handler": "kata-qemu-snp",
      "io.katacontainers.config.hypervisor.default_memory": "2048", "io.katacontainers.config.hypervisor.default_vcpus": "2",
      "io.katacontainers.config.hypervisor.kernel_params": "agent.guest_components_procs=api-server-rest agent.guest_components_rest_api=attestation" } },
    spec: { runtimeClassName: "kata-qemu-snp", automountServiceAccountToken: false, enableServiceLinks: false,
      nodeSelector: { ...config.nodeSelector }, restartPolicy: "Always",
      securityContext: { runAsUser: 10001, runAsGroup: 10001, runAsNonRoot: true, fsGroup: 10001,
        seccompProfile: { type: "RuntimeDefault" } },
      containers: [kbs, { ...tng, ports: [{ name: "rats-tls", containerPort: 8443 }],
        readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 5 } }],
      volumes: ["state", "kbs-tmp", "tng-tmp"].map(name => ({ name, emptyDir: { medium: "Memory", sizeLimit: "128Mi" } })),
    } };
  const aaToml = stringify({ log: { level: "off" } });
  return { pod, workload: deployment(pod), canonicalPodSha256: sha256Hex(canonicalJson(pod)), kbsConfig, tngConfig, aaToml };
}

export function tngTrusteeInitData(config: TngTrusteeConfig, reviewed: TrusteeAgentPolicy): MeasuredArtifact {
  const plan = tngTrusteePlan(config);
  if (reviewed.canonicalPodSha256 !== plan.canonicalPodSha256) fail("Pod changed since policy generation");
  validateTrusteeAgentPolicy(reviewed.policyRego);
  const document = stringify({ version: "0.1.0", algorithm: "sha256", data: {
    "policy.rego": reviewed.policyRego, "aa.toml": plan.aaToml, "trustee.template.sha256": plan.canonicalPodSha256 } });
  const compressed = gzipSync(Buffer.from(document), { level: 9 }); compressed[9] = 255;
  return { canonicalPodSha256: plan.canonicalPodSha256, ccInitData: compressed.toString("base64"), initDataSha256: sha256Hex(document) };
}

export class TngTrustee extends Construct {
  public readonly deployment: ApiObject;
  public readonly service: ApiObject;
  public readonly networkPolicy: ApiObject;
  public readonly initDataSha256: string;
  constructor(scope: Construct, id: string, config: TngTrusteeConfig & { readonly policy: MeasuredArtifact }) {
    super(scope, id);
    const plan = tngTrusteePlan(config);
    const pod = measuredGuest(plan.pod, config.policy);
    const document = parse(initDataDocument(config.policy.ccInitData).toString("utf8"));
    const data = document.data as Record<string, string>;
    if (document.version !== "0.1.0" || document.algorithm !== "sha256" ||
      Object.keys(document).sort().join() !== "algorithm,data,version" || !data ||
      Object.keys(data).sort().join() !== "aa.toml,policy.rego,trustee.template.sha256" ||
      data["aa.toml"] !== plan.aaToml || data["trustee.template.sha256"] !== plan.canonicalPodSha256) fail("unexpected InitData configuration");
    validateTrusteeAgentPolicy(data["policy.rego"]);
    this.initDataSha256 = config.policy.initDataSha256;
    const { name, namespace } = config;
    const labels = pod.metadata!.labels;
    if (config.createNamespace !== false) new ApiObject(this, "namespace", { apiVersion: "v1", kind: "Namespace", metadata: { name: namespace } });
    this.deployment = new ApiObject(this, "deployment", deployment(pod));
    this.service = new ApiObject(this, "service", { apiVersion: "v1", kind: "Service", metadata: { name, namespace },
      spec: { type: "ClusterIP", selector: labels, ports: [{ name: "rats-tls", port: 8443, targetPort: 8443 }] } });
    this.networkPolicy = new ApiObject(this, "network-policy", { apiVersion: "networking.k8s.io/v1", kind: "NetworkPolicy", metadata: { name, namespace },
      spec: { podSelector: { matchLabels: labels }, policyTypes: ["Ingress"], ingress: [{ ports: [{ port: 8443, protocol: "TCP" }],
        from: config.clients.map(client => ({ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": client.namespace } },
          podSelector: { matchLabels: { ...client.podLabels } } })) }] } });
  }
}
