FROM node:24-alpine

ARG HELM_VERSION=3.17.0
ARG VALS_VERSION=0.43.1

RUN apk add --no-cache git openssh-client wget \
    && wget -qO /tmp/helm.tar.gz "https://get.helm.sh/helm-v${HELM_VERSION}-linux-amd64.tar.gz" \
    && tar xzf /tmp/helm.tar.gz -C /tmp \
    && mv /tmp/linux-amd64/helm /usr/local/bin/helm \
    && rm -rf /tmp/helm.tar.gz /tmp/linux-amd64 \
    && wget -qO /tmp/vals.tar.gz "https://github.com/helmfile/vals/releases/download/v${VALS_VERSION}/vals_${VALS_VERSION}_linux_amd64.tar.gz" \
    && tar xzf /tmp/vals.tar.gz -C /usr/local/bin vals \
    && rm -f /tmp/vals.tar.gz \
    && npm install -g pnpm

ENV PNPM_HOME="/tmp/bin" \
    XDG_DATA_HOME="/tmp" \
    npm_config_store_dir="/tmp/pnpm-store" \
    NPM_CONFIG_CACHE="/tmp/.npm" \
    COREPACK_HOME="/tmp/.corepack" \
    HOME="/tmp"

USER 999
