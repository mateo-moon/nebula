set -eu
dir=/var/lib/sealed-disks
file=$dir/data-v1.img
device=/dev/loop123
size=1073741824
umask 077
exec 9>"$dir/provision.lock"
flock -x 9
[ ! -L "$file" ] || { echo 'refusing backing-file symlink'; exit 1; }
if [ ! -e "$file" ]; then
  # Noclobber fails if the path appeared after the existence check.
  (set -C; : > "$file")
  fallocate -l "$size" "$file"
fi
[ -f "$file" ] && [ "$(stat -c %s "$file")" = "$size" ] && [ "$(stat -c %h "$file")" = 1 ] || {
  echo 'refusing changed backing file'; exit 1;
}
if [ ! -e "$device" ]; then mknod "$device" b 7 123; fi
[ -b "$device" ] && [ ! -L "$device" ] && [ "$(stat -c '%t:%T' "$device")" = '7:7b' ] || {
  echo 'refusing wrong loop device'; exit 1;
}
# -j compares the actual backing file identity (device/inode), rather than
# d_path output, which changes when the previous helper mount namespace exits.
associated=$(losetup -j "$file" -n -O NAME)
current=$(losetup -n -O BACK-FILE "$device" 2>/dev/null || true)
if [ -n "$current" ]; then
  [ "$associated" = "$device" ] || { echo 'loop slot occupied; refusing'; exit 1; }
else
  [ -z "$associated" ] || { echo 'backing file attached elsewhere; refusing'; exit 1; }
  losetup "$device" "$file"
fi
[ "$(losetup -j "$file" -n -O NAME)" = "$device" ] || exit 1
# Pin the owned block-node metadata passed by CRI into the measured guest.
chown 0:6 "$device"
chmod 0660 "$device"
flock -u 9
echo 'dedicated retained 1Gi block volume ready'
while :; do sleep 60; done
