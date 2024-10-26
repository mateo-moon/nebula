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

    umount $MOUNT_DIR
    exit "${exit_code}"
  }

trap error_handler ERR

# Directory to search in
directory="/qemu"

# Check if exactly one argument is passed
if [ -z "$CONFIG" ]; then
    echo "No CONFIG is set. Set it to corresponding config"
    exit 1
fi

# Argument as the file name
config="$CONFIG"

# Check if the file exists in the directory
if [ -n "$directory/$config" ] && [ -n "$directory/${config}.ipxe" ]; then
    echo "Config for '$config' does not exist in the directory '$directory'."
fi

# check if qemu-system-x86_64 is installed
QEMU_BIN=$(which qemu-system-x86_64)
if [ -z $QEMU_BIN ]; then
  echo "qemu-system-x86_64 not found"
  exit 1
fi

TMP_DIR="$(pwd)/qemu"
mkdir -p $TMP_DIR

# get the path to the edk2 image for later use in UEFI boot
QEMU_EDK2_PATH="/usr/share/qemu/OVMF.fd"
QEMU_EDK2_CODE="${TMP_DIR}/OVMF_CODE.fd"
if [ ! -f $QEMU_EDK2_CODE ]; then
  cp $QEMU_EDK2_PATH $QEMU_EDK2_CODE
fi

# Create UEFI variables file
QEMU_UEFI_VARS="${TMP_DIR}/x86_uefi_vars.raw"
if [ ! -f $QEMU_UEFI_VARS ]; then
  dd if=/dev/zero of=$QEMU_UEFI_VARS bs=1M count=4
fi

#Create a disk image
QEMU_DISK_IMAGE="${TMP_DIR}/disk.raw"
if [ ! -f $QEMU_DISK_IMAGE ]; then
  fallocate -l 5g $QEMU_DISK_IMAGE
fi

# Download ipxe image
wget -nc -P "${TMP_DIR}" http://boot.ipxe.org/ipxe.efi

# cd /tmp && wget -O netselect-apt.deb http://snapshot.debian.org/archive/debian/20230226T084744Z/pool/main/n/netselect/netselect-apt_0.3.ds1-30.1_all.deb && ar x netselect-apt.deb && unxz data.tar.xz && tar -xvf data.tar && chmod +x usr/bin/netselect-apt && sed -i "s/MIRROR_PLACEHOLDER/$(usr/bin/netselect-apt | awk 'NR==2 {print; exit}' | awk -F[/:] '{print $4}')/g" /var/lib/cdebconf/questions.dat

# Create a bootable USB drive
fallocate -l 200M "${TMP_DIR}/boot.usb"
mkfs.fat -F 32 "${TMP_DIR}/boot.usb"
MOUNT_DIR="${TMP_DIR}/efi"
mount -m -o loop "${TMP_DIR}/boot.usb" $MOUNT_DIR
mkdir -p "${MOUNT_DIR}/EFI/BOOT/"
cp "${TMP_DIR}/ipxe.efi" "${MOUNT_DIR}/EFI/BOOT/bootx64.efi"
# the name of the script SHOULD BE autoexec.ipxe
cp "/qemu/autoexec.ipxe" "${MOUNT_DIR}/EFI/BOOT/"
umount $MOUNT_DIR

args=(
  # create flash hardware with UEFI image and flash with UEFI variables
  -drive if=pflash,format=raw,unit=0,file="$QEMU_EDK2_CODE" -drive if=pflash,format=raw,unit=1,file="$QEMU_UEFI_VARS"

  # create network device with user mode network stack and open port 2222 on host machine to point to ssh of a guest
  -device rtl8139,netdev=mynet0 -netdev user,id=mynet0,hostfwd=tcp::22-:22,hostname=${config}
  # create hardware random number generator and connect it to the guest(required for some OSes to boot)
  -smbios type=0,uefi=on -object rng-random,filename=/dev/urandom,id=rng0 -device virtio-rng-pci,rng=rng0

  # bootload IPXE with autoexec.ipxe script
  -drive if=none,id=usbstick,format=raw,file="${TMP_DIR}/boot.usb" \
  -usb                                                             \
  -device usb-ehci,id=ehci                                         \
  -device usb-tablet,bus=usb-bus.0                                 \
  -device usb-storage,bus=ehci.0,drive=usbstick

  # attach a disk image to the guest
  -drive format=raw,file=$QEMU_DISK_IMAGE

  # ATTENTION `nographic` mode requires 'console=ttyS0,115200n8' in the kernel command line
  -nographic
)

exec $QEMU_BIN -name test -machine pc -cpu max -smp 4 -m 8G "${args[@]}"
