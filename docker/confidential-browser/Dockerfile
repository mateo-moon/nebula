FROM ghcr.io/mateo-moon/nebula-cmp:1b67ec0@sha256:27ae309e158862e821f6de6ea7e91803d020bca81fa9e1d1ae826359fea76446 AS tools
FROM ghcr.io/mateo-moon/nebula-coco-canary@sha256:5468f55e9636184cce37cb2213bad9e4ab2bac21fe2c9d9d34ef69ae15ea52ba AS skopeo

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
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
COPY packages/confidential-browser ./confidential-browser
RUN npm install -g pnpm@11.9.0 \
    && cd confidential-agent && pnpm install --frozen-lockfile && pnpm typecheck && NEBULA_AGENT_MODULES=browser pnpm build \
    && cd ../confidential-browser && pnpm install --frozen-lockfile \
    && pnpm typecheck && pnpm build \
    && pnpm exec esbuild src/ui/image-encryption.ts --bundle --platform=node --format=esm --target=node24 --outfile=/tmp/browser-encryption.mjs

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl musl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=tools /usr/local/bin/genpolicy /usr/local/bin/genpolicy
COPY --from=tools /usr/local/bin/helm /usr/local/bin/helm
COPY --from=skopeo /skopeo /usr/local/bin/skopeo
WORKDIR /app
COPY --from=build /workspace/packages/confidential-agent/dist ./dist
COPY --from=build /workspace/packages/confidential-browser/dist/ui ./ui
USER 10001:10001
ENV HOME=/tmp
ENTRYPOINT ["node", "/app/dist/main.mjs", "{\"version\":1,\"role\":\"preparation\"}"]

FROM runtime AS native-test
COPY --from=build /tmp/browser-encryption.mjs /app/browser-encryption.mjs
COPY packages/confidential-browser/test/native-encryption.mjs /app/native-encryption.mjs
ENTRYPOINT ["node", "/app/native-encryption.mjs"]

FROM runtime AS final
