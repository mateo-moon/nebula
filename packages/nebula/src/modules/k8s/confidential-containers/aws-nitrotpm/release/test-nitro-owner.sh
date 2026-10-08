#!/bin/sh
# Only run inside the isolated test container, with no host TPM or credentials.
set -eu
state=$(mktemp -d /dev/shm/nebula-nitro.XXXXXX)
swtpm socket --tpm2 --tpmstate "dir=$state" \
  --server type=tcp,bindaddr=127.0.0.1,port=2321 \
  --ctrl type=tcp,bindaddr=127.0.0.1,port=2322 \
  --flags not-need-init,startup-clear &
emulator=$!
trap 'kill "$emulator" 2>/dev/null || true; wait "$emulator" 2>/dev/null || true; rm -rf "$state"' EXIT HUP INT TERM
export NEBULA_SWTPM_TEST=1 NEBULA_SWTPM_PORT=2321
ready=false
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if tpm2_getcap -T swtpm:host=127.0.0.1,port=2321 properties-fixed >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.1
done
test "$ready" = true
"$1" --ignored --exact tpm_manager::tests::protected_owner_survives_attestation_objects_and_context_recreation
