# Multi-arch (amd64 + arm64). Build with:
#   docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/mateo-moon/nebula-cmp:latest --push .
# node:*-alpine is already multi-arch; TARGETARCH is set by buildx per platform
# (amd64 | arm64), which matches both the Helm and vals release asset naming.
FROM node:24-alpine

ARG HELM_VERSION=3.17.0
ARG VALS_VERSION=0.43.1
ARG TARGETARCH

RUN apk add --no-cache git openssh-client wget \
    && wget -qO /tmp/helm.tar.gz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-${TARGETARCH}.tar.gz" \
    && tar xzf /tmp/helm.tar.gz -C /tmp \
    && mv /tmp/linux-${TARGETARCH}/helm /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz /tmp/linux-${TARGETARCH} \
    && wget -qO /tmp/vals.tar.gz "https://github.com/helmfile/vals/releases/download/v${VALS_VERSION}/vals_${VALS_VERSION}_linux_${TARGETARCH}.tar.gz" \
    && tar xzf /tmp/vals.tar.gz -C /usr/local/bin vals \
    && rm -f /tmp/vals.tar.gz \
    && npm install -g pnpm typescript

# vals decrypts ref+sops:// (incl. age via SOPS_AGE_KEY_FILE) and ref+vault/etc.
# No separate sops/age binary is needed — vals embeds the SOPS library.

ENV PNPM_HOME="/tmp/bin" \
    XDG_DATA_HOME="/tmp" \
    npm_config_store_dir="/tmp/pnpm-store" \
    NPM_CONFIG_CACHE="/tmp/.npm" \
    COREPACK_HOME="/tmp/.corepack" \
    HOME="/tmp"

USER 999
