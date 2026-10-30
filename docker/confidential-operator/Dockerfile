# Reuse the qualified Nebula synthesis toolchain. Helm dependencies continue to
# use their pinned upstream package; the operator doesn't build charts.
FROM --platform=$BUILDPLATFORM golang:1.27.3@sha256:f20d83a83e18dbd2a4714b8ffd4b30b287b6243962dd75608e86abcc63ba4efc AS manager
ARG TARGETOS
ARG TARGETARCH
WORKDIR /workspace
COPY packages/confidential-operator/go.mod packages/confidential-operator/go.sum ./
RUN go mod download
COPY packages/confidential-operator/api ./api
COPY packages/confidential-operator/cmd ./cmd
COPY packages/confidential-operator/internal ./internal
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} go build -trimpath -o /manager ./cmd

FROM ghcr.io/mateo-moon/nebula-cmp:1b67ec0@sha256:27ae309e158862e821f6de6ea7e91803d020bca81fa9e1d1ae826359fea76446 AS build
USER 0
WORKDIR /workspace/packages
COPY packages/nebula/package.json ./nebula/
COPY packages/nebula/src/core/base-construct.ts ./nebula/src/core/
COPY packages/nebula/src/utils/secrets.ts ./nebula/src/utils/
COPY packages/nebula/src/modules/k8s/confidential-guests ./nebula/src/modules/k8s/confidential-guests
COPY packages/nebula/src/modules/k8s/confidential-workloads ./nebula/src/modules/k8s/confidential-workloads
COPY packages/nebula/src/modules/k8s/trustee ./nebula/src/modules/k8s/trustee
COPY packages/nebula/src/modules/k8s/envoy/measured-fragments.ts ./nebula/src/modules/k8s/envoy/
COPY packages/confidential-operator ./confidential-operator
RUN npm install -g pnpm@11.9.0 \
    && cd confidential-operator && pnpm install --frozen-lockfile && pnpm typecheck \
    && pnpm exec esbuild src/main.ts --bundle --platform=node --format=esm --target=node24 \
      --banner:js='import { createRequire as __bundleCreateRequire } from "node:module"; import { fileURLToPath as __bundleFileURLToPath } from "node:url"; var require = __bundleCreateRequire(import.meta.url); var __dirname = __bundleFileURLToPath(new URL(".", import.meta.url));' \
      --outfile=dist/main.mjs \
    && set -- node_modules/.pnpm/cdk8s@*/node_modules/cdk8s/lib/_loadurl.mjs \
    && test "$#" -eq 1 && test -f "$1" \
    && pnpm exec esbuild "$1" --bundle --platform=node --format=esm --target=node24 \
      --banner:js='import { createRequire as __bundleCreateRequire } from "node:module"; var require = __bundleCreateRequire(import.meta.url);' \
      --outfile=dist/_loadurl.mjs \
    && mkdir -p dist/assets/genpolicy \
    && cp ../nebula/src/modules/k8s/trustee/assets/genpolicy/* dist/assets/genpolicy/ \
    && printf '%s' '{"operation":"validate-storage","storage":{"apiVersion":"confidential.nebula.dev/v1alpha1","kind":"ConfidentialStorage","metadata":{"name":"scratch","namespace":"qualified"},"spec":{"type":"Memory","sizeLimit":"32Mi"}}}' \
      | node dist/main.mjs | grep -qx '{}'

FROM ghcr.io/mateo-moon/nebula-cmp:1b67ec0@sha256:27ae309e158862e821f6de6ea7e91803d020bca81fa9e1d1ae826359fea76446
USER 0
RUN apk add --no-cache skopeo
COPY --from=build /workspace/packages/confidential-operator/dist /app/dist
COPY --from=manager /manager /manager
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/manager"]
