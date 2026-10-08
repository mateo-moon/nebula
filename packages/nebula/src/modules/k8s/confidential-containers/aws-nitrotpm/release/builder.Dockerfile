# Build on the guest distribution: the binaries must run with its glibc/OpenSSL.
FROM --platform=linux/amd64 rust@sha256:c49256cbe5ea0188bc658a689500d70c41eb51f009a7a7be209caf60a944f3ec AS rust
FROM --platform=linux/amd64 golang@sha256:659cc38c1a394eeb4dd7e31fff6df128bd33444dcc7afd70e3bed5225749dbc0 AS go
FROM --platform=linux/amd64 public.ecr.aws/amazonlinux/amazonlinux@sha256:3552faf41b70d5b123fc33d4429a259baa2bcf9aa6ab15c70ad6da40fd63d247
ENV CARGO_HOME=/opt/cargo RUSTUP_HOME=/opt/rustup PATH=/opt/cargo/bin:/usr/local/go/bin:$PATH
COPY --from=rust /usr/local/cargo /opt/cargo
COPY --from=rust /usr/local/rustup /opt/rustup
RUN dnf --releasever=2023.12.20260930 install -y \
    kiwi-cli python3-kiwi kiwi-systemdeps-core python3-poetry-core qemu-img veritysetup erofs-utils \
    git aws-nitro-tpm-tools gcc gcc-c++ make cmake clang pkgconfig openssl-devel libseccomp-devel tpm2-tss-devel \
    protobuf-compiler protobuf-devel e2fsprogs util-linux sudo gzip tar xz findutils diffutils \
    python3.12 python3.12-pip curl-minimal && dnf clean all
RUN rustc --version && cargo --version
RUN dnf --releasever=2023.12.20260930 install -y perl-core && dnf clean all
RUN dnf --releasever=2023.12.20260930 install -y skopeo && dnf clean all
COPY --from=go /usr/local/go /usr/local/go
WORKDIR /build
