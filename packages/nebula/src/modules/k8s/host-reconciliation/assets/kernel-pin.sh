set -eu
export LC_ALL=C
root=${HOST_ROOT:-}
cfg=$root/boot/grub/grub.cfg
grubenv=$root/boot/grub/grubenv
previous=$cfg.kernel-pin-previous
candidate=$cfg.kernel-pin-new
pin=$root/__PIN_FILE__

case "$FREEZE" in
  on|off) ;;
  *) echo "FREEZE must be on or off, not '$FREEZE'" >&2; exit 2 ;;
esac
KERNEL=${KERNEL:-} GRUB_ENTRY=${GRUB_ENTRY:-}
if [ -z "$KERNEL" ] || [ -z "$GRUB_ENTRY" ] || [ -n "$(printf %s "$KERNEL$GRUB_ENTRY" | tr -d 'A-Za-z0-9._>-')" ]; then
  echo "KERNEL and GRUB_ENTRY must be plain GRUB ids" >&2
  exit 2
fi

content() {
  echo "# __PROVENANCE__"
  echo "GRUB_DEFAULT=\"$GRUB_ENTRY\""
}

# The kernel image the menu entry named by a GRUB default ("0", an id, a title,
# or a ">" path through submenus) loads, or nothing when it names no entry.
image_of() {
  awk -v want="$1" '
    BEGIN { q = sprintf("%c", 39) }
    /^[ \t]*(menuentry|submenu)[ \t]/ {
      line = $0; title = ""; id = ""
      if (match(line, q "[^" q "]*" q)) { title = substr(line, RSTART + 1, RLENGTH - 2); line = substr(line, RSTART + RLENGTH) }
      if (match(line, "[$]menuentry_id_option[ \t]+" q "[^" q "]*" q)) {
        id = substr(line, RSTART, RLENGTH); sub("^[^" q "]*" q, "", id); sub(q "$", "", id)
      }
      parent = key[depth]; i = count[parent]++
      k = (parent == "") ? i : (parent ">" i)
      kind[k] = $1; ids[k] = id; titles[k] = title
      key[++depth] = k
      next
    }
    /\{[ \t]*$/ { key[++depth] = ""; next }
    /^[ \t]*\}[ \t]*$/ { depth--; next }
    /^[ \t]*linux[ \t]/ { k = key[depth]; if (k != "" && !(k in image)) image[k] = $2 }
    END {
      n = split(want, part, ">"); k = ""
      for (p = 1; p <= n; p++) {
        found = ""
        for (i = 0; i < count[k] && found == ""; i++) {
          c = (k == "") ? i : (k ">" i)
          if (part[p] == i "" || ids[c] == part[p] || titles[c] == part[p]) found = c
        }
        if (found == "") exit
        k = found
      }
      if (n > 0 && kind[k] == "menuentry" && (k in image)) print image[k]
    }' "$2"
}

# The default a grub.cfg sets when grubenv redirects nothing.
generated_default() {
  awk '/^[ \t]*set default="/ {
    v = $0; sub(/^[ \t]*set default="/, "", v); sub(/"[ \t]*$/, "", v)
    if (v != "${next_entry}" && !(v in seen)) { seen[v] = 1; print v }
  }' "$1"
}

# Whether two grub.cfg files differ in nothing but their `set default=` lines.
only_default_differs() {
  awk 'FNR == 1 { f++ }
    { line = $0; sub(/^[ \t]*set default=.*/, "set default=", line) }
    f == 1 { a[FNR] = line; n = FNR; next }
    a[FNR] != line { bad = 1; exit }
    { m = FNR }
    END { exit bad || m != n }' "$1" "$2"
}

# The grubenv variables with which grub.cfg's header boots another entry than
# its default: next_entry, prev_entry after initrdfail, or a second env_block.
redirects() {
  awk '/^(next_entry|initrdfail|prev_entry|env_block)=./ { printf "%s%s", sep, $0; sep = ", " }' "$grubenv" 2>/dev/null || true
}

# GRUB_DEFAULT as the next regeneration reads it: /etc/default/grub, then
# every grub.d/*.cfg in order, the last assignment winning.
assignment='^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}GRUB_DEFAULT='
configured_default() {
  value=$(sed -n "s/$assignment//p" "$root/etc/default/grub" "$root"/etc/default/grub.d/*.cfg 2>/dev/null | tail -n 1)
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  echo "${value:-0}"
}

# The GRUB_DEFAULT assignments in grub.d files that grub-mkconfig reads after
# the pin (its glob sorts bytewise, like sort under LC_ALL=C).
overrides() {
  for f in "$root"/etc/default/grub.d/*.cfg; do
    [ -e "$f" ] && [ "$f" != "$pin" ] || continue
    [ "$(printf '%s\n' "$pin" "$f" | sort | tail -n 1)" = "$f" ] || continue
    grep -H -e "$assignment" "$f" || true
  done
}

# Whether a grub.cfg (the installed one by default) boots what FREEZE asks for,
# now and after the next regeneration.
check() {
  conf=${1:-$cfg}
  [ -r "$conf" ] || { echo "$conf: unreadable" >&2; return 1; }
  generated=$(generated_default "$conf")
  if [ "$FREEZE" = off ]; then
    [ ! -e "$pin" ] || { echo "$pin: still present" >&2; return 1; }
    [ "$generated" != "$GRUB_ENTRY" ] || { echo "grub.cfg still defaults to the pin $GRUB_ENTRY" >&2; return 1; }
    image=$(image_of "$generated" "$conf")
    [ -n "$image" ] || { echo "grub.cfg default '$generated' names no kernel entry" >&2; return 1; }
    echo "unpinned: next boot $image ($generated)"
    return 0
  fi
  [ "$(cat "$pin" 2>/dev/null)" = "$(content)" ] || { echo "$pin: missing or not the pin for $KERNEL" >&2; return 1; }
  configured=$(configured_default)
  [ "$configured" = "$GRUB_ENTRY" ] || {
    echo "GRUB_DEFAULT is '$configured' after every drop-in, pinned '$GRUB_ENTRY'" >&2; return 1; }
  [ "$generated" = "$GRUB_ENTRY" ] || { echo "grub.cfg default is '$generated', pinned '$GRUB_ENTRY'" >&2; return 1; }
  image=$(image_of "$GRUB_ENTRY" "$conf")
  case "$image" in
    "/vmlinuz-$KERNEL"|"/boot/vmlinuz-$KERNEL") ;;
    *) echo "grub.cfg entry $GRUB_ENTRY boots '${image:-nothing}', pinned vmlinuz-$KERNEL" >&2; return 1 ;;
  esac
  redirect=$(redirects)
  [ -z "$redirect" ] || { echo "grubenv sets $redirect: GRUB may boot another entry than the pin" >&2; return 1; }
  echo "pinned: next boot $image ($GRUB_ENTRY)"
}

# Puts the drop-in back as it was and drops the regenerated candidate.
discard() {
  rm -f "$candidate" "$candidate.new"
  if [ "$had_pin" = yes ]; then
    printf '%s\n' "$old_pin" > "$pin.new"
    mv "$pin.new" "$pin"
  else
    rm -f "$pin"
  fi
}

apply() {
  if out=$(check 2>&1); then
    printf '%s\nno change\n' "$out"
    return 0
  fi
  printf '%s\n' "$out"
  if [ "$FREEZE" = on ]; then
    running=$(uname -r)
    [ "$running" = "$KERNEL" ] || {
      echo "running kernel $running, pinned $KERNEL: refusing to pin a kernel this host does not run" >&2; return 1; }
    for f in "vmlinuz-$KERNEL" "initrd.img-$KERNEL"; do
      [ -s "$root/boot/$f" ] || { echo "/boot/$f: missing" >&2; return 1; }
    done
    case "$(image_of "$GRUB_ENTRY" "$cfg")" in
      "/vmlinuz-$KERNEL"|"/boot/vmlinuz-$KERNEL") ;;
      *) echo "grub.cfg has no entry $GRUB_ENTRY booting vmlinuz-$KERNEL" >&2; return 1 ;;
    esac
    later=$(overrides)
    [ -z "$later" ] || {
      printf '%s\n' "$later" >&2
      echo "a grub.d file read after the pin sets GRUB_DEFAULT: no regeneration can pin while it does" >&2; return 1; }
    redirect=$(redirects)
    [ -z "$redirect" ] || { echo "grubenv sets $redirect, which no regeneration clears: see the runbook" >&2; return 1; }
  fi
  locks=$(lslocks --noheadings --output PATH)
  if printf '%s\n' "$locks" | grep -qx -e /var/lib/dpkg/lock -e /var/lib/dpkg/lock-frontend; then
    echo "a package operation holds the dpkg lock; the kubelet retries" >&2
    return 1
  fi

  umask 022
  had_pin=no old_pin=
  if [ -e "$pin" ]; then had_pin=yes old_pin=$(cat "$pin"); fi
  if [ "$FREEZE" = on ]; then
    content > "$pin.new"
    mv "$pin.new" "$pin"
  else
    rm -f "$pin"
  fi
  # Not update-grub, which rewrites grub.cfg in place: the candidate is
  # verified first and then installed with one rename.
  rm -f "$candidate" "$candidate.new"
  if ! grub-mkconfig -o "$candidate"; then
    discard
    echo "grub-mkconfig failed: grub.cfg is untouched and the drop-in restored" >&2
    return 1
  fi
  reason= out=
  if ! grub-script-check "$candidate"; then
    reason="it fails grub-script-check"
  elif ! out=$(check "$candidate" 2>&1); then
    printf '%s\n' "$out" >&2
    reason="it does not boot what FREEZE $FREEZE requires"
  elif ! only_default_differs "$cfg" "$candidate"; then
    diff "$cfg" "$candidate" >&2 || true
    reason="it differs from the current grub.cfg beyond the default line"
  fi
  if [ -n "$reason" ]; then
    discard
    echo "the regenerated grub.cfg is not installed: $reason; the drop-in is restored" >&2
    return 1
  fi
  cp -p "$cfg" "$previous"
  diff "$cfg" "$candidate" || true
  mv "$candidate" "$cfg"
  check
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  *) echo "usage: kernel-pin.sh apply|check" >&2; exit 2 ;;
esac
