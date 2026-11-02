set -eu
. /etc/os-release
[ "${ID:-}" = debian ] && [ "${VERSION_CODENAME:-}" = @@SUITE@@ ]
[ "$(dpkg --print-architecture)" = @@ARCH@@ ]
kernel_state=$(dpkg-query -W '-f=${db:Status-Status} ${Version}' "linux-image-$(uname -r)")
set -- $kernel_state
[ "$#" = 2 ] && [ "$1" = installed ]
dpkg --compare-versions "$2" ge @@KERNEL_MINIMUM@@

# Official Debian EC2 images omit SSM. Install before volume attachment waits
# so an operator can recover a host whose later bootstrap fails.
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
debian_retry() { n=0; until "$@"; do n=$((n+1)); [ "$n" -ge 3 ] && return 1; sleep 10; done; }
if [ "$(dpkg-query -W '-f=${db:Status-Status} ${Version} ${Architecture}' amazon-ssm-agent 2>/dev/null || true)" != "installed "@@PACKAGEVERSION@@" "@@ARCH@@ ]; then
  debian_retry apt-get update -o APT::Update::Error-Mode=any
  debian_retry apt-get -o DPkg::Lock::Timeout=180 install --yes --no-remove --no-install-recommends ca-certificates curl gnupg
  work=$(mktemp -d)
  trap 'rm -rf "$work"' EXIT
  chmod 0700 "$work"
  mkdir -m 0700 "$work/gnupg"
  cat > "$work/public.asc" <<'NEBULA_SSM_PUBLIC_KEY'
@@PUBLIC_KEY@@
NEBULA_SSM_PUBLIC_KEY
  printf '%s  %s\n' @@KEYSHA256@@ "$work/public.asc" | sha256sum --check --status
  gpg --homedir "$work/gnupg" --batch --import "$work/public.asc"
  fingerprint=$(gpg --homedir "$work/gnupg" --batch --with-colons --fingerprint | awk -F: '$1=="fpr" {print $10; exit}')
  [ "$fingerprint" = @@SIGNINGFINGERPRINT@@ ]
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --max-time 180 --max-filesize 80000000 --output "$work/agent.deb" @@URL@@
  curl --fail --location --proto '=https' --proto-redir '=https' --retry 3 --max-time 180 --max-filesize 80000000 --output "$work/agent.deb.sig" @@SIGNATUREURL@@
  printf '%s  %s\n' @@SHA256@@ "$work/agent.deb" | sha256sum --check --status
  printf '%s  %s\n' @@SIGNATURESHA256@@ "$work/agent.deb.sig" | sha256sum --check --status
  gpg --homedir "$work/gnupg" --batch --no-auto-key-retrieve --verify "$work/agent.deb.sig" "$work/agent.deb"
  [ "$(dpkg-deb -f "$work/agent.deb" Package)" = amazon-ssm-agent ]
  [ "$(dpkg-deb -f "$work/agent.deb" Version)" = @@PACKAGEVERSION@@ ]
  [ "$(dpkg-deb -f "$work/agent.deb" Architecture)" = @@ARCH@@ ]
  dpkg --install "$work/agent.deb"
fi
cat > /etc/apt/apt.conf.d/99-nebula-reboot-policy <<'NEBULA_REBOOT_POLICY'
Unattended-Upgrade::Automatic-Reboot "false";
NEBULA_REBOOT_POLICY
systemctl enable --now amazon-ssm-agent
systemctl is-active --quiet amazon-ssm-agent
