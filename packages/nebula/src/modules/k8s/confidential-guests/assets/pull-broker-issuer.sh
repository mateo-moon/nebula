# Ephemeral token-signing issuer of the attested pull broker, minted by the
# broker image's own openssl before KBS starts, into memory-backed state.
# Idempotent and atomic: it mints under a temporary name, renames the key and
# then the certificate, and keeps an existing issuer only when its key and
# certificate match and the certificate has not expired. Anything else fails
# closed: KBS never starts without a matching pair.
set -eu
umask 077
issuer=${1:-/state/issuer}
failed() {
  echo "{\"phase\":\"issuer-failed\",\"reason\":\"$1\"}" >&2
  exit 1
}
command -v openssl >/dev/null 2>&1 || failed "the openssl CLI is missing"
# The key's public half must be the certificate's.
pair() {
  [ -s "$1/key.pem" ] && [ -s "$1/cert.pem" ] || return 1
  key=$(openssl pkey -in "$1/key.pem" -pubout 2>/dev/null) || return 1
  cert=$(openssl x509 -in "$1/cert.pem" -pubkey -noout 2>/dev/null) || return 1
  [ -n "$key" ] && [ "$key" = "$cert" ]
}
# A crashed init leaves its temporary directory behind; only the files it
# writes may be in it.
for stale in "$issuer"/.new.*; do
  [ -d "$stale" ] || continue
  rm -f -- "$stale/key.pem" "$stale/cert.pem" "$stale/req.cnf"
  rmdir -- "$stale" || failed "unexpected files in $stale"
done
if pair "$issuer" && openssl x509 -in "$issuer/cert.pem" -noout -checkend 0 >/dev/null 2>&1; then
  echo '{"phase":"issuer-present"}'
  exit 0
fi
mkdir -p "$issuer"
new=$(mktemp -d "$issuer/.new.XXXXXX")
trap 'rm -f -- "$new/key.pem" "$new/cert.pem" "$new/req.cnf"; rmdir -- "$new" 2>/dev/null || :' EXIT
cat > "$new/req.cnf" <<'CONF'
[req]
distinguished_name = subject
x509_extensions = issuer
prompt = no
[subject]
CN = registry-issuer
[issuer]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, digitalSignature, keyCertSign, cRLSign
subjectKeyIdentifier = hash
CONF
openssl ecparam -name prime256v1 -genkey -noout -out "$new/key.pem" || failed "minting the key failed"
openssl req -new -x509 -config "$new/req.cnf" -key "$new/key.pem" -sha256 -days 3650 -out "$new/cert.pem" \
  || failed "minting the certificate failed"
pair "$new" || failed "the minted certificate does not match its key"
mv -f "$new/key.pem" "$issuer/key.pem"
mv -f "$new/cert.pem" "$issuer/cert.pem"
pair "$issuer" || failed "the installed issuer does not match"
echo '{"phase":"issuer-minted"}'
