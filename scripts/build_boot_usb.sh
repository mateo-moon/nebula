#!/usr/bin/env bash

set -o errexit
set -o errtrace
set -o nounset
set -o pipefail

cleanup_mount() {
  local mount_dir="${1:-}"
  if [ -n "${mount_dir}" ] && mount | grep -q " on ${mount_dir} "; then
    umount "${mount_dir}" || true
  fi
}

error_handler() {
  local last_command="${BASH_COMMAND}"
  local exit_code="$?"
  echo -e "\033[0;31mUSB build failed. Command '${last_command}' exited with ${exit_code}.\033[0m"
  cleanup_mount "${MOUNT_DIR:-}"
  exit "${exit_code}"
}

trap error_handler ERR

usage() {
  cat <<EOF
Usage: $(basename "$0") [options]

Options:
  --output PATH         Output USB image path (e.g., /tmp/boot.usb)
  --ipxe-efi PATH       Path to ipxe.efi binary to embed as EFI bootloader
  --autoexec PATH       Path to autoexec.ipxe to copy alongside bootx64.efi
  --size SIZE           Image size (default: 200M)
  --mount-dir PATH      Temporary mount directory (default: <output_dir>/efi)
  --force               Overwrite existing output image
  -h, --help            Show this help

Example:
  $(basename "$0") --output ./qemu/boot.usb --ipxe-efi /ipxe/ipxe.efi --autoexec /qemu/autoexec.ipxe
EOF
}

OUTPUT=""
IPXE_EFI=""
AUTOEXEC=""
SIZE="200M"
MOUNT_DIR=""
FORCE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --output)
      OUTPUT="$2"; shift 2 ;;
    --ipxe-efi)
      IPXE_EFI="$2"; shift 2 ;;
    --autoexec)
      AUTOEXEC="$2"; shift 2 ;;
    --size)
      SIZE="$2"; shift 2 ;;
    --mount-dir)
      MOUNT_DIR="$2"; shift 2 ;;
    --force)
      FORCE="true"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage; exit 1 ;;
  esac
done

if [ -z "${OUTPUT}" ] || [ -z "${IPXE_EFI}" ] || [ -z "${AUTOEXEC}" ]; then
  echo "Missing required arguments." >&2
  usage
  exit 1
fi

if [ ! -f "${IPXE_EFI}" ]; then
  echo "ipxe.efi not found at ${IPXE_EFI}" >&2
  exit 1
fi

if [ ! -f "${AUTOEXEC}" ]; then
  echo "autoexec.ipxe not found at ${AUTOEXEC}" >&2
  exit 1
fi

OUTPUT_DIR="$(dirname "${OUTPUT}")"
mkdir -p "${OUTPUT_DIR}"

if [ -f "${OUTPUT}" ] && [ "${FORCE}" != "true" ]; then
  echo "Output file ${OUTPUT} already exists. Use --force to overwrite." >&2
  exit 1
fi

# Create/truncate image file
if command -v fallocate >/dev/null 2>&1; then
  fallocate -l "${SIZE}" "${OUTPUT}"
else
  # Fallback to dd if fallocate not available
  dd if=/dev/zero of="${OUTPUT}" bs=1 count=0 seek="${SIZE}"
fi

# Make FAT32 filesystem
if command -v mkfs.fat >/dev/null 2>&1; then
  mkfs.fat -F 32 "${OUTPUT}"
elif command -v mkfs.vfat >/dev/null 2>&1; then
  mkfs.vfat -F 32 "${OUTPUT}"
elif command -v newfs_msdos >/dev/null 2>&1; then
  newfs_msdos -F 32 "${OUTPUT}"
else
  echo "No FAT32 formatter found (mkfs.fat, mkfs.vfat, or newfs_msdos)." >&2
  exit 1
fi

# Determine mount dir
if [ -z "${MOUNT_DIR}" ]; then
  MOUNT_DIR="${OUTPUT_DIR}/efi"
fi
mkdir -p "${MOUNT_DIR}"

# Mount loopback (Linux); macOS loop mounts are not supported by this script
mount -m -o loop "${OUTPUT}" "${MOUNT_DIR}"

# Prepare EFI structure and copy files
mkdir -p "${MOUNT_DIR}/EFI/BOOT"
cp "${IPXE_EFI}" "${MOUNT_DIR}/EFI/BOOT/bootx64.efi"
cp "${AUTOEXEC}" "${MOUNT_DIR}/EFI/BOOT/autoexec.ipxe"

sync
umount "${MOUNT_DIR}"

echo "Bootable iPXE USB image created at: ${OUTPUT}"


