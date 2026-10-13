# Docker Deployment Guide

This directory contains the containerized build files for **team-memory-control** (the Control panel backend).

## Directory Structure

```
docker/
├── README.md                          # This file
└── local/
    ├── Dockerfile.local               # Control single image (multi-stage build)
    └── Dockerfile.local.dockerignore  # Build-context ignore rules
```

## Images at a Glance

| Image name (example) | Dockerfile | Build context | Description |
|----------------|------------|------------|------|
| `team-memory-control:local` | `docker/local/Dockerfile.local` | **Repository root** `.` | Control HTTP service, default `:8123` |

---

## `docker/local/Dockerfile.local`

### Purpose

Builds the **Control panel** monolithic image: the backend runs `src/index.ts` directly with `tsx` (stateless panel, entry `src/panel/`), and the `web/` frontend is compiled in a separate stage and served as static assets.

### Multi-stage Structure

| Stage | Role |
|-------|------|
| `base` | `node:22-slim` + native build toolchain (`better-sqlite3` needs `python3`/`make`/`g++`) |
| `ui-builder` | Builds `web/`: `npm install` + `npm run build` → `dist/` |
| `runtime` | Copies the whole repo source, runs `npm install`, embeds the UI artifacts, and starts Control |

### Build Arguments

| Argument | Default | Description |
|------|--------|------|
| `PANEL_UI` | `web` | Frontend project directory (the currently active panel is `web/`; `frontend/` is a legacy directory and no longer maintained) |
| `WEB_UI` | `1` | `1` builds the panel UI normally; `0` skips the UI build and generates a placeholder `index.html` (see "Disabling the panel UI build" below) |

At runtime the instance table is specified via `METADATA_INSTANCES_CONFIG`, and `UI_DIST_DIR=./web/dist` serves the frontend.

### Exposed Port and Health Check

- Port: `8123`
- Health check: `GET http://127.0.0.1:8123/health`

---

## Build and Run

### Prerequisites

- Docker (BuildKit recommended)
- Node engine requirement is consistent with the repo: `>=22` (see the root `package.json`)
- Run the build from the **repository root** (the context is the whole repository)

```bash
# From the repository root
docker build \
  --build-arg PANEL_UI=web \
  -t team-memory-control:local \
  -f docker/local/Dockerfile.local .

docker run -d --name tmc-control \
  -p 8123:8123 \
  -e UI_DIST_DIR=./web/dist \
  -e METADATA_INSTANCES_CONFIG=/app/config/metadata-instances.json \
  -e KNOWLEDGE_SERVICE_URL=http://host.docker.internal:8421 \
  -e KNOWLEDGE_AUTH_TOKEN=<ks-token> \
  -e KNOWLEDGE_LLM_PROXY_BASE_URL=http://host.docker.internal:8096 \
  -v "$(pwd)/config/metadata-instances.json:/app/config/metadata-instances.json:ro" \
  team-memory-control:local
```

Login: open `http://localhost:8123/` in a browser, select the instance ID, and enter the Gateway **user_key**. For the instance table fields see [`config/metadata-instances.README.md`](../config/metadata-instances.README.md).

If the Gateway runs on the host, `gateway_endpoint` in the mounted `metadata-instances.json` must use an address reachable from the container (e.g. `http://host.docker.internal:8420`), not `127.0.0.1`.

### Disabling the panel UI build (`WEB_UI=0`)

The panel UI depends on internal packages such as `@tencent/*`, which public npm mirrors do not provide. If the build environment **cannot access the internal npm registry** (e.g. offline machines, external CI), `npm install` will fail. In that case use `WEB_UI=0` to skip the UI build:

```bash
docker build \
  --build-arg PANEL_UI=web \
  --build-arg WEB_UI=0 \
  -t team-memory-control:local-no-ui \
  -f docker/local/Dockerfile.local .
```

The image generates a placeholder `dist/index.html`; **the Control backend, `/health`, and `/api/*` are fully usable**, only the static panel pages are inaccessible (frontend routes return a placeholder notice). When you need the panel UI, use the default `WEB_UI=1` and make sure the internal dependencies can be pulled.

### Common Environment Variables

| Variable | Default | Description |
|------|------|------|
| `UI_DIST_DIR` | `./web/dist` | Static frontend directory (the Dockerfile sets it to `./${PANEL_UI}/dist` via `ENV`) |
| `METADATA_INSTANCES_CONFIG` | `./config/metadata-instances.json` | Instance registry path |
| `METADATA_REMOTE_TIMEOUT_MS` | `15000` | Gateway forwarding timeout |
| `KNOWLEDGE_SERVICE_URL` | `http://127.0.0.1:8421` | Knowledge Service (KS) address; inside the container it must point to a KS reachable from the container |
| `KNOWLEDGE_AUTH_TOKEN` | — | Bearer token for calling KS, fill in per deployment |
| `KNOWLEDGE_TIMEOUT_MS` | `15000` | KS call timeout |
| `KNOWLEDGE_LLM_BINDING_SYNC` | `true` | At startup, ensure KS's LLM binding for each instance (billed via proxy); `false` skips it |
| `KNOWLEDGE_LLM_PROXY_BASE_URL` | `http://127.0.0.1:8096` | LLM billing proxy address (must be reachable inside the container) |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` | Locally you can set `LOG_FORMAT=pretty` |

> Note: `LLM_MODEL` (the wiki ingest model) is not configured in Panel; it is decided uniformly by `LLM_MODEL` on the KS side (default `Memory-Model`).

---

## `docker/local/Dockerfile.local.dockerignore`

BuildKit prefers `<dockerfile>.dockerignore` (rather than the repo-root `.dockerignore`).

Main exclusions:

- `**/node_modules`, `**/dist` — prevents `better-sqlite3` compiled for the host platform or stale artifacts from entering the image
- `.env`, `data/`, `*.db` — prevents secrets and local data from being baked into the image
- `docs/`, test reports, etc. — shrinks the build context

**Security note**: `config/metadata-instances.json` **will** enter the image via `COPY . .`. If it contains a real `api_key`, production images should mount it at runtime instead, or exclude the file in dockerignore and enforce a `-v` mount.

---

## Local Development Comparison

| Approach | Command |
|------|------|
| Source development | `pnpm dev` |
| Docker single image | See `docker build` / `docker run` above |

---

## Troubleshooting

| Symptom | Likely cause |
|------|----------|
| `GET /` 404 | `UI_DIST_DIR` is not set to `./web/dist`, or the frontend stage `npm run build` failed |
| API 401 / no team after login | `gateway_endpoint` in `metadata-instances.json` is unreachable, or `api_key` does not match the Gateway |
| Knowledge asset loading fails / 500 | `KNOWLEDGE_SERVICE_URL` is unreachable inside the container, or `KNOWLEDGE_AUTH_TOKEN` does not match |
| Startup hangs at "ensure LLM binding" | `KNOWLEDGE_LLM_PROXY_BASE_URL` is unreachable inside the container; you can set `KNOWLEDGE_LLM_BINDING_SYNC=false` to skip it temporarily |
