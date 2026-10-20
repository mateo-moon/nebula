# Reuse the qualified Nebula synthesis toolchain. Helm dependencies continue to
# use their pinned upstream package; the operator doesn't build charts.
FROM ghcr.io/mateo-moon/nebula-cmp:1b67ec0@sha256:27ae309e158862e821f6de6ea7e91803d020bca81fa9e1d1ae826359fea76446 AS build
USER 0
WORKDIR /workspace/packages
COPY packages/nebula ./nebula
COPY packages/confidential-operator ./confidential-operator
RUN npm install -g pnpm@11.9.0 \
    && cd confidential-operator && pnpm install --frozen-lockfile && pnpm typecheck

FROM ghcr.io/mateo-moon/nebula-cmp:1b67ec0@sha256:27ae309e158862e821f6de6ea7e91803d020bca81fa9e1d1ae826359fea76446
USER 0
COPY --from=build /workspace/packages/confidential-operator /app
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/app/node_modules/.bin/tsx", "/app/src/main.ts"]
