#!/bin/sh
# Synthetic API fixture used only inside the network-disabled test container.
set -eu
if [ "${SCENARIO-}" = in-cluster ]; then
  # Real kubectl must discover the mounted service-account configuration. The
  # configured loopback port is closed; no Kubernetes server or credential is used.
  exec /usr/bin/kubectl "$@" 2>/work/client-error
fi
verb='' input=''
for argument do
  case "$argument" in get|create|replace) verb=$argument ;; esac
done
while [ "$#" -gt 0 ]; do
  case "$1" in -f) input=$2; shift ;; esac
  shift
done
test -n "$verb"
printf '%s\n' "$verb" >> /work/calls
if [ "$verb" = get ]; then
  if [ "${SCENARIO-}" = hang ]; then sleep 60; fi
  if [ "${SCENARIO-}" = forbidden ]; then
    printf '%s\n' 'Forbidden: synthetic-sensitive-error' >&2
    exit 1
  fi
  if [ -f /work/secret.json ]; then cat /work/secret.json; fi
  exit 0
fi
test -f "$input"
cp "$input" /work/submitted.json
if [ "${SCENARIO-}" = conflict ]; then
  printf '%s\n' 'Conflict: synthetic-sensitive-error' >&2
  exit 1
fi
if [ "$verb" = create ] && [ "${SCENARIO-}" = create-race ]; then
  jq '.metadata.resourceVersion = "2" | .metadata.annotations.competitor = "keep"' "$input" > /work/secret.json
  printf '%s\n' 'AlreadyExists: synthetic-sensitive-error' >&2
  exit 1
fi
if [ "$verb" = replace ]; then
  expected=$(jq -r .metadata.resourceVersion /work/secret.json)
  jq -e --arg expected "$expected" '.metadata.resourceVersion == $expected' "$input" >/dev/null
else
  test ! -f /work/secret.json
  jq -e '.metadata.resourceVersion == null' "$input" >/dev/null
fi
jq '.metadata.resourceVersion = "3"' "$input" > /work/secret.json
printf '%s\n' 'secret/workload-pull-credentials'
