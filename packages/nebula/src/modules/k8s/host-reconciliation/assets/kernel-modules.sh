set -efu
export LC_ALL=C
root=${HOST_ROOT:-}
if [ -n "$root" ]; then root=$(CDPATH= cd -P "$root" && pwd -P); fi
loaded=${SYS_MODULES:-$root/sys/module}
modprobe=${MODPROBE:-/usr/sbin/modprobe}
modinfo=${MODINFO:-/usr/sbin/modinfo}
dpkg=${DPKG_QUERY:-/usr/bin/dpkg-query}
header='# Managed by Nebula HostKernelModules.'

fail() { echo "host kernel modules: $*" >&2; exit 1; }
case "${MODULES_FILE:-}" in
  90-nebula-*.conf) ;;
  *) fail 'invalid managed drop-in name' ;;
esac
case "$MODULES_FILE" in *[!a-z0-9.-]*|*..*) fail 'invalid managed drop-in name' ;; esac
[ -n "${KERNEL_MODULES:-}" ] || fail 'declare reviewed modules explicitly'
seen=' '
for module in $KERNEL_MODULES; do
  case "$module" in dm_thin_pool) ;; *) fail 'unreviewed module name' ;; esac
  case "$seen" in *" $module "*) fail 'duplicate module name' ;; esac
  seen="$seen$module "
done
directory=$root/etc/modules-load.d
target=$directory/$MODULES_FILE

declared() {
  printf '%s\n' "$header"
  for module in $KERNEL_MODULES; do printf '%s\n' "$module"; done
}
file_matches() { [ -f "$target" ] && [ ! -L "$target" ] && declared | cmp -s "$target" -; }
loaded_modules() {
  for module in $KERNEL_MODULES; do
    [ -d "$loaded/$module" ] || { echo "$module is not loaded" >&2; return 1; }
  done
}

# The only accepted files are the installed, matching Debian kernel's signed
# in-tree thin-provisioning modules. No URL, module options or arbitrary path.
module_file() {
  path=$1
  case "$path" in /lib/modules/"$kernel"/kernel/*|/usr/lib/modules/"$kernel"/kernel/*) ;; *) fail 'module outside running kernel tree' ;; esac
  case "$path" in *[!A-Za-z0-9_./+-]*|*/../*|*/./*|*//*) fail 'unsafe module path' ;; esac
  base=${path##*/}
  case "$base" in
    dm-bufio.ko|dm-bufio.ko.xz|dm-bufio.ko.zst|dm-bufio.ko.gz|\
    dm-bio-prison.ko|dm-bio-prison.ko.xz|dm-bio-prison.ko.zst|dm-bio-prison.ko.gz|\
    dm-persistent-data.ko|dm-persistent-data.ko.xz|dm-persistent-data.ko.zst|dm-persistent-data.ko.gz|\
    dm-thin-pool.ko|dm-thin-pool.ko.xz|dm-thin-pool.ko.zst|dm-thin-pool.ko.gz) ;;
    *) fail 'unreviewed module dependency' ;;
  esac
  [ -f "$root$path" ] && [ ! -L "$root$path" ] || fail 'module file missing or linked'
  # Debian usrmerge exposes /lib through /usr/lib, while dpkg owns the physical
  # installed path. Resolve parent directories only; final module links remain
  # forbidden. Both paths must name the same device/inode in this kernel tree.
  physical_directory=$(CDPATH= cd -P "$root${path%/*}" && pwd -P)
  canonical_file=$physical_directory/$base
  package_path=${canonical_file#"$root"}
  case "$package_path" in /lib/modules/"$kernel"/kernel/*|/usr/lib/modules/"$kernel"/kernel/*) ;; *) fail 'canonical module outside running kernel tree' ;; esac
  [ -f "$canonical_file" ] && [ ! -L "$canonical_file" ] && [ "$root$path" -ef "$canonical_file" ] || fail 'module path identity changed'
  magic=$("$modinfo" -F vermagic "$package_path")
  [ "${magic%% *}" = "$kernel" ] || fail 'module belongs to another kernel'
  [ "$("$modinfo" -F intree "$package_path")" = Y ] || fail 'module is not in-tree'
  [ "$("$modinfo" -F sig_id "$package_path")" = 'PKCS#7' ] || fail 'module is unsigned'
  [ -n "$("$modinfo" -F signer "$package_path")" ] && [ -n "$("$modinfo" -F sig_key "$package_path")" ] || fail 'module signature metadata missing'
  owner=$("$dpkg" -S "$package_path")
  case "$owner" in "linux-image-$kernel: "*) ;; *) fail 'module is not owned by the installed kernel package' ;; esac
  [ ! -L "$root$path" ] && [ "$root$path" -ef "$canonical_file" ] || fail 'module path identity changed'
}
preflight() {
  kernel=$(uname -r)
  for module in $KERNEL_MODULES; do
    selected=$("$modinfo" -F filename "$module")
    case "${selected##*/}" in dm-thin-pool.ko|dm-thin-pool.ko.xz|dm-thin-pool.ko.zst|dm-thin-pool.ko.gz) ;; *) fail 'requested module resolved to another module' ;; esac
    module_file "$selected"
    plan=$("$modprobe" --dry-run --verbose "$module")
    clean=$("$modprobe" --config /dev/null --dry-run --verbose "$module")
    [ "$plan" = "$clean" ] || fail 'host modprobe configuration changes the loading plan'
    [ "${#plan}" -le 8192 ] || fail 'module plan is too large'
    if [ ! -d "$loaded/$module" ]; then [ -n "$plan" ] || fail 'unloaded module has no insertion plan'; fi
    while read -r operation path extra; do
      [ -n "$operation" ] || continue
      [ "$operation" = insmod ] && [ -n "$path" ] && [ -z "$extra" ] || fail 'module plan contains a hook or arguments'
      module_file "$path"
    done <<EOF
$plan
EOF
  done
}

case "${1:-}" in
  check)
    file_matches || fail 'managed boot declaration differs'
    loaded_modules || exit 1
    ;;
  apply)
    [ ! -L "$directory" ] || fail 'managed directory must not be a symlink'
    [ ! -L "$target" ] || fail 'managed drop-in must not be a symlink'
    if [ -e "$target" ]; then
      [ -f "$target" ] && [ "$(head -n 1 "$target")" = "$header" ] || fail 'drop-in is owned by another policy'
    fi
    preflight
    for module in $KERNEL_MODULES; do
      if [ ! -d "$loaded/$module" ]; then
        # Ignore host install hooks for the requested module AND dependencies.
        # Kernel module files/dependency metadata still come from the host.
        "$modprobe" --config /dev/null --ignore-install "$module"
      fi
    done
    loaded_modules || fail 'requested module did not become available'
    if ! file_matches; then
      umask 022
      mkdir -p "$directory"
      temporary=$(mktemp "$directory/.$MODULES_FILE.XXXXXX")
      trap 'rm -f "$temporary"' EXIT HUP INT TERM
      declared > "$temporary"
      chmod 0644 "$temporary"
      mv "$temporary" "$target"
      trap - EXIT HUP INT TERM
    fi
    file_matches || fail 'managed boot declaration was not persisted'
    ;;
  *) fail 'usage: kernel-modules.sh apply|check' ;;
esac
