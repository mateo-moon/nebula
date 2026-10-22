#!/bin/sh
# Shared only by the storage runtime and its Linux test recipes. Run in a fresh
# digest-pinned Debian build stage, never on a host or a deployed guest.
set -eu
export DEBIAN_FRONTEND=noninteractive LC_ALL=C

version=2.8.8
source_sha256=3acfa685f2dd7fcc832e0b77bc7093aa7da554a51ce8dafbb4138eaa854eee35
source_url="https://www.kernel.org/pub/linux/utils/cryptsetup/v2.8/cryptsetup-$version.tar.xz"
recipe=/tmp/coco-storage-rootfs
build_dir=/tmp/coco-cryptsetup-build
test ! -e "$build_dir"
test -f "$recipe/debian.sources"
install -m 0644 "$recipe/debian.sources" /etc/apt/sources.list.d/debian.sources
test ! -e /etc/apt/sources.list
test "$(ls /etc/apt/sources.list.d)" = debian.sources

# Fixed snapshot, signed Debian metadata; no floating apt repositories. The
# pinned toolchain stage supplies bootstrap TLS roots until this installs the
# snapshot's ca-certificates package. These packages also serve provision.sh.
runtime_packages='ca-certificates dmsetup e2fsprogs util-linux mount libargon2-1 libblkid1 libdevmapper1.02.1 libjson-c5 libpopt0 libssl3 libudev1 libuuid1'
build_packages='build-essential curl pkg-config xz-utils libargon2-dev libblkid-dev libdevmapper-dev libjson-c-dev libpopt-dev libssl-dev libudev-dev uuid-dev'
apt-get update
# Intentional word splitting of the fixed package lists, not external input.
# shellcheck disable=SC2086
apt-get install -y --no-install-recommends $runtime_packages $build_packages

mkdir "$build_dir"
cd "$build_dir"
curl --fail --location --proto '=https' --tlsv1.2 --retry 3 "$source_url" -o source.tar.xz
printf '%s  source.tar.xz\n' "$source_sha256" | sha256sum --check --strict
mkdir source
tar -xJf source.tar.xz --strip-components=1 -C source
cd source
# Statically link our pinned libcryptsetup into the CLI, while using the
# snapshot's crypto/device libraries. No distro libcryptsetup can be selected
# at runtime. Keep Argon2 for the existing negative fixtures, not accepted disks.
./configure --prefix=/usr --sbindir=/usr/sbin --disable-shared --enable-static \
  --disable-asciidoc --disable-external-tokens --disable-ssh-token --enable-libargon2
make -j2
# Install only the runtime executable, not headers, static archives or build tools.
install -m 0755 cryptsetup /usr/sbin/cryptsetup
strip /usr/sbin/cryptsetup
mkdir -p /usr/share/doc/coco-cryptsetup/licenses
cp COPYING /usr/share/doc/coco-cryptsetup/
cp docs/licenses/COPYING.* /usr/share/doc/coco-cryptsetup/licenses/
# Carry the exact unmodified corresponding source and build recipe with the CLI.
cp ../source.tar.xz "/usr/share/doc/coco-cryptsetup/cryptsetup-$version.tar.xz"
cp "$recipe/build.sh" "$recipe/debian.sources" /usr/share/doc/coco-cryptsetup/
printf '%s  cryptsetup-%s.tar.xz\n' "$source_sha256" "$version" > /usr/share/doc/coco-cryptsetup/SHA256SUMS

# Fixed explicit build-package list; runtime libraries were installed manually
# above and survive autoremove. Only this disposable image is modified.
# shellcheck disable=SC2086
apt-get purge -y --auto-remove $build_packages
cryptsetup --version | grep '^cryptsetup 2\.8\.8 '
ldd /usr/sbin/cryptsetup > /tmp/coco-cryptsetup-linked
if grep -E 'libcryptsetup|not found' /tmp/coco-cryptsetup-linked; then exit 1; fi
test -x /usr/sbin/mkfs.ext4
test -x /usr/sbin/losetup
test -x /usr/sbin/dmsetup
test -x /usr/bin/mount
test -x /usr/bin/umount
if command -v cc; then exit 1; fi
cd /
rm -rf /tmp/coco-cryptsetup-build /tmp/coco-storage-rootfs /var/lib/apt/lists
rm /tmp/coco-cryptsetup-linked
