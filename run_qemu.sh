#!/usr/bin/env bash

# Check if exactly one argument is passed
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <config>"
    echo "Example: $0 debian"
    exit 1
fi

# Argument as the file name
config="$1"

# Check if the config file exists in the directory
config_dir="config"
if [ ! -f "$config_dir/$config" ]; then
    echo "Config for '$config' does not exist in the directory '$config_dir'."
    exit 1
fi

# Check if the autoexec file exists in the directory
scripts_dir="scripts"
if [ ! -f "$scripts_dir/${config}.ipxe" ]; then
    echo "IPXE for '$config' does not exist in the directory '$scripts_dir'."
    exit 1
fi

mkdir -p qemu

docker build -t qemu_machine . && \
  docker run -e CONFIG=${config} \
  -v ./qemu:/qemu -v ./scripts/${config}.ipxe:/qemu/autoexec.ipxe:ro \
  -v ./scripts/start_test_machine.sh:/qemu/start_test_machine.sh:ro \
  -ti --rm --cap-add=SYS_ADMIN --privileged \
  qemu_machine
