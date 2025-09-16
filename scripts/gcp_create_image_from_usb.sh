#!/usr/bin/env bash

set -o errexit
set -o errtrace
set -o nounset
set -o pipefail

SCRIPT_NAME="$(basename "$0")"

temp_dir=""

cleanup() {
  if [ -n "${temp_dir}" ] && [ -d "${temp_dir}" ]; then
    rm -rf "${temp_dir}" || true
  fi
}

error_handler() {
  local last_command="${BASH_COMMAND}"
  local exit_code="$?"
  echo -e "\033[0;31m${SCRIPT_NAME} failed: '${last_command}' exited with ${exit_code}.\033[0m" >&2
  cleanup
  exit "${exit_code}"
}

trap error_handler ERR
trap cleanup EXIT

usage() {
  cat <<EOF
Usage: ${SCRIPT_NAME} [options]

Options:
  --usb PATH                Path to boot.usb (default: ./qemu/boot.usb)
  --image-name NAME         Name of the GCE image to create (required)
  --gcs-uri URI             GCS URI prefix to upload tarball to, e.g. gs://my-bucket/images (required)
  --project PROJECT         GCP project ID (default: gcloud configured project)
  --family NAME             Optional image family
  --description TEXT        Optional image description
  --storage-location LOC    Image storage location (e.g., us, eu)
  --disk-size SIZE          Total disk size for GPT image (default: 2G)
  --esp-size SIZE           EFI System Partition size (default: 200M)
  --gpt                     Build a GPT disk with ESP+OS (default)
  --no-gpt                  Package usb as disk.raw without GPT (legacy behavior)
  --use-docker              Build GPT image inside qemu_machine container (default)
  --no-docker               Build GPT image on host (requires losetup, sfdisk, mkfs, mount)
  --local-only              Stop after creating local tarball (no upload/image create)
  --tarball-out PATH        Where to write the tarball when using --local-only
  --force                   Overwrite existing GCS object and delete existing image if present
  -h, --help                Show this help

Description:
  By default, constructs a GPT disk image with two partitions:
    1) ESP: FAT32 EFI System Partition populated with contents from boot.usb
    2) OS:  Empty partition for an OS that will run from ramfs
  The resulting raw disk is tarred (as 'disk.raw') and uploaded to GCS, then used to create a GCE image.

Example:
  ${SCRIPT_NAME} \
    --usb ./qemu/boot.usb \
    --image-name nebula-ipxe-efi \
    --gcs-uri gs://my-bucket/nebula/images \
    --project my-gcp-project \
    --family nebula \
    --description "iPXE UEFI boot image" \
    --force
EOF
}

USB_PATH="./qemu/boot.usb"
IMAGE_NAME=""
GCS_URI_PREFIX=""
PROJECT_ID=""
IMAGE_FAMILY=""
IMAGE_DESCRIPTION=""
STORAGE_LOCATION=""
DISK_SIZE="2G"
ESP_SIZE="200M"
USE_GPT="true"
USE_DOCKER="true"
LOCAL_ONLY="false"
TARBALL_OUT=""
FORCE="false"

while [ $# -gt 0 ]; do
  case "$1" in
    --usb)
      USB_PATH="$2"; shift 2 ;;
    --image-name)
      IMAGE_NAME="$2"; shift 2 ;;
    --gcs-uri)
      GCS_URI_PREFIX="$2"; shift 2 ;;
    --project)
      PROJECT_ID="$2"; shift 2 ;;
    --family)
      IMAGE_FAMILY="$2"; shift 2 ;;
    --description)
      IMAGE_DESCRIPTION="$2"; shift 2 ;;
    --storage-location)
      STORAGE_LOCATION="$2"; shift 2 ;;
    --disk-size)
      DISK_SIZE="$2"; shift 2 ;;
    --esp-size)
      ESP_SIZE="$2"; shift 2 ;;
    --gpt)
      USE_GPT="true"; shift ;;
    --no-gpt)
      USE_GPT="false"; shift ;;
    --use-docker)
      USE_DOCKER="true"; shift ;;
    --no-docker)
      USE_DOCKER="false"; shift ;;
    --local-only)
      LOCAL_ONLY="true"; shift ;;
    --tarball-out)
      TARBALL_OUT="$2"; shift 2 ;;
    --force)
      FORCE="true"; shift ;;
    -h|--help)
      usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage; exit 1 ;;
  esac
done

if [ -z "${IMAGE_NAME}" ]; then
  echo "--image-name is required." >&2
  usage
  exit 1
fi

if [ "${LOCAL_ONLY}" != "true" ] && [ -z "${GCS_URI_PREFIX}" ]; then
  echo "--gcs-uri is required unless --local-only is used." >&2
  usage
  exit 1
fi

if [ ! -f "${USB_PATH}" ]; then
  echo "USB image not found at ${USB_PATH}" >&2
  exit 1
fi

if [ "${LOCAL_ONLY}" != "true" ]; then
  if ! command -v gcloud >/dev/null 2>&1; then
    echo "gcloud CLI is required. Install and authenticate first." >&2
    exit 1
  fi
  if ! command -v gsutil >/dev/null 2>&1; then
    echo "gsutil is required (usually installed with gcloud)." >&2
    exit 1
  fi
fi

if [ "${LOCAL_ONLY}" != "true" ]; then
  if [ -z "${PROJECT_ID}" ]; then
    PROJECT_ID="$(gcloud config get-value project 2>/dev/null || true)"
  fi
  if [ -z "${PROJECT_ID}" ]; then
    echo "No GCP project set. Provide --project or run 'gcloud config set project <PROJECT>'" >&2
    exit 1
  fi
fi

# Normalize GCS URI (no trailing slash)
GCS_URI_PREFIX="${GCS_URI_PREFIX%/}"

temp_dir="$(mktemp -d)"

echo "Preparing disk.raw..."

# Resolve absolute path for USB to mount into Docker
resolve_abs() {
  python3 - "$1" <<'PY'
import os, sys
p = sys.argv[1]
print(os.path.realpath(p))
PY
}

USB_ABS_PATH="$(resolve_abs "${USB_PATH}")"

if [ "${USE_GPT}" = "true" ]; then
  echo "Building GPT disk with ESP=${ESP_SIZE}, total size=${DISK_SIZE} (USE_DOCKER=${USE_DOCKER})"
  if [ "${USE_DOCKER}" = "true" ]; then
    docker run --platform linux/amd64 --privileged \
      -v "${temp_dir}:/work" \
      -v "${USB_ABS_PATH}:/input/boot.usb:ro" \
      -ti --rm qemu_machine \
      /usr/local/bin/container_build_gpt_disk.sh \
        --usb /input/boot.usb \
        --out /work/disk.raw \
        --disk-size "${DISK_SIZE}" \
        --esp-size "${ESP_SIZE}"
  else
    echo "Host GPT build not implemented; rerun with --use-docker (default)" >&2
    exit 1
  fi
else
  echo "Legacy mode: copying USB image to disk.raw"
  cp "${USB_PATH}" "${temp_dir}/disk.raw"
fi

echo "Creating tarball from disk.raw..."
TARBALL_NAME="${IMAGE_NAME}.tar.gz"
TARBALL_PATH="${temp_dir}/${TARBALL_NAME}"
# Package using Linux tar inside the container to ensure a GCE-compatible archive
docker run --platform linux/amd64 --rm \
  -v "${temp_dir}:/work" \
  qemu_machine bash -lc "tar -C /work -czf /work/${TARBALL_NAME} disk.raw"

if [ "${LOCAL_ONLY}" = "true" ]; then
  if [ -n "${TARBALL_OUT}" ]; then
    mkdir -p "$(dirname "${TARBALL_OUT}")"
    cp -f "${TARBALL_PATH}" "${TARBALL_OUT}"
    echo "Local tarball written to: ${TARBALL_OUT}"
  else
    echo "Local tarball created at: ${TARBALL_PATH}"
  fi
  exit 0
fi

DEST_URI="${GCS_URI_PREFIX}/${TARBALL_NAME}"

echo "Uploading to ${DEST_URI}..."
if gsutil -q stat "${DEST_URI}"; then
  if [ "${FORCE}" != "true" ]; then
    echo "GCS object already exists at ${DEST_URI}. Use --force to overwrite." >&2
    exit 1
  fi
  gsutil -m -q rm "${DEST_URI}" || true
fi
gsutil -m cp "${TARBALL_PATH}" "${DEST_URI}"

# If image exists and --force, delete it
if gcloud --project="${PROJECT_ID}" compute images describe "${IMAGE_NAME}" --format='get(name)' >/dev/null 2>&1; then
  if [ "${FORCE}" = "true" ]; then
    echo "Existing image ${IMAGE_NAME} found. Deleting (force)..."
    gcloud --project="${PROJECT_ID}" --quiet compute images delete "${IMAGE_NAME}"
  else
    echo "Image ${IMAGE_NAME} already exists. Use --force to replace it." >&2
    exit 1
  fi
fi

echo "Creating GCE image ${IMAGE_NAME} from ${DEST_URI}..."
create_args=(
  compute images create "${IMAGE_NAME}"
  "--source-uri=${DEST_URI}"
  "--guest-os-features=UEFI_COMPATIBLE"
)

if [ -n "${PROJECT_ID}" ]; then
  create_args+=("--project=${PROJECT_ID}")
fi

if [ -n "${IMAGE_FAMILY}" ]; then
  create_args+=("--family=${IMAGE_FAMILY}")
fi

if [ -n "${IMAGE_DESCRIPTION}" ]; then
  create_args+=("--description=${IMAGE_DESCRIPTION}")
fi

if [ -n "${STORAGE_LOCATION}" ]; then
  create_args+=("--storage-location=${STORAGE_LOCATION}")
fi

gcloud "${create_args[@]}"

echo "Image ${IMAGE_NAME} created successfully in project ${PROJECT_ID}. Source: ${DEST_URI}"


