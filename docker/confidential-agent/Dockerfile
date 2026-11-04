FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS node
FROM rust:1.93.1-bookworm@sha256:1d33950f982ca6411f5e0ee4850be46e03f066f1a9efaeb41922a0e59497c9c2 AS toolchain
FROM toolchain AS native
RUN rustup target add x86_64-unknown-linux-musl
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld
WORKDIR /storage
COPY packages/confidential-storage/Cargo.toml packages/confidential-storage/Cargo.lock ./
COPY packages/confidential-storage/src ./src
COPY packages/confidential-storage/tests ./tests
RUN cargo test --locked --target x86_64-unknown-linux-musl -j 2 \
 && cargo build --release --locked --target x86_64-unknown-linux-musl -j 2 \
 && readelf --program-headers target/x86_64-unknown-linux-musl/release/nebula-confidential-storage > /tmp/launcher-headers \
 && ! grep -q INTERP /tmp/launcher-headers

FROM node AS build
WORKDIR /workspace/packages
COPY packages/nebula/package.json ./nebula/
COPY packages/nebula/src/core/base-construct.ts ./nebula/src/core/
COPY packages/nebula/src/utils/secrets.ts ./nebula/src/utils/
COPY packages/nebula/src/modules/k8s/confidential-guests ./nebula/src/modules/k8s/confidential-guests
COPY packages/nebula/src/modules/k8s/confidential-workloads ./nebula/src/modules/k8s/confidential-workloads
COPY packages/nebula/src/modules/k8s/trustee ./nebula/src/modules/k8s/trustee
COPY packages/nebula/src/modules/k8s/envoy/measured-fragments.ts ./nebula/src/modules/k8s/envoy/
COPY packages/confidential-client ./confidential-client
COPY packages/confidential-agent ./confidential-agent
RUN npm install -g pnpm@11.9.0 \
 && cd confidential-agent && pnpm install --frozen-lockfile \
 && pnpm typecheck && pnpm build

FROM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171
COPY --from=toolchain /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY docker/confidential-storage/rootfs/ /tmp/coco-storage-rootfs/
RUN /bin/sh /tmp/coco-storage-rootfs/build.sh
RUN apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends openssl nftables libstdc++6 libatomic1 zlib1g \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=native /storage/target/x86_64-unknown-linux-musl/release/nebula-confidential-storage /usr/local/bin/nebula-confidential-storage
WORKDIR /app
COPY --from=build /workspace/packages/confidential-agent/dist ./dist
COPY packages/confidential-agent/package.json ./
USER 10001:10001
ENTRYPOINT ["node", "--disable-sigusr1", "/app/dist/main.mjs"]
