FROM debian:stable-slim

RUN apt-get update && apt-get install -y \
    qemu-system-x86 \
    qemu-utils \
    qemu-kvm \
    wget \
    curl \
    dosfstools \
    netselect-apt

CMD ["/qemu/start_test_machine.sh"]
