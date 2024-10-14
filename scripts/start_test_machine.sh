#!/usr/bin/env bash

set -o errexit      # Exit on first non-zero exit code
set -o errtrace     # Allow trap on ERR within functions and subshells
set -o nounset      # Exit for any uninitialised variables

error_handler() {
  # Retrieve the last executed command and its exit status
  local last_command="${BASH_COMMAND}"
  local exit_code="$?"

    # Define red color start and reset end
    red='\033[0;31m'
    reset='\033[0m'
    # Output the error details using values stored within temporary file.
    echo -e "${red}Error in script at line $(caller)${reset}"
    echo -e "${red}The command '${last_command}' failed with exit code ${exit_code}.${reset}"

    hdiutil eject $DISK
    exit "${exit_code}"
  }

trap error_handler ERR

# check if qemu-system-x86_64 is installed
QEMU_BIN=$(which qemu-system-x86_64)
if [ -z $QEMU_BIN ]; then
  echo "qemu-system-x86_64 not found"
  exit 1
fi

# qemu-system-x86_64 version
QEMU_VERSION=$($QEMU_BIN --version | egrep -o '[0-9]+\.[0-9]+\.[0-9]+' | tr '\n' '\0')

# get the path to the edk2 image for later use in UEFI boot
OS=$(uname -s)
case $OS in
  Darwin)
    QEMU_EDK2_CODE="/opt/homebrew/Cellar/qemu/${QEMU_VERSION}/share/qemu/edk2-x86_64-code.fd"
    ;;
  Linux)
    QEMU_EDK2_CODE="/usr/share/qemu/edk2-x86_64-code.fd"
    ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

TMP_DIR="$(pwd)/qemu"
mkdir -p $TMP_DIR

# Create UEFI variables file
QEMU_UEFI_VARS="${TMP_DIR}/x86_uefi_vars.raw"
if [ ! -f $QEMU_UEFI_VARS ]; then
  dd if=/dev/zero of=$QEMU_UEFI_VARS bs=1M count=4
fi

#Create a disk image
QEMU_DISK_IMAGE="${TMP_DIR}/disk.raw"
if [ ! -f $QEMU_DISK_IMAGE ]; then
  mkfile -n 3g $QEMU_DISK_IMAGE
fi

# Download ipxe image
wget -nc -P "${TMP_DIR}" http://boot.ipxe.org/ipxe.efi

# Create a bootable USB drive
mkfile -n 200M "${TMP_DIR}/boot.usb"
DISK="$(hdiutil attach -noverify -nomount -imagekey diskimage-class=CRawDiskImage ${TMP_DIR}/boot.usb | cut -f 1 -d ' ' | head -1)"
if [ $? -ne 0 ]; then
  echo "Failed to attach"
  exit 1
fi
diskutil eraseDisk FAT32 IPXE_BOOT $DISK
hdiutil eject $DISK
MOUNT_DIR="${TMP_DIR}/efi"
mkdir -p $MOUNT_DIR
hdiutil attach -noverify -mountpoint $MOUNT_DIR -imagekey diskimage-class=CRawDiskImage "${TMP_DIR}/boot.usb"
mkdir -p "${MOUNT_DIR}/EFI/BOOT/"
cp "${TMP_DIR}/ipxe.efi" "${MOUNT_DIR}/EFI/BOOT/bootx64.efi"
# the name of the script SHOULD BE autoexec.ipxe
cp "scripts/autoexec.ipxe" "${MOUNT_DIR}/EFI/BOOT/"
hdiutil eject $DISK

args=(
  # create flash hardware with UEFI image and flash with UEFI variables
  -drive if=pflash,format=raw,unit=0,readonly=on,file="$QEMU_EDK2_CODE" -drive if=pflash,format=raw,unit=1,file="$QEMU_UEFI_VARS"

  # create network device with user mode network stack and open port 2222 on host machine to point to ssh of a guest
  # create hardware random number generator and connect it to the guest(required for some OSes to boot)
  -device rtl8139,netdev=mynet0 -netdev user,id=mynet0,hostfwd=tcp::2222-:22 -smbios type=0,uefi=on -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0

  # bootload IPXE with autoexec.ipxe script
  -usb -usbdevice disk:raw:"${TMP_DIR}/boot.usb"
  # attach a disk image to the guest
  -drive format=raw,file=$QEMU_DISK_IMAGE
  # ATTENTION `nographic` mode requires 'console=ttyS0,115200n8' in the kernel command line
  -nographic
)

$QEMU_BIN -name test -machine pc -cpu max -smp 2 -m 4096 "${args[@]}"
