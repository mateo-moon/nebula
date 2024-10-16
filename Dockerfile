FROM debian:stable-slim

RUN apt-get update && apt-get install -y \
    qemu-system-x86 \
    qemu-utils \
    qemu-kvm \
    wget \
    curl \
    dosfstools \
    netselect-apt

COPY ./scripts/start_test_machine.sh /start_test_machine.sh
COPY ./scripts/autoexec.ipxe /autoexec.ipxe

CMD ["/start_test_machine.sh"]
