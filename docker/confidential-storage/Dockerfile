FROM rust:1.93.1-bookworm@sha256:1d33950f982ca6411f5e0ee4850be46e03f066f1a9efaeb41922a0e59497c9c2 AS toolchain
FROM toolchain AS build
RUN rustup target add x86_64-unknown-linux-musl
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld
WORKDIR /storage
COPY packages/confidential-storage/Cargo.toml packages/confidential-storage/Cargo.lock ./
COPY packages/confidential-storage/src ./src
COPY packages/confidential-storage/tests ./tests
# The launcher is installed into arbitrary application images, so it must be static.
RUN cargo test --locked --target x86_64-unknown-linux-musl -j 2 \
 && cargo build --release --locked --target x86_64-unknown-linux-musl -j 2 \
 && readelf --program-headers target/x86_64-unknown-linux-musl/release/nebula-confidential-storage > /tmp/launcher-headers \
 && ! grep -q INTERP /tmp/launcher-headers
RUN cargo test --lib --locked --release --target x86_64-unknown-linux-musl --no-run -j 2 \
 && find target/x86_64-unknown-linux-musl/release/deps -maxdepth 1 -type f -executable -name 'nebula_confidential_storage-*' -exec cp '{}' /storage-tests \;

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS rootfs
COPY --from=toolchain /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY docker/confidential-storage/rootfs/ /tmp/coco-storage-rootfs/
RUN /bin/sh /tmp/coco-storage-rootfs/build.sh

FROM rootfs AS test
COPY --from=build /storage-tests /usr/local/bin/storage-tests
USER 65532:65532
ENV COCO_KEYSLOT_TEST=isolated-owned-file
ENTRYPOINT ["/usr/local/bin/storage-tests"]
CMD ["--ignored", "real_", "--test-threads=1"]

FROM rootfs AS runtime
COPY --from=build /storage/target/x86_64-unknown-linux-musl/release/nebula-confidential-storage /usr/local/bin/nebula-confidential-storage
COPY packages/confidential-storage/LICENSE /usr/share/doc/nebula-confidential-storage/LICENSE
ARG VCS_REF=unknown
LABEL org.opencontainers.image.revision=$VCS_REF
ENTRYPOINT ["/usr/local/bin/nebula-confidential-storage"]
