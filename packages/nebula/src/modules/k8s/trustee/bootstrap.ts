import type { KbsResourcePath } from "../confidential-guests/pull-broker";
import { resourcePath, type TrusteePolicies } from "./policies";

export const TRUSTEE_STATE = "/run/trustee";
const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

export interface TrusteeBootstrapFiles {
  readonly tlsPrivateKey: KbsResourcePath;
  readonly tlsCertificate: KbsResourcePath;
  readonly resources: readonly { readonly path: KbsResourcePath; readonly bootstrapPath: KbsResourcePath }[];
}

/** Public startup instructions only. Every secret arrives over CDH's native
 * attested channel after the guest policy has admitted this exact process. */
export function trusteeBootstrapScript(configToml: string, policies: TrusteePolicies,
  files: TrusteeBootstrapFiles, endpointHost: string): string {
  const write = (path: string, content: string) =>
    `printf '%s' ${quote(Buffer.from(content).toString("base64"))} | base64 -d > ${quote(path)}`;
  const fetch = (path: KbsResourcePath, destination: string) =>
    `fetch ${quote(resourcePath(path))} ${quote(destination)}`;
  return `set -eu
umask 077
ulimit -c 0
failed() { echo 'Trustee bootstrap failed; KBS was not started' >&2; exit 1; }
# Refuse shared filesystems before fetching anything. The measured agent policy
# must ALSO constrain the volume transport to guest ephemeral/tmpfs storage.
[ "$(stat -f -c %T ${TRUSTEE_STATE})" = tmpfs ] || failed
[ "$(stat -f -c %T /tmp)" = tmpfs ] || failed
for tool in curl openssl base64; do command -v "$tool" >/dev/null 2>&1 || failed; done
# A container restart re-attests and reloads its whole release, never a cached
# repository from the previous process. Only this fixed guest-memory path is used.
rm -rf ${TRUSTEE_STATE}/current
mkdir -p ${TRUSTEE_STATE}/current/tls ${TRUSTEE_STATE}/current/issuer \\
  ${TRUSTEE_STATE}/current/storage/kbs \\
  ${TRUSTEE_STATE}/current/storage/attestation_service_policy \\
  ${TRUSTEE_STATE}/current/storage/reference_value \\
  ${TRUSTEE_STATE}/current/storage/repository
trap 'rm -rf ${TRUSTEE_STATE}/current' EXIT
fetch() {
  # -q ignores curlrc; no redirects, proxy, ambient credentials or response bodies
  # on stdout/stderr. Only the guest-local resource API is enabled.
  curl -q --silent --fail --noproxy '*' --proto '=http' \\
    --connect-timeout 5 --max-time 120 --max-filesize 16777216 \\
    --output "$2" "http://127.0.0.1:8006/cdh/resource/$1" || failed
  [ -s "$2" ] || failed
}
${fetch(files.tlsPrivateKey, `${TRUSTEE_STATE}/current/tls/key.pem`)}
${fetch(files.tlsCertificate, `${TRUSTEE_STATE}/current/tls/cert.pem`)}
# Verify the attested identity material is usable before opening the listener.
key_public=$(openssl pkey -in ${TRUSTEE_STATE}/current/tls/key.pem -pubout 2>/dev/null) || failed
cert_public=$(openssl x509 -in ${TRUSTEE_STATE}/current/tls/cert.pem -pubkey -noout 2>/dev/null) || failed
[ -n "$key_public" ] && [ "$key_public" = "$cert_public" ] || failed
openssl x509 -in ${TRUSTEE_STATE}/current/tls/cert.pem -noout -checkend 0 >/dev/null 2>&1 || failed
# Native rustls clients reject CA certificates presented as server leaves.
constraints=$(openssl x509 -in ${TRUSTEE_STATE}/current/tls/cert.pem -noout -ext basicConstraints 2>/dev/null) || failed
case "$constraints" in *CA:TRUE*) failed ;; esac
unset constraints
# x509 -checkhost prints a mismatch but can still exit zero. verify fails on
# hostname, validity and server-purpose errors. The leaf is already authorized
# by the bootstrap KBS; using it as the local trust anchor supports full chains.
openssl verify -purpose sslserver -verify_hostname ${quote(endpointHost)} -partial_chain \\
  -trusted ${TRUSTEE_STATE}/current/tls/cert.pem ${TRUSTEE_STATE}/current/tls/cert.pem >/dev/null 2>&1 || failed
unset key_public cert_public
# The AS signer is generated in this guest. KBS trusts only its local certificate;
# accepting arbitrary token-header JWKs is explicitly disabled in the config.
openssl ecparam -name prime256v1 -genkey -noout -out ${TRUSTEE_STATE}/current/issuer/key.pem 2>/dev/null || failed
openssl req -new -x509 -key ${TRUSTEE_STATE}/current/issuer/key.pem -sha256 -days 3650 \\
  -subj '/CN=trustee-local-issuer' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \\
  -addext 'keyUsage=critical,digitalSignature,keyCertSign' \\
  -out ${TRUSTEE_STATE}/current/issuer/cert.pem >/dev/null 2>&1 || failed
${write(`${TRUSTEE_STATE}/current/kbs.toml`, configToml)}
${write(`${TRUSTEE_STATE}/current/storage/kbs/resource-policy.rego`, policies.resourcePolicy)}
${write(`${TRUSTEE_STATE}/current/storage/attestation_service_policy/default_cpu.rego`, policies.attestationPolicy)}
${write(`${TRUSTEE_STATE}/current/storage/attestation_service_policy/default_gpu.rego`, 'package policy\ndefault trust_claims := {"hardware": 97}\nextensions := []\n')}
${files.resources.map(item => fetch(item.bootstrapPath,
    `${TRUSTEE_STATE}/current/storage/repository/${resourcePath(item.path).replaceAll("/", "\\x2F")}`)).join("\n")}
trap - EXIT
# Do not export secret material through container logs, errors or core dumps.
exec /usr/local/bin/kbs --config-file ${TRUSTEE_STATE}/current/kbs.toml >/dev/null 2>&1
`;
}
