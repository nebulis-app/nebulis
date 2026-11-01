# ── Stage 1: Build frontend ──────────────────────────────────────────
# Always runs on the machine doing the build, never emulated. The output is plain
# HTML/JS/CSS, the same for every architecture, and the arm64 build under QEMU got
# stuck for six hours in vite's "rendering chunks" step (v2.2.0-beta run 41141817614).
# The native modules the server needs are installed per-arch in stage 2.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build

WORKDIR /app

# One store location for every pnpm command (install and rebuild), which is also the cache mount below.
ENV npm_config_store_dir=/pnpm/store

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
# The cache mount keeps pnpm's download store between builds, so a changed lockfile
# only fetches the packages that changed.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
  npm install -g pnpm@10.30.3 \
  && pnpm install --frozen-lockfile --config.strict-dep-builds=false

# Copy source and build
COPY . .
RUN npm run build

# ── Stage 2: Production image ───────────────────────────────────────
# Debian-slim instead of Alpine: sharp's prebuilt native binding for musl
# (@img/sharp-linuxmusl-*) is fragile to install when the lockfile was generated
# on a different platform; the glibc prebuilt that ships in the standard
# @img/sharp-linux-{arch} package "just works" on Debian.
FROM node:24-bookworm-slim

# smbclient → SMB share access, wget → healthcheck, unzip → in-app plate-solver
# (ASTAP) installer. setpriv (util-linux, already in the base image) lets
# docker/entrypoint.sh drop root.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates smbclient wget unzip \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Same store variable as stage 1: pnpm refuses to mix store locations within one install.
ENV npm_config_store_dir=/pnpm/store

# Copy package files and install production deps + tsx
COPY package.json pnpm-lock.yaml .npmrc ./
RUN --mount=type=cache,id=pnpm-store-prod,target=/pnpm/store \
  npm install -g pnpm@10.30.3 \
  && pnpm install --frozen-lockfile --prod --config.strict-dep-builds=false \
  && pnpm rebuild better-sqlite3 sharp \
  && pnpm add tsx@4.22.4

# Copy server source (tsx runs TypeScript directly) + bundled catalog data.
# --chmod: the image runs as `node`, so a 600 file in the build context must not crash boot.
COPY --chmod=a+rX server/ ./server/
COPY --chmod=a+r CHANGELOG.md ./

# Copy built frontend from build stage (vite outputs to releases/web/, server expects ./dist)
COPY --from=build /app/releases/web ./dist

# Persistent data directory for settings and notes
# Owned by the image's unprivileged user, so a fresh volume is too and the
# entrypoint runs the server as that user. See docker/entrypoint.sh for how
# existing root-owned volumes and bind mounts are handled.
RUN mkdir -p /app/data && chown node:node /app/data
VOLUME ["/app/data"]

# Environment
ENV NODE_ENV=production
ENV PORT=8080
# Without this, server/lib/paths.ts still resolves DATA_DIR to /app/data (matching
# the VOLUME below) via its Docker-detection fallback, but LOGS_DIR falls through to
# the separate, non-volumed /app/logs — so server.log (including every HTTP request
# log) is silently wiped on container recreation (image update, --force-recreate)
# while the SQLite DB and settings survive. Setting DATA_DIR explicitly routes
# LOGS_DIR to /app/data/logs, inside the volume, matching macOS/Windows where logs
# live in the same durable location as the rest of the app data.
ENV DATA_DIR=/app/data

# HTTP only — the Node server serves the SPA and API directly on PORT.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1

# smbclient (a separate process) does its own NTLM, and nothing in the server
# needs OpenSSL's legacy provider any more, so it is no longer enabled.
COPY docker/entrypoint.sh /usr/local/bin/nebulis-entrypoint
RUN chmod +x /usr/local/bin/nebulis-entrypoint
ENTRYPOINT ["nebulis-entrypoint"]
CMD ["node", "--import", "tsx", "server/index.ts"]
