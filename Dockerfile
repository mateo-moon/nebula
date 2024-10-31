FROM debian:stable-slim AS ipxe_builder

RUN apt update && apt install -y \
    git \
    gcc \
    make \
    binutils \
    perl \
    mtools

# Clone iPXE repository and build the EFI image with HTTPS support
RUN git clone https://github.com/ipxe/ipxe.git /ipxe
RUN cd /ipxe/src && \
      sed -i '/DOWNLOAD_PROTO_HTTPS/ s/undef/define/' config/general.h && \
      make bin-x86_64-efi/ipxe.efi

FROM debian:stable-slim

RUN apt-get update && apt-get install -y \
    qemu-system-x86 \
    qemu-utils \
    qemu-kvm \
    wget \
    curl \
    dosfstools \
    netselect-apt

COPY --from=ipxe_builder /ipxe/src/bin-x86_64-efi/ipxe.efi /ipxe/ipxe.efi

EXPOSE 22 8133 8132 9443 6443 

CMD ["/qemu/start_test_machine.sh"]
