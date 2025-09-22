#!/usr/bin/env bash

set -euo pipefail

# Args:
#   --usb PATH        Path to boot.usb (mounted inside container)
#   --out PATH        Output raw disk path (mounted inside container)
#   --disk-size SIZE  Total disk size (e.g., 2G)
#   --esp-size SIZE   ESP partition size (e.g., 200M)

USB=""
OUT=""
DISK_SIZE="auto"
ESP_SIZE="64M"

while [ $# -gt 0 ]; do
  case "$1" in
    --usb) USB="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    --esp-size) ESP_SIZE="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 --usb /input/boot.usb --out /work/disk.raw [--disk-size 2G] [--esp-size 200M]"
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [ -z "$USB" ] || [ -z "$OUT" ]; then
  echo "--usb and --out are required" >&2
  exit 1
fi

# Determine disk size
if [ "$DISK_SIZE" = "auto" ]; then
  # Convert ESP_SIZE to MiB and add minimal overhead for OS partition and GPT slack
  DISK_MIB=$(python3 - <<PY
import re, sys
s = "${ESP_SIZE}".upper()
m = re.match(r"(\d+)([MG]I?B?)?", s)
num = int(m.group(1))
unit = (m.group(2) or "M")
esp_mib = num if unit.startswith("M") else num*1024
# Add 16 MiB overhead: 8 MiB tiny OS partition + 8 MiB alignment/slack
disk_mib = esp_mib + 16
print(disk_mib)
PY
)
  # Allocate non-sparse image (avoid GNU tar sparse headers)
  dd if=/dev/zero of="$OUT" bs=1M count="$DISK_MIB" status=none
else
  # Convert provided size to MiB for dd
  DISK_MIB=$(python3 - <<PY
import re
s = "${DISK_SIZE}".upper()
m = re.match(r"(\d+)([MG]I?B?)?", s)
num = int(m.group(1))
unit = (m.group(2) or "M")
print(num if unit.startswith("M") else num*1024)
PY
)
  dd if=/dev/zero of="$OUT" bs=1M count="$DISK_MIB" status=none
fi

if command -v sgdisk >/dev/null 2>&1; then
  sgdisk -og "$OUT"
  sgdisk -n 1:1MiB:+$ESP_SIZE -t 1:EF00 -c 1:"ESP" "$OUT"
  sgdisk -n 2:0:+8MiB -t 2:8300 -c 2:"OS" "$OUT"
else
  parted -s "$OUT" mklabel gpt
  esp_end=$(python3 - <<PY
import re
s="$ESP_SIZE".upper()
m=re.match(r"(\\d+)([MG]I?B?)", s)
size=int(m.group(1)); unit=m.group(2)
end = (size+1) if unit.startswith("M") else (size*1024+1)
print(f"{end}MiB")
PY
)
  parted -s "$OUT" mkpart ESP fat32 1MiB "$esp_end"
  parted -s "$OUT" set 1 esp on
  parted -s "$OUT" mkpart OS ext4 "$esp_end" "$(( $(echo "$esp_end" | sed 's/MiB//') + 8 ))MiB"
fi

# Determine ESP offsets in bytes
PART_INFO=$(parted -m -s "$OUT" unit B print | awk -F: '/^1:/{gsub(/B/,"",$2); gsub(/B/,"",$3); print $2, $3}')
read -r ESP_START ESP_END <<< "$PART_INFO"
ESP_SIZE_BYTES=$((ESP_END - ESP_START))

# Build a standalone FAT image for ESP and copy using mtools (no loop mounts)
ESP_IMG=$(mktemp)
truncate -s "$ESP_SIZE_BYTES" "$ESP_IMG"
mkfs.vfat -F 32 "$ESP_IMG"

TMP_SRC=$(mktemp -d)
# Copy contents from USB image to temp dir
mcopy -i "$USB" -s ::/* "$TMP_SRC"/ || true
mkdir -p "$TMP_SRC/EFI/BOOT"
# Copy from temp dir into ESP image
mcopy -i "$ESP_IMG" -s "$TMP_SRC"/* ::/ || true

# Write the ESP image into the disk at the correct offset
dd if="$ESP_IMG" of="$OUT" bs=1 seek="$ESP_START" conv=notrunc status=none

rm -rf "$TMP_SRC" "$ESP_IMG"

echo "disk.raw built at $OUT with GPT: ESP + OS (no loop devices used)"


