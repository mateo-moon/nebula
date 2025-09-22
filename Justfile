all: build run

build:
	docker build --platform linux/amd64 -t qemu_machine .

run target="netboot.xyz":
  mkdir -p qemu
  docker run --platform linux/amd64 \
    -e HOSTNAME={{ target }} \
    -v ./qemu:/qemu \
    -v ./scripts/autoexec.ipxe:/qemu/autoexec.ipxe:ro \
    -v ./scripts/build_boot_usb.sh:/qemu/build_boot_usb.sh:ro \
    -v ./scripts/start_test_machine.sh:/qemu/start_test_machine.sh:ro \
    -p 2022:22 -p 9443 -p 6443 \
    -ti --rm --cap-add=SYS_ADMIN --privileged \
    qemu_machine

clean:
  rm -rf qemu

# Build only the bootable USB image
usb target="netboot.xyz":
	mkdir -p qemu
	docker run --platform linux/amd64 \
	  -e HOSTNAME={{ target }} \
	  -v ./qemu:/qemu \
	  -v ./scripts/autoexec.ipxe:/qemu/autoexec.ipxe:ro \
	  -ti --rm --cap-add=SYS_ADMIN --privileged \
	  qemu_machine \
	  /usr/local/bin/build_boot_usb.sh --output /qemu/boot.usb --ipxe-efi /ipxe/ipxe.efi --autoexec /qemu/autoexec.ipxe --force

# Start the test machine (expects or recreates boot.usb)
start target="netboot.xyz":
	mkdir -p qemu
	docker run --platform linux/amd64 \
	  -e HOSTNAME={{ target }} \
	  -v ./qemu:/qemu \
	  -v ./scripts/autoexec.ipxe:/qemu/autoexec.ipxe:ro \
	  -v ./scripts/build_boot_usb.sh:/qemu/build_boot_usb.sh:ro \
	  -v ./scripts/start_test_machine.sh:/qemu/start_test_machine.sh:ro \
	  -p 2022:22 -p 9443 -p 6443 \
	  -ti --rm --cap-add=SYS_ADMIN --privileged \
	  qemu_machine

# Import GCP image from qemu/boot.usb
gcp-image image gcs project="" family="" description="" storage="us" disk_size="auto" esp_size="64M":
	./scripts/gcp_create_image_from_usb.sh \
	  --usb ./qemu/boot.usb \
	  --image-name "{{image}}" \
	  --gcs-uri "{{gcs}}" \
	  --project "{{project}}" \
	  --family "{{family}}" \
	  --description "{{description}}" \
	  --storage-location "{{storage}}" \
	  --disk-size "{{disk_size}}" \
	  --esp-size "{{esp_size}}" \
	  --force

# Env-driven image creation to avoid argument parsing issues
gcp-image-env:
	@if [ -z "$GCP_PROJECT" ] || [ -z "$GCS_URI" ] || [ -z "$IMAGE_NAME" ]; then \
	  echo "Set GCP_PROJECT, GCS_URI, IMAGE_NAME env vars."; exit 1; \
	fi
	./scripts/gcp_create_image_from_usb.sh \
	  --usb ./qemu/boot.usb \
	  --image-name "$IMAGE_NAME" \
	  --gcs-uri "$GCS_URI" \
	  --project "$GCP_PROJECT" \
	  --disk-size "${DISK_SIZE:-auto}" \
	  --esp-size "${ESP_SIZE:-64M}" \
	  --family "${IMAGE_FAMILY:-nebula}" \
	  --description "${IMAGE_DESC:-UEFI GPT (ESP+empty OS), minimal}" \
	  --storage-location "${IMAGE_STORAGE:-us}" \
	  --force
