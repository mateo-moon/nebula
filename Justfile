all: build run

build:
	docker build --platform linux/amd64 -t qemu_machine .

run target="netboot.xyz":
  mkdir -p qemu
  docker run --platform linux/amd64 \
    -e HOSTNAME={{ target }} \
    -v ./qemu:/qemu \
    -v ./scripts/autoexec.ipxe:/qemu/autoexec.ipxe:ro \
    -v ./scripts/start_test_machine.sh:/qemu/start_test_machine.sh:ro \
    -p 2022:22 -p 9443 -p 6443 \
    -ti --rm --cap-add=SYS_ADMIN --privileged \
    qemu_machine

clean:
  rm -rf qemu
