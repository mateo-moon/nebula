#!/usr/bin/env bash

set -o errexit      # Exit on first non-zero exit code
set -o errtrace     # Allow trap on ERR within functions and subshells
set -o nounset      # Exit for any uninitialised variables

error_handler() {
  local exit_code="$1" last_command="$2" line="$3"
  printf "Command '%s' failed at line %s with exit code %s.\n" "${last_command}" "${line}" "${exit_code}" >&2
  exit "${exit_code}"
}

trap 'error_handler "$?" "$BASH_COMMAND" "$LINENO"' ERR

# check if qemu-system-x86_64 is installed
if ! QEMU_BIN=$(command -v qemu-system-x86_64); then
  echo "qemu-system-x86_64 not found" >&2
  exit 1
fi

TMP_DIR="$(pwd)/qemu"
mkdir -p "$TMP_DIR"

# get the path to the edk2 image for later use in UEFI boot
QEMU_EDK2_PATH="/usr/share/qemu/OVMF.fd"
QEMU_EDK2_CODE="${TMP_DIR}/OVMF_CODE.fd"
if [ ! -f "$QEMU_EDK2_CODE" ]; then
  cp "$QEMU_EDK2_PATH" "$QEMU_EDK2_CODE"
fi

# Create UEFI variables file
QEMU_UEFI_VARS="${TMP_DIR}/x86_uefi_vars.raw"
if [ ! -f "$QEMU_UEFI_VARS" ]; then
  dd if=/dev/zero of="$QEMU_UEFI_VARS" bs=1M count=4
fi

#Create a disk image
QEMU_DISK_IMAGE="${TMP_DIR}/disk.raw"
if [ ! -f "$QEMU_DISK_IMAGE" ]; then
  fallocate -l 5g "$QEMU_DISK_IMAGE"
fi

# Create bootable USB via helper script
BOOT_USB_IMAGE="${TMP_DIR}/boot.usb"
IPXE_EFI_SOURCE="/ipxe/ipxe.efi"
AUTOEXEC_SOURCE="/qemu/autoexec.ipxe"

"$(dirname "$0")/build_boot_usb.sh" \
  --output "${BOOT_USB_IMAGE}" \
  --ipxe-efi "${IPXE_EFI_SOURCE}" \
  --autoexec "${AUTOEXEC_SOURCE}" \
  --force

args=(
  # create flash hardware with UEFI image and flash with UEFI variables
  -drive "if=pflash,format=raw,unit=0,file=$QEMU_EDK2_CODE" -drive "if=pflash,format=raw,unit=1,file=$QEMU_UEFI_VARS"

  # create network device with user mode network stack and open port 22 on host machine to point to ssh of a guest
  -device "rtl8139,netdev=mynet0" -netdev "user,id=mynet0,hostfwd=tcp::22-:22,hostname=${HOSTNAME:=qemu}"
  # create hardware random number generator and connect it to the guest(required for some OSes to boot)
  -smbios "type=0,uefi=on" -object "rng-random,filename=/dev/urandom,id=rng0" -device "virtio-rng-pci,rng=rng0"

  # bootload IPXE with autoexec.ipxe script
  -drive "if=none,id=usbstick,format=raw,file=${TMP_DIR}/boot.usb"
  -usb
  -device "usb-ehci,id=ehci"
  -device "usb-tablet,bus=usb-bus.0"
  -device "usb-storage,bus=ehci.0,drive=usbstick"

  # attach a disk image to the guest
  -drive "format=raw,file=$QEMU_DISK_IMAGE"

  # ATTENTION `nographic` mode requires 'console=ttyS0,115200n8' in the kernel command line
  -nographic
)

exec "$QEMU_BIN" -name test -machine pc -cpu max -smp 4 -m 8G "${args[@]}"
