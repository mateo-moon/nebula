import { createPublicKey } from "node:crypto";
import { stringify } from "smol-toml";
import { canonicalJson, sha256Hex } from "../confidential-guests/canonical";
import { isDigestImage } from "../confidential-guests/types";
import { measuredFragments } from "../envoy";
import { TRUSTEE_STATE as STATE } from "./bootstrap";
import { deploymentFor, type TrusteePodManifest } from "./manifests";
import { tngBootstrapScript, tngTrusteeBootstrapScript } from "./tng-bootstrap";
import type { TngTrusteeConfig, TngTrusteePlan } from "./types";
import { publicConfig } from "./validation";

const fail = (message: string): never => { throw new TypeError(`TngTrustee: ${message}`); };
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
export function tngTrusteePlan(config: TngTrusteeConfig): TngTrusteePlan {
  publicConfig("TngTrustee", config);
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
  const tngConfig: TngTrusteePlan["tngConfig"] = { add_egress: [{ mapping: {
    in: { host: "0.0.0.0", port: 8443 }, out: { host: "127.0.0.1", port: 8080 } },
    attest: { aa_provider: "coco_asr", asr_addr: "http://127.0.0.1:8006", refresh_interval: 0 },
    rats_tls: { multiplex: false } }] };
  const kbsScript = tngTrusteeBootstrapScript(owner, kbsConfig);
  const tngScript = tngBootstrapScript(tngConfig);
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
  const pod: TrusteePodManifest = { apiVersion: "v1", kind: "Pod", metadata: { name: config.name, namespace: config.namespace, labels,
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
  return { pod, workload: deploymentFor(pod), canonicalPodSha256: sha256Hex(canonicalJson(pod)), kbsConfig, tngConfig, aaToml };
}
