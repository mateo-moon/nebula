FROM ghcr.io/mateo-moon/nebula-cmp:1b67ec0@sha256:27ae309e158862e821f6de6ea7e91803d020bca81fa9e1d1ae826359fea76446 AS tools
FROM ghcr.io/mateo-moon/nebula-coco-canary@sha256:d5ce9a63e43bd8c81336ae8557b32009138d950b6f1aa5f189ce9c872e62eb1d AS keyprovider
FROM ghcr.io/mateo-moon/nebula-coco-canary@sha256:5468f55e9636184cce37cb2213bad9e4ab2bac21fe2c9d9d34ef69ae15ea52ba AS skopeo

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /workspace/packages
COPY packages/nebula ./nebula
COPY packages/confidential-client ./confidential-client
COPY packages/confidential-runtime ./confidential-runtime
COPY packages/confidential-browser ./confidential-browser
RUN npm install -g pnpm@11.9.0 \
    && cd confidential-browser && pnpm install --frozen-lockfile \
    && pnpm typecheck && pnpm build

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl musl \
    && rm -rf /var/lib/apt/lists/* \
    && printf '%s' '{"key-providers":{"attestation-agent":{"grpc":"127.0.0.1:50000"}}}' > /etc/ocicrypt.conf
COPY --from=tools /usr/local/bin/genpolicy /usr/local/bin/genpolicy
COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm
COPY --from=keyprovider /coco_keyprovider /usr/local/bin/coco_keyprovider
COPY --from=skopeo /skopeo /usr/local/bin/skopeo
WORKDIR /app
COPY --from=build /workspace/packages/confidential-browser/dist ./dist
USER 10001:10001
ENV HOME=/tmp OCICRYPT_KEYPROVIDER_CONFIG=/etc/ocicrypt.conf
ENTRYPOINT ["node", "/app/dist/service/main.mjs", "serve"]

FROM runtime AS native-test
COPY packages/confidential-browser/test/native-encryption.mjs /app/native-encryption.mjs
ENTRYPOINT ["node", "/app/native-encryption.mjs"]

FROM runtime AS final
