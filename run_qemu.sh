#!/usr/bin/env bash

mkdir -p qemu

docker build -t qemu_machine . && \
  docker run -v ./qemu:/qemu -v ./scripts/autoexec.ipxe:/qemu/autoexec.ipxe:ro \
  -v ./scripts/start_test_machine.sh:/qemu/start_test_machine.sh:ro \
  -ti --rm --cap-add=SYS_ADMIN --privileged \
  qemu_machine
