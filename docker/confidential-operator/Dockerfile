# Reuse the qualified Nebula synthesis toolchain. Helm dependencies continue to
# use their pinned upstream package; the operator doesn't build charts.
FROM --platform=$BUILDPLATFORM golang:1.27.1 AS manager
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
COPY packages/nebula ./nebula
COPY packages/confidential-operator ./confidential-operator
RUN npm install -g pnpm@11.9.0 \
    && cd confidential-operator && pnpm install --frozen-lockfile && pnpm typecheck

FROM ghcr.io/mateo-moon/nebula-cmp:1b67ec0@sha256:27ae309e158862e821f6de6ea7e91803d020bca81fa9e1d1ae826359fea76446
USER 0
COPY --from=build /workspace/packages/confidential-operator /app
COPY --from=manager /manager /manager
WORKDIR /app
USER 10001:10001
ENTRYPOINT ["/manager"]
