set -eu
root=${HOST_ROOT:-/host}
proc=${PROC_SYS:-/proc/sys}
apt=etc/apt/apt.conf.d/99zz-host-policy
needrestart=etc/needrestart/conf.d/zz-host-policy.conf
sysctl=etc/sysctl.d/90-host-policy.conf

if [ -z "$APT_POLICY" ] || [ -z "$NEEDRESTART_POLICY" ] || [ -z "$SYSCTL_POLICY" ]; then
  echo "APT_POLICY, NEEDRESTART_POLICY and SYSCTL_POLICY must all be set" >&2
  exit 2
fi

declared() {
  case "$1" in
    "$apt") printf '%s\n' "$APT_POLICY" ;;
    "$needrestart") printf '%s\n' "$NEEDRESTART_POLICY" ;;
    "$sysctl") printf '%s\n' "$SYSCTL_POLICY" ;;
  esac
}

# Each function keeps its own status variable: sh has no locals, and a shared
# one would let a passing function reset a failure reported before it.
files() {
  files_rc=0
  for f in "$apt" "$needrestart" "$sysctl"; do
    if [ "$(cat "$root/$f" 2>/dev/null)" = "$(declared "$f")" ]; then
      echo "/$f: OK"
    else
      echo "/$f: missing or not the declared policy" >&2
      files_rc=1
    fi
  done
  return "$files_rc"
}

# The sysctl.d file takes effect at boot; until then the host runs what
# enrollment set with sysctl -w, which must be the same values.
live() {
  live_rc=0
  while IFS='= ' read -r key value; do
    case "$key" in ''|'#'*) continue ;; esac
    actual=$(cat "$proc/$(printf %s "$key" | tr . /)" 2>/dev/null) || actual=unreadable
    if [ "$actual" = "$value" ]; then
      echo "$key = $actual"
    else
      echo "$key is $actual live, declared $value" >&2
      live_rc=1
    fi
  done <<EOF
$SYSCTL_POLICY
EOF
  return "$live_rc"
}

apply() {
  umask 022
  for f in "$apt" "$needrestart" "$sysctl"; do
    target=$root/$f
    if [ "$(cat "$target" 2>/dev/null)" = "$(declared "$f")" ]; then
      echo "/$f: no change"
      continue
    fi
    new=${target%/*}/.${target##*/}.new
    declared "$f" > "$new"
    mv "$new" "$target"
    echo "/$f: written"
  done
  files
}

case "${1:-}" in
  apply) apply ;;
  check)
    rc=0
    files || rc=1
    live || rc=1
    exit "$rc"
    ;;
  *) echo "usage: host-policy.sh apply|check" >&2; exit 2 ;;
esac
