import { trusteePolicies, snpIdentity, type TrusteeSnpIdentity } from "./policies";

const fail = (message: string): never => { throw new TypeError(`TngTrustee: ${message}`); };

/** Mainline AS runs in the CLIENT's trust boundary, not beside the untrusted
 * network or as a bootstrap KBS. Its verified SNP claims include HOST_DATA.
 * Resolve the target to IPv4 at runtime before passing mapping config to TNG. */
export function tngTrusteeClientPlan(identity: TrusteeSnpIdentity, target: { host: string; port: number },
  localPort = 18080, verifierPort = 18082, verifierCaPath = "/state/ca.pem") {
  const approved = snpIdentity(identity);
  if (typeof target.host !== "string" || !/^[A-Za-z0-9.-]+$/.test(target.host)) fail("invalid target host");
  for (const [port, minimum] of [[target.port, 1], [localPort, 1024], [verifierPort, 1024]]) {
    if (!Number.isInteger(port) || port < minimum || port > 65535) fail("invalid port");
  }
  if (localPort === verifierPort) fail("client and verifier ports must differ");
  if (!verifierCaPath.startsWith("/") || verifierCaPath.includes("\0")) fail("use an absolute local verifier CA path");
  const policy = trusteePolicies([{ path: ["verification", "only", "server"], recipients: [approved] }]).attestationPolicy;
  return { policy, asConfig: { storage_backend: { storage_type: "LocalFs", backends: { local_fs: { dir_path: "/state/storage" } } },
    rvps_config: { type: "BuiltIn" }, attestation_token_broker: { duration_min: 1,
      signer: { key_path: "/state/signer.key", cert_path: "/state/signer.pem" } } },
    tngConfig: { add_ingress: [{ mapping: { in: { host: "127.0.0.1", port: localPort }, out: { ...target } },
      rats_tls: { multiplex: false }, verify: { as_type: "restful", as_addr: `http://127.0.0.1:${verifierPort}`,
        trusted_certs_paths: [verifierCaPath], policy_ids: ["approved"] } }] } };
}
