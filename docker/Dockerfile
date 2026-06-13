# ── Stage 1: Build frontend ──────────────────────────────────────────
FROM node:22-alpine AS build

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json pnpm-lock.yaml ./
COPY patches/ ./patches/
RUN npm install -g pnpm@10.4.0 \
  && pnpm install --frozen-lockfile --config.strict-dep-builds=false

# Copy source and build
COPY . .
RUN npm run build

# ── Stage 2: Production image ───────────────────────────────────────
# Debian-slim instead of Alpine: sharp's prebuilt native binding for musl
# (@img/sharp-linuxmusl-*) is fragile to install when the lockfile was generated
# on a different platform; the glibc prebuilt that ships in the standard
# @img/sharp-linux-{arch} package "just works" on Debian.
FROM node:22-bookworm-slim

# smbclient → SMB share access, ffmpeg → RTSP-to-MJPEG, wget → healthcheck.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates smbclient ffmpeg wget \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files and install production deps + tsx
COPY package.json pnpm-lock.yaml .npmrc ./
COPY patches/ ./patches/
RUN npm install -g pnpm@10.4.0 \
  && pnpm install --frozen-lockfile --prod --config.strict-dep-builds=false \
  && pnpm rebuild better-sqlite3 sharp \
  && pnpm add tsx

# Copy server source (tsx runs TypeScript directly) + bundled catalog data
COPY server/ ./server/
COPY CHANGELOG.md ./

# Copy built frontend from build stage (vite outputs to releases/web/, server expects ./dist)
COPY --from=build /app/releases/web ./dist

# Persistent data directory for settings and notes
RUN mkdir -p /app/data
VOLUME ["/app/data"]

# Environment
ENV NODE_ENV=production
ENV PORT=8080
# @marsaud/smb2 uses ntlm@0.1.3 which computes LM hashes with DES-ECB.
# OpenSSL 3 (Node 17+) disables DES by default. Re-enable the legacy provider.
ENV NODE_OPTIONS=--openssl-legacy-provider

# HTTP only — the Node server serves the SPA and API directly on PORT.
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1

CMD ["npx", "tsx", "server/index.ts"]
