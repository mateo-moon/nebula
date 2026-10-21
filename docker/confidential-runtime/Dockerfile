FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /build
COPY packages/confidential-runtime/package.json packages/confidential-runtime/pnpm-lock.yaml ./
COPY packages/confidential-runtime/pnpm-workspace.yaml ./
RUN npm install -g pnpm@11.9.0 && pnpm install --frozen-lockfile
COPY packages/confidential-runtime/tsconfig.json ./
COPY packages/confidential-runtime/src ./src
RUN pnpm build

FROM node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates nftables \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /build/dist ./dist
COPY packages/confidential-runtime/package.json ./
USER 10001:10001
ENTRYPOINT ["node", "/app/dist/main.js"]
