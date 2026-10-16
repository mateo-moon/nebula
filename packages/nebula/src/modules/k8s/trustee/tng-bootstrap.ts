export const TRUSTEE_STATE = "/run/trustee";
const STATE = TRUSTEE_STATE;
import type { TrusteeTngConfig } from "./types";

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const write = (path: string, text: string) =>
  `printf '%s' ${quote(Buffer.from(text).toString("base64"))} | base64 -d > ${quote(path)}`;
const denyResource = "package policy\ndefault allow := false\n";
const denyAttestation = 'package policy\ndefault trust_claims := {"hardware": 97, "executables": 33, "configuration": 36}\nextensions := []\n';

/** Public startup instructions; the signer is created only inside guest tmpfs. */
export function tngTrusteeBootstrapScript(owner: string, kbsConfig: string): string {
  const root = `${STATE}/current`;
  return `set -eu
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
}

export function tngBootstrapScript(tngConfig: TrusteeTngConfig): string {
  return `set -eu
umask 077
ulimit -c 0
test "$(stat -f -c %T /tmp)" = tmpfs
${write("/tmp/tng.json", JSON.stringify(tngConfig))}
exec tng launch --config-file /tmp/tng.json
`;
}
