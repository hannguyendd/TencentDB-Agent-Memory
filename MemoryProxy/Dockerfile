# syntax=docker/dockerfile:1
# ──────────────────────────────────────────────────────────────────────
# TencentDB-Agent-Memory · MemoryProxy — Production Image
# ──────────────────────────────────────────────────────────────────────
# Multi-stage build (requires DOCKER_BUILDKIT=1):
#   1. deps-builder: install all deps (incl. native compile toolchain for
#                    better-sqlite3 / node-pty)
#   2. runtime:      slim image with runtime deps + app, tini as PID 1
#
# Configuration: mount config.yaml at /data/config.yaml
#   docker run -v ./config.yaml:/data/config.yaml:ro ...
# Sensitive credentials are injected via environment variables (env takes precedence over the config file).
#
# Build:
#   DOCKER_BUILDKIT=1 docker build -t memory-proxy:latest .
#
# Note: at runtime tsx executes TypeScript directly (no precompilation). tsx is a devDependency,
# so dev dependencies are kept in the image; optional dependencies (better-sqlite3 / cos-nodejs-sdk-v5 /
# cost-guard) are kept for the sqlite / cos storage backends and CostGuard smart routing.
# ──────────────────────────────────────────────────────────────────────

# ──────────────────────────────────────────────────────────────────────
# Stage 1: deps-builder — install deps (with toolchain for native bindings)
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS deps-builder

# Uses the official Debian apt source (deb.debian.org). If builds are slow, replace it with a mirror for local builds, e.g.:
#   sed -i 's|deb.debian.org|mirrors.tencent.com|g' /etc/apt/sources.list.d/debian.sources

# Native build toolchain (better-sqlite3 / node-pty need compilation)
# Use a BuildKit cache mount to cache apt packages and avoid repeated downloads
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        python3 \
        make \
        g++ \
        ca-certificates

WORKDIR /app

# node:22-slim ships npm@10.9.8, which has an arborist "edgesOut" crash (a clean
# `npm install` reliably fails with `Cannot read properties of null (reading
# 'edgesOut')`). Upgrading to 11 avoids it without affecting other build behavior.
RUN npm install -g npm@11 --no-audit --no-fund

# Copy package metadata first to maximize Docker layer cache.
COPY package.json package-lock.json ./

# Install all dependencies (keep dev: needed by tsx at runtime; keep optional: sqlite/cos/cost-guard).
# Use a BuildKit npm cache mount to greatly speed up repeated builds.
RUN --mount=type=cache,id=proxy-npm-cache,target=/root/.npm \
    npm install \
        --no-audit \
        --no-fund

# Copy the remaining source (.dockerignore already excludes node_modules/.git/docs/scripts/gateway, etc.)
COPY . .

# ──────────────────────────────────────────────────────────────────────
# Stage 2: runtime — slim image
# ──────────────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Uses the official Debian apt source (deb.debian.org). If builds are slow, replace it with a mirror.

# Runtime essentials only (curl for HEALTHCHECK; tini for signal handling)
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        curl \
        tini \
        ca-certificates

WORKDIR /app

# Run as non-root (security baseline)
RUN groupadd -r app && useradd -r -g app -u 10001 -m app

# Copy the entire /app from the builder (including the file: symlink in node_modules pointing to packages/cost-guard)
COPY --from=deps-builder /app /app

# Data / log directories (can be mounted as K8s PVCs)
RUN mkdir -p /data/tdai-memory-proxy /data/config /app/logs && \
    chown -R app:app /app /data

USER app

# ── Runtime configuration ──
# Config file path: mount the yaml at /data/config.yaml
# Sensitive credentials are injected via environment variables (env takes precedence over the config file)
ENV NODE_ENV=production \
    PROXY_DB_PATH=/data/tdai-memory-proxy/proxy.db \
    NODE_OPTIONS="--max-old-space-size=1536"

EXPOSE 8096

# K8s-friendly health check (liveness/readiness should still be defined separately in the Deployment;
# this is a fallback for local runs).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
    CMD curl -fsS http://127.0.0.1:8096/health || exit 1

# tini runs as PID 1 so SIGTERM/SIGKILL are passed cleanly to Node and its children, and zombie processes are reaped.
# tsx is a runtime dependency and can execute TypeScript directly.
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--import", "tsx/esm", "src/index.ts"]

# Default config file path (can be overridden by arguments appended to docker run)
CMD ["--config", "/data/config.yaml"]
