#!/bin/sh
# The Argo Job/CronJob runs this with a private memory-backed /work volume.
set -eu
umask 077

stage=configuration
fail() { printf 'Registry credential operation failed (%s)\n' "$stage" >&2; exit 1; }
case "${1-}" in refresh|mirror) operation=$1 ;; *) fail ;; esac
test -n "${REGISTRY-}" || fail
directory=$(mktemp -d /work/registry.XXXXXX) || fail
trap 'rm -rf "$directory"' EXIT
trap 'exit 1' HUP INT TERM
code=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)

# jq errors and Kubernetes responses may contain secrets. Keep all diagnostics
# private; the only successful output is an expiry or a constant status line.
stage=credentials
jq -nce --arg registry "$REGISTRY" --argjson now "$(date +%s)" \
  --slurpfile base /gcr/.dockerconfigjson --slurpfile response /work/ecr.json \
  -f "$code/credentials.jq" > "$directory/credentials.json" 2>/dev/null || fail

if [ "$operation" = mirror ]; then
  stage=mirror-config
  test -n "${DOCKER_CONFIG-}" || fail
  mkdir -m 700 -- "$DOCKER_CONFIG" 2>/dev/null || fail
  jq -ce .credentials "$directory/credentials.json" > "$directory/docker.json" 2>/dev/null || fail
  # A pre-existing directory or config is never reused or overwritten.
  ln "$directory/docker.json" "$DOCKER_CONFIG/config.json" 2>/dev/null || fail
  printf '%s\n' 'Mirror registry config written'
  exit 0
fi

test -n "${SECRET_NAMESPACE-}" || fail
stage=secret-render
jq -nce --arg namespace "$SECRET_NAMESPACE" --slurpfile input "$directory/credentials.json" '
  {apiVersion: "v1", kind: "Secret", type: "kubernetes.io/dockerconfigjson",
   metadata: {name: "__CREDENTIALS_SECRET__", namespace: $namespace, annotations: {
     "__EXPIRY_ANNOTATION__": ($input[0].expiresAt | todateiso8601)}},
   data: {".dockerconfigjson": ($input[0].credentials | tojson | @base64)}}
' > "$directory/desired.json" 2>/dev/null || fail

# A request-timeout override makes this kubectl skip automatic in-cluster
# configuration and fall back to localhost:8080. Bound the whole process instead,
# retaining its projected token and verified cluster CA discovery.
kube() { timeout -k 2 20 kubectl --cache-dir="$directory/cache" --namespace="$SECRET_NAMESPACE" "$@"; }
for _attempt in 1 2 3; do
  stage=secret-read
  # --ignore-not-found is empty only for 404. Other read failures never write.
  kube get secret __CREDENTIALS_SECRET__ --ignore-not-found -o json \
    > "$directory/current.json" 2>/dev/null || fail
  if [ -s "$directory/current.json" ]; then
    stage=secret-merge
    jq -nce --slurpfile current "$directory/current.json" --slurpfile desired "$directory/desired.json" '
      $current[0] as $old | $desired[0] as $new
      | if ($current | length) != 1 or $old.kind != "Secret"
          or $old.type != $new.type or $old.metadata.name != $new.metadata.name
          or $old.metadata.namespace != $new.metadata.namespace
          or ($old.metadata.resourceVersion | type) != "string" or $old.metadata.resourceVersion == ""
        then error("invalid current Secret")
        else $new | .metadata = ($old.metadata + {annotations:
          (($old.metadata.annotations // {}) + $new.metadata.annotations)}) end
    ' > "$directory/update.json" 2>/dev/null || fail
    verb=replace
  else
    cp "$directory/desired.json" "$directory/update.json"
    verb=create
  fi
  # resourceVersion makes replacement conditional. On a race or failed write,
  # re-read before retrying; never delete or clear the existing Secret.
  stage=secret-write
  if kube "$verb" --validate=false -f "$directory/update.json" -o name >/dev/null 2>&1; then
    expiry=$(jq -r '.expiresAt | todateiso8601' "$directory/credentials.json")
    printf 'Registry pull credentials refreshed; valid until %s\n' "$expiry"
    exit 0
  fi
done
fail
