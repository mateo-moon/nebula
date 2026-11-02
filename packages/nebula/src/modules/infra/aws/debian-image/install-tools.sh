#!/bin/bash
# Explicitly requested disposable Debian/Ubuntu CI container only.
set -euo pipefail
[[ ${NEBULA_IMAGE_BUILD:-} == 1 && $(id -u) == 0 && $(uname -s) == Linux ]]
python3 - "$1" <<'PY'
import json,sys
p=json.load(open(sys.argv[1]))['spending']
assert p['enabled'] is True and isinstance(p['approvalReference'],str) and p['approvalReference'].strip()
PY
arch=$(dpkg --print-architecture)
case "$arch" in amd64|arm64) ;; *) exit 1;; esac
toolchain=$(dirname "$0")/toolchain.json
field() { python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["linux"][sys.argv[2]][sys.argv[3]])' "$toolchain" "$arch" "$1"; }
apt-get update -o APT::Update::Error-Mode=any
apt-get install -y --no-install-recommends awscli ca-certificates curl unzip
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' --max-time 120 "$(field url)" -o "$work/packer.zip"
printf '%s  %s\n' "$(field sha256)" "$work/packer.zip" | sha256sum --check --status
unzip -p "$work/packer.zip" packer > "$work/packer"
install -m 0755 "$work/packer" /usr/local/bin/packer
