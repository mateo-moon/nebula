export const TRUSTEE_STATE = "/run/trustee";
const STATE = TRUSTEE_STATE;
import type { TrusteeTngConfig } from "./types";

const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";
const write = (path: string, text: string) =>
  `printf '%s' ${quote(Buffer.from(text).toString("base64"))} | base64 -d > ${quote(path)}`;
const denyResource = "package policy\ndefault allow := false\n";
const denyAttestation = 'package policy\ndefault trust_claims := {"hardware": 97, "executables": 33, "configuration": 36}\nextensions := []\n';

/** Public startup instructions; the signer is created only inside guest tmpfs. */
export function tngTrusteeBootstrapScript(owner: string | undefined, kbsConfig: string): string {
  const root = `${STATE}/current`;
  const ownerSetup = owner === undefined ? `
test "$(stat -f -c %T /run/instance)" = tmpfs
if [ ! -e /run/instance/internal-owner ]; then
  tmp="$(mktemp -d /run/instance/internal-owner.XXXXXXXX)"
  chmod 0700 "$tmp"
  openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/key.pem" 2>/dev/null
  openssl pkey -in "$tmp/key.pem" -pubout -out "$tmp/public.pem" 2>/dev/null
  chmod 0600 "$tmp/key.pem" "$tmp/public.pem"
  mv -T "$tmp" /run/instance/internal-owner
fi
test -f /run/instance/internal-owner/key.pem
test -f /run/instance/internal-owner/public.pem
openssl pkey -in /run/instance/internal-owner/key.pem -pubout 2>/dev/null | cmp -s - /run/instance/internal-owner/public.pem
cp /run/instance/internal-owner/public.pem ${root}/owner.pub` : write(`${root}/owner.pub`, owner);
  return `set -eu
umask 077
ulimit -c 0
test "$(stat -f -c %T ${STATE})" = tmpfs
test "$(stat -f -c %T /tmp)" = tmpfs
mkdir -p ${root}/issuer ${root}/storage/kbs ${root}/storage/repository ${root}/storage/attestation_service_policy ${root}/storage/reference_value
openssl ecparam -name prime256v1 -genkey -noout -out ${root}/issuer/key.pem 2>/dev/null
openssl req -new -x509 -key ${root}/issuer/key.pem -sha256 -days 2 -subj '/CN=trustee-local-issuer' -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,digitalSignature,keyCertSign' -out ${root}/issuer/cert.pem >/dev/null 2>&1
${ownerSetup}
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
