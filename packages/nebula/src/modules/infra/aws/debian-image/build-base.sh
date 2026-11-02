#!/bin/bash
# Disposable Packer builder only. The input is verified before host mutations.
set -euo pipefail
[[ ${NEBULA_IMAGE_BUILD:-} == 1 && $(id -u) == 0 ]]
plan=/tmp/nebula-image-plan.json
python3 - "$plan" <<'PY'
import json,re,sys
p=json.load(open(sys.argv[1]))
assert p['schema']==1 and re.fullmatch(r'[a-z]{2}(?:-[a-z]+)+-[0-9]+',p['region'])
assert p['architecture'] in ('amd64','arm64') and p['sshUser']=='admin'
assert p['rootDeviceName'] in ('/dev/sda1','/dev/xvda')
assert p['minimumKernelVersion']=='6.12.113-1'
assert p['spending']['enabled'] is True and p['spending']['approvalReference']
s=p['ssm'];version=s['version'];arch=p['architecture']
assert re.fullmatch(r'3\.3\.\d+\.\d+',version)
assert s['packageVersion']==version+'-1'
assert s['url']==f'https://s3.eu-central-1.amazonaws.com/amazon-ssm-eu-central-1/{version}/debian_{arch}/amazon-ssm-agent.deb'
assert s['signatureUrl']==s['url']+'.sig'
assert s['signingFingerprint']=='1C5B395CBE5E74E2F1CA21592784DBF388D19D46'
for field in ['sha256','signatureSha256','keySha256']: assert re.fullmatch('[a-f0-9]{64}',s[field])
PY
. /etc/os-release
[[ $ID == debian && $VERSION_CODENAME == trixie ]]
field() { python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p[sys.argv[2]])' "$plan" "$1"; }
ssmfield() { python3 -c 'import json,sys; p=json.load(open(sys.argv[1])); print(p["ssm"][sys.argv[2]])' "$plan" "$1"; }
[[ $(dpkg --print-architecture) == "$(field architecture)" ]]
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update -o APT::Update::Error-Mode=any
apt-get install --yes --no-remove --no-install-recommends ca-certificates curl gnupg lvm2 thin-provisioning-tools
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
chmod 0700 "$work"
mkdir -m 0700 "$work/gnupg"
printf '%s  %s\n' "$(ssmfield keySha256)" /tmp/amazon-ssm-agent.asc | sha256sum --check --status
gpg --homedir "$work/gnupg" --batch --import /tmp/amazon-ssm-agent.asc
fingerprint=$(gpg --homedir "$work/gnupg" --batch --with-colons --fingerprint | awk -F: '$1=="fpr" {print $10; exit}')
[[ $fingerprint == "$(ssmfield signingFingerprint)" ]]
for suffix in '' .sig; do
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --max-time 180 --max-filesize 80000000 \
    --output "$work/agent.deb$suffix" "$(ssmfield url)$suffix"
done
printf '%s  %s\n' "$(ssmfield sha256)" "$work/agent.deb" | sha256sum --check --status
printf '%s  %s\n' "$(ssmfield signatureSha256)" "$work/agent.deb.sig" | sha256sum --check --status
gpg --homedir "$work/gnupg" --batch --no-auto-key-retrieve --verify "$work/agent.deb.sig" "$work/agent.deb"
[[ $(dpkg-deb -f "$work/agent.deb" Package) == amazon-ssm-agent ]]
[[ $(dpkg-deb -f "$work/agent.deb" Version) == "$(ssmfield packageVersion)" ]]
[[ $(dpkg-deb -f "$work/agent.deb" Architecture) == "$(field architecture)" ]]
dpkg --install "$work/agent.deb"
systemctl enable amazon-ssm-agent
systemctl stop amazon-ssm-agent
kernel_version=$(dpkg-query -W '-f=${Version}' "linux-image-$(uname -r)")
dpkg --compare-versions "$kernel_version" ge "$(field minimumKernelVersion)"
cat > /etc/apt/apt.conf.d/99-nebula-reboot-policy <<'EOF'
// Kernel activation is a reviewed instance replacement, not an unattended reboot.
Unattended-Upgrade::Automatic-Reboot "false";
EOF
# This is builder state. Every launched node must acquire its own identities.
rm -rf /var/lib/amazon/ssm/* /var/log/amazon/ssm/*
rm -f /etc/ssh/ssh_host_*
apt-get clean
cloud-init clean --logs --machine-id
rm -f "$plan" /tmp/amazon-ssm-agent.asc
