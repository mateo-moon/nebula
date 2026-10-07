set -eu
# Loop-backed block devices for the portal VMs' PVs, one pair per VM.
#
# The spec comes from PORTAL_VOLUMES ("name:size:/dev/loopN ..."), generated
# from the same VM list that declares the PVs, so the device a PV names and the
# device this attaches can never drift apart.
#
# STOPGAP, and worth replacing: this cluster has no storage class able to
# provision block volumes since `dev-vg` was lost with the machine rebuild
# (vgs/pvs are empty, so openebs-lvm-localpv cannot allocate). The proper fix is
# to restore a volume group or provision a real block-capable class; until then
# these are sparse files on the node's root filesystem -- single node, no
# redundancy, no capacity accounting.
#
# Idempotent: creates each backing file only if absent, attaches only if not
# already attached, and NEVER truncates an existing file -- that would destroy a
# portal's RW partition and its workload's LUKS-formatted data disk.
mkdir -p /hostfs__BACKING_DIRECTORY__

# Mint the LOW pool the kubelet allocates from. It attaches its own mapping of
# every block PV with `losetup -f`, which takes the lowest free device -- so the
# pool has to exist, and our own devices have to sit above it. They do: the VM
# list pins them at 100+. Without that separation the kubelet eventually claims
# a number a PV is pinned to, and a VM ends up pointed at another VM's volume.
#
# Mint a pool of loop device nodes first. The kernel here caps auto-allocation
# at max_loop=8, but an explicit `losetup /dev/loopN` works past that once the
# node exists -- and the kubelet finds its own device with `losetup -f`, which
# only ever picks from nodes that already exist. Each VM burns FOUR: two for
# the backing files below, and two more for the kubelet's own mapping of those
# devices into the pod. Without the pool the second VM fails to start with
# "makeLoopDevice failed ... losetup -f ... exit status 1".
i=0
while [ "$i" -lt "$PORTAL_LOOP_POOL" ]; do
  [ -e "/hostfs/dev/loop$i" ] || chroot /hostfs mknod "/dev/loop$i" b 7 "$i"
  i=$((i + 1))
done
echo "__LOG_PREFIX__: loop node pool of $PORTAL_LOOP_POOL ready"

for spec in $PORTAL_VOLUMES; do
  name=${spec%%:*}; rest=${spec#*:}
  size=${rest%%:*}; want=${rest#*:}
  img=__BACKING_DIRECTORY__/pv-$name.img

  if [ ! -f "/hostfs$img" ]; then
    chroot /hostfs truncate -s "$size" "$img"
    echo "__LOG_PREFIX__: created $img ($size, sparse)"
  fi

  cur=$(chroot /hostfs losetup -j "$img" 2>/dev/null | cut -d: -f1 | head -1)
  if [ -n "$cur" ]; then
    [ "$cur" = "$want" ] || echo "__LOG_PREFIX__: WARNING $img is at $cur, PV expects $want"
    echo "__LOG_PREFIX__: $img already attached at $cur"
    continue
  fi

  # Pin the device number so the PV's local.path stays valid across reboots.
  [ -e "/hostfs$want" ] || chroot /hostfs mknod "$want" b 7 "${want##*loop}"
  # Refuse rather than continue if the device is taken: a PV pointing at
  # somebody else's backing file is how one VM ends up reading another's disk.
  taken=$(chroot /hostfs losetup "$want" 2>/dev/null | tail -1)
  if [ -n "$taken" ]; then
    echo "__LOG_PREFIX__: FATAL $want is already backed by something else ($taken), refusing to point $img at it" >&2
    exit 1
  fi
  if ! chroot /hostfs losetup "$want" "$img"; then
    echo "__LOG_PREFIX__: FATAL could not attach $img at $want" >&2
    exit 1
  fi
  echo "__LOG_PREFIX__: attached $img at $want"
done
