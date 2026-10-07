set -eu
export LC_ALL=C

VG=${VG:-} DIR=${DIR:-} SIZE=${SIZE:-} EVICTION_PERCENT=${EVICTION_PERCENT:-} HEADROOM=${HEADROOM:-}
FIRST_PINNED_LOOP=${FIRST_PINNED_LOOP:-} GROW_TO=${GROW_TO:-}
if [ -z "$VG" ] || [ -n "$(printf %s "$VG" | tr -d 'a-z0-9-')" ] || [ "${VG#-}" != "$VG" ]; then
  echo "VG must be a plain volume group name" >&2
  exit 2
fi
case "$DIR/" in
  /?*/) ;;
  *) echo "DIR must be an absolute path" >&2; exit 2 ;;
esac
case "$DIR/" in
  *//*|*/./*|*/../*) echo "DIR must be a plain absolute path" >&2; exit 2 ;;
esac
if [ -n "$(printf %s "$DIR" | tr -d 'A-Za-z0-9/._-')" ]; then
  echo "DIR must be a plain absolute path" >&2
  exit 2
fi
# Whether $1 is a positive decimal count of at most 16 digits.
is_count() {
  case "$1" in
    [1-9]*) [ -z "$(printf %s "$1" | tr -d 0-9)" ] && [ "${#1}" -le 16 ] ;;
    *) false ;;
  esac
}
if ! is_count "$SIZE" || ! is_count "$HEADROOM" || ! is_count "$FIRST_PINNED_LOOP" || { [ -n "$GROW_TO" ] && ! is_count "$GROW_TO"; }; then
  echo "SIZE, HEADROOM, FIRST_PINNED_LOOP and GROW_TO must be positive counts" >&2
  exit 2
fi
case "$EVICTION_PERCENT" in
  [1-9]|[1-9][0-9]) ;;
  *) echo "EVICTION_PERCENT must be a percentage from 1 to 99" >&2; exit 2 ;;
esac
file=$DIR/$VG.img

fail() {
  echo "__LOG_PREFIX__: $*" >&2
  exit 1
}

# LVM reports every descriptor above 2 it inherits: its tools run without the lock's.
without_lock() {
  "$@" 9>&-
}

# The one loop device over the backing file, found by device:inode, or nothing.
device() {
  devices=$(losetup -j "$file" -n -O NAME)
  case "$devices" in
    *"
"*) fail "$file is attached more than once:" $devices ;;
  esac
  printf '%s' "$devices"
}

backing() {
  [ ! -L "$file" ] || fail "$file is a symlink: refusing"
  [ -f "$file" ] || fail "$file is not a regular file"
  [ "$(stat -c %h "$file")" = 1 ] || fail "$file has other hard links: refusing"
}

# The block-device signature blkid finds in a file or device, empty for none.
signature() {
  rc=0
  found=$(blkid -p -s TYPE -o value "$1") || rc=$?
  case $rc in
    0) printf '%s' "$found" ;;
    2) ;;
    *) fail "blkid -p $1 failed ($rc)" ;;
  esac
}

# Whether the first 8 MiB (or all, when smaller) of $1, which is $2 bytes, are zero.
blank() {
  n=$2
  [ "$n" -le 8388608 ] || n=8388608
  cmp -s -n "$n" "$1" /dev/zero
}

# Whether $1 more bytes fit: what stays free must clear the kubelet's hard-eviction
# line, EVICTION_PERCENT of the filesystem rounded up, by HEADROOM.
room() {
  set -- "$1" $(df -B1 --output=size,avail "$DIR" | tail -n 1)
  [ "$#" = 3 ] && is_count "$2" && is_count "$3" || fail "cannot read the size and free space of $DIR"
  floor=$((($2 * EVICTION_PERCENT + 99) / 100 + HEADROOM))
  [ $(($3 - $1)) -ge "$floor" ] ||
    fail "taking $1 bytes would leave $(($3 - $1)) free on $DIR, below the floor of $floor ($EVICTION_PERCENT% of $2, where the kubelet evicts, plus $HEADROOM)"
}

# Minors from FIRST_PINNED_LOOP up are pinned coco disks; the group's device comes from the pool below.
pooled() {
  minor=${1#/dev/loop}
  case "$minor" in
    ''|*[!0-9]*) fail "$1 is not a loop device" ;;
  esac
  [ "$minor" -lt "$FIRST_PINNED_LOOP" ]
}

in_pool() {
  pooled "$1" || fail "$1 is among the minors pinned from /dev/loop$FIRST_PINNED_LOOP: refusing"
}

# Whether the file's mapping is gone within DETACH_WAIT seconds: losetup -d on a device that is
# still open (udev probes each new one) only marks it for release on its opener's last close.
DETACH_WAIT=10
detached() {
  waited=0
  while [ -n "$(device)" ]; do
    [ "$waited" -lt "$DETACH_WAIT" ] || return 1
    sleep 1
    waited=$((waited + 1))
  done
}

# Attaches the file at the lowest free minor. Other loop-device users do not take this lock, so
# that minor may be a pinned one although the preflight saw a free one below: it is detached
# before anything reads or writes it, and the attach is retried, ATTACH_ATTEMPTS times in all.
ATTACH_ATTEMPTS=3
attach() {
  attempt=1
  while :; do
    dev=$(losetup -f --show --nooverlap "$file")
    if pooled "$dev"; then return 0; fi
    [ "$(device)" = "$dev" ] || fail "$file is not attached at $dev alone: refusing to detach"
    losetup -d "$dev"
    detached || fail "$file stays attached at $dev $DETACH_WAIT seconds after detaching it: the kernel releases it when its last opener closes it"
    echo "__LOG_PREFIX__: $dev is among the minors pinned from /dev/loop$FIRST_PINNED_LOOP: detached it" >&2
    [ "$attempt" -lt "$ATTACH_ATTEMPTS" ] ||
      fail "no free minor below /dev/loop$FIRST_PINNED_LOOP after $ATTACH_ATTEMPTS attempts"
    attempt=$((attempt + 1))
    sleep 2
  done
}

# The openebs node plugin runs its own LVM, with its own lock directory, in its container:
# a metadata write from here does not serialize with its lvcreate, lvextend or lvremove.
grow_acknowledged() {
  [ "$GROW_TO" = "$SIZE" ] ||
    fail "growing $VG to $SIZE writes its metadata beside the openebs node plugin, whose LVM does not share this host's locks: declare GROW_TO=$SIZE while no LVMVolume is being created, resized or deleted"
}

# A new group needs a name no other device carries: this scan reads every device.
unclaimed() {
  names=$(without_lock vgs --noheadings -o vg_name)
  for name in $names; do
    [ "$name" != "$VG" ] || fail "a volume group named $VG already exists on another device"
  done
}

group_of() {
  found=$(without_lock pvs --devices "$1" --noheadings -o vg_name "$1")
  printf '%s' $found
}

only_device() {
  count=$(without_lock vgs --devices "$1" --noheadings -o pv_count "$VG")
  [ $count = 1 ] || fail "$VG spans other devices than $1"
}

# Whether the physical volume on $1 has at least one extent less than its device.
resize_pending() {
  sizes=$(without_lock pvs --devices "$1" --noheadings --units b --nosuffix -o dev_size,pv_size,pe_start,vg_extent_size "$1")
  set -- $sizes
  [ "$#" = 4 ] || fail "cannot read the physical volume sizes"
  [ $(($1 - $2 - $3)) -ge "$4" ]
}

check() {
  backing
  size=$(stat -c %s "$file")
  [ "$size" = "$SIZE" ] || fail "$file is $size bytes, declared $SIZE"
  dev=$(device)
  [ -n "$dev" ] || fail "$file is not attached"
  in_pool "$dev"
  devsize=$(blockdev --getsize64 "$dev")
  [ "$devsize" = "$SIZE" ] || fail "$dev is $devsize bytes, not $SIZE"
  vg=$(group_of "$dev")
  [ "$vg" = "$VG" ] || fail "$dev is not a physical volume of $VG"
  only_device "$dev"
  if resize_pending "$dev"; then
    fail "the physical volume on $dev is smaller than the device"
  fi
  echo "__LOG_PREFIX__: $VG on $dev over $file, $SIZE bytes"
}

apply() {
  umask 077
  mkdir -p "$DIR"
  exec 9>"$DIR/.lock"
  flock -x -w 300 9 || fail "another apply holds $DIR/.lock"

  fresh=yes current=0 dev=
  if [ -e "$file" ] || [ -L "$file" ]; then
    backing
    current=$(stat -c %s "$file")
    dev=$(device)
    [ "$current" -le "$SIZE" ] || fail "$file is $current bytes, above the declared $SIZE: refusing to shrink"
    type=$(signature "$file")
    case "$type" in
      '') blank "$file" "$current" || fail "$file has no signature but is not blank: refusing" ;;
      LVM2_member) fresh=no ;;
      *) fail "$file carries a $type signature: refusing" ;;
    esac
  fi
  [ "$fresh" = no ] || unclaimed
  if [ -n "$dev" ]; then
    in_pool "$dev"
  else
    next=$(losetup -f)
    in_pool "$next"
  fi

  if [ "$current" -lt "$SIZE" ]; then
    [ "$fresh" = yes ] || grow_acknowledged
    room $((SIZE - current))
    [ -e "$file" ] || (set -C; : > "$file")
    backing
    fallocate -l "$SIZE" "$file"
    echo "__LOG_PREFIX__: reserved $SIZE bytes for $file"
  fi

  if [ -z "$dev" ]; then
    attach
    echo "__LOG_PREFIX__: attached $file at $dev"
  fi
  again=$(device)
  [ "$again" = "$dev" ] || fail "$file is at ${again:-no device}, not $dev"
  devsize=$(blockdev --getsize64 "$dev")
  if [ "$devsize" != "$SIZE" ]; then
    losetup -c "$dev"
    devsize=$(blockdev --getsize64 "$dev")
    [ "$devsize" = "$SIZE" ] || fail "$dev did not take the size of $file"
  fi

  if [ "$fresh" = yes ]; then
    type=$(signature "$dev")
    [ -z "$type" ] && blank "$dev" "$SIZE" || fail "$dev is not blank: refusing to create a physical volume"
    without_lock pvcreate --devices "$dev" "$dev"
  fi
  vg=$(group_of "$dev")
  case "$vg" in
    '') unclaimed; without_lock vgcreate --devices "$dev" "$VG" "$dev" ;;
    "$VG") ;;
    *) fail "$dev belongs to volume group $vg" ;;
  esac
  only_device "$dev"
  if resize_pending "$dev"; then
    grow_acknowledged
    without_lock pvresize --devices "$dev" "$dev"
  fi
  without_lock vgchange --devices "$dev" -ay "$VG"
  check
}

case "${1:-}" in
  apply) apply ;;
  check) check ;;
  *) echo "usage: __LOG_PREFIX__.sh apply|check" >&2; exit 2 ;;
esac
