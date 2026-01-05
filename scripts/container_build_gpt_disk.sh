#!/bin/sh
set -euo pipefail

# Args:
#   --usb PATH        Path to boot.usb (mounted inside container)
#   --out PATH        Output raw disk path (mounted inside container)
#   --disk-size SIZE  Total disk size (e.g., 1G)
#   --esp-size SIZE   ESP partition size (e.g., 64M)

USB=""
OUT=""
DISK_SIZE="5G"
ESP_SIZE="200M"

while [ $# -gt 0 ]; do
  case "$1" in
    --usb) USB="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --disk-size) DISK_SIZE="$2"; shift 2 ;;
    --esp-size) ESP_SIZE="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Convert size to MiB for truncate
DISK_MIB=$(python3 - <<PY
import re
s = "${DISK_SIZE}".upper()
m = re.match(r"(\d+)([MG]I?B?)?", s)
num = int(m.group(1))
unit = (m.group(2) or "M")
print(num if unit.startswith("M") else num*1024)
PY
)

echo "--- Creating sparse disk image (${DISK_SIZE}) ---"
truncate -s "${DISK_MIB}M" "$OUT"

echo "--- Partitioning ---"
# Force 1MiB alignment for all partitions to allow large block sizes in dd
sgdisk -og "$OUT"
sgdisk -n 1:2048:+$ESP_SIZE -t 1:EF00 -c 1:"ESP" "$OUT"
sgdisk -n 2:0:+8MiB -t 2:8300 -c 2:"OS" "$OUT"
sgdisk -n 3:0:0 -t 3:0700 -c 3:"DATA" "$OUT"

# Get start sectors
PART1_START=$(sgdisk -p "$OUT" | awk '/^   1/ {print $2}')
PART3_START=$(sgdisk -p "$OUT" | awk '/^   3/ {print $2}')

# Determine sizes in bytes
PART1_END=$(sgdisk -p "$OUT" | awk '/^   1/ {print $3}')
PART1_SIZE=$(( (PART1_END - PART1_START + 1) * 512 ))

PART3_END=$(sgdisk -p "$OUT" | awk '/^   3/ {print $3}')
PART3_SIZE=$(( (PART3_END - PART3_START + 1) * 512 ))

echo "--- Formatting ESP ---"
ESP_IMG=$(mktemp)
truncate -s "$PART1_SIZE" "$ESP_IMG"
mkfs.vfat -F 32 "$ESP_IMG" >/dev/null
# Copy iPXE files
mcopy -i "$USB" -s ::/* /tmp/ 2>/dev/null || true
mcopy -i "$ESP_IMG" -s /tmp/* ::/ 2>/dev/null || true

echo "--- Splicing ESP (DATA will be formatted on GCP) ---"
dd if="$ESP_IMG" of="$OUT" bs=1M seek=$((PART1_START / 2048)) conv=notrunc status=none

rm -f "$ESP_IMG"
echo "--- Build complete ---"
