import { createPublicKey } from "node:crypto";
import { stringify } from "smol-toml";
import { isDigestImage } from "../confidential-guests/types";
import { measuredFragments } from "../envoy/measured-fragments";
import { TRUSTEE_STATE as STATE } from "./tng-bootstrap";
import { confidentialTrusteeHelmSettings } from "./helm";
import { tngBootstrapScript, tngTrusteeBootstrapScript } from "./tng-bootstrap";
import type { TrusteeConfig, TrusteeTngConfig } from "./types";
import { publicConfig } from "./validation";
import { snpIdentity } from "./policies";
import { validateNetwork } from "./genpolicy";

const fail = (message: string): never => { throw new TypeError(`Trustee: ${message}`); };
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
  // OpenSSL can encode P-256 with explicit parameters. Trustee's native JWT
  // decoder expects a named curve; a JWK round trip preserves the public point
  // while selecting that interoperable SPKI encoding before measurement.
  return createPublicKey({ key: key.export({ format: "jwk" }), format: "jwk" })
    .export({ format: "pem", type: "spki" }).toString();
}
export function trusteeSettings(config: TrusteeConfig) {
  publicConfig("Trustee", config);
  // Validate the owner-supplied guest fields before invoking external tools.
  // The real Init-Data hash is produced by native genpolicy below.
  snpIdentity({ ...config.guest, initDataSha256: "1".repeat(64) });
  validateNetwork(config.network);
  label(config.name); label(config.namespace);
  if (config.namespace === "default" || config.namespace.startsWith("kube-")) fail("use a dedicated namespace");
  if (!isDigestImage(config.kbsImage) || !isDigestImage(config.tngImage)) fail("both images must be pinned by digest");
  selector(config.nodeSelector);
  if (!Array.isArray(config.clients) || !config.clients.length) fail("declare network client selectors");
  for (const client of config.clients) { label(client.namespace); selector(client.podLabels); }
  const claim = config.ownerClaimSha256;
  if ((claim === undefined) === (config.ownerPublicKeyPem === undefined)) {
    fail("supply either an owner public key or a one-time owner claim hash");
  }
  if (claim !== undefined && !/^[a-f0-9]{64}$/.test(claim)) fail("invalid owner claim hash");
  const owner = claim === undefined ? publicKey(config.ownerPublicKeyPem!) : undefined;
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
  const tngConfig: TrusteeTngConfig = { add_egress: [{ mapping: {
    in: { host: "0.0.0.0", port: 8443 }, out: { host: "127.0.0.1", port: 8080 } },
    attest: { aa_provider: "coco_asr", asr_addr: "http://127.0.0.1:8006", refresh_interval: 0 },
    rats_tls: { multiplex: false } }] };
  const kbsScript = tngTrusteeBootstrapScript(owner, kbsConfig);
  const tngScript = tngBootstrapScript(tngConfig);
  const { values, extensions } = confidentialTrusteeHelmSettings(config, { image: config.kbsImage, script: kbsScript,
    restApi: "attestation", port: 8443, memory: 2048, vcpus: 2 });
  extensions.volumeMounts = [{ name: "kbs-tmp", mountPath: "/tmp" }, { name: "state", mountPath: STATE }];
  extensions.volumes = ["state", "kbs-tmp", "tng-tmp"].map(name => ({ name,
    emptyDir: { medium: "Memory", sizeLimit: "128Mi" } }));
  extensions.extraContainers = [{ name: "tng", image: config.tngImage, imagePullPolicy: "Always",
    command: ["/bin/sh", "-ec", 'exec /bin/sh -ec "$(printf \'%s\' "$@" | base64 -d)"', "tng"],
    args: measuredFragments(Buffer.from(tngScript).toString("base64")),
    env: [{ name: "RUST_LOG", value: "error" }, { name: "RUST_BACKTRACE", value: "0" }, { name: "HOME", value: "/tmp" }],
    securityContext: extensions.containerSecurityContext, resources: values.kbs.resources,
    volumeMounts: [{ name: "tng-tmp", mountPath: "/tmp" }],
    ports: [{ name: "rats-tls", containerPort: 8443 }],
    readinessProbe: { tcpSocket: { port: 8443 }, periodSeconds: 5 },
  }];
  const aaToml = stringify({ log: { level: "off" } });
  return { values, extensions, kbsConfig, tngConfig, aaToml };
}
