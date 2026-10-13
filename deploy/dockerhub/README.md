# Docker Hub Image Publishing

Builds the three-component images and pushes them to the
[`agentmemory`](https://hub.docker.com/u/agentmemory) namespace on Docker Hub.

`publish.sh` is self-contained: it depends only on each component's own Dockerfile,
`deploy/panel-knowledge-combined/build.sh` and `MemoryPanel/scripts/secret-scan.sh`.

## Components and image names

| Component | Build context | Image |
|---|---|---|
| `memory-core` | `MemoryCore/` | `agentmemory/memory-core` |
| `memory-proxy` | `MemoryProxy/` (rsynced to a temporary context) | `agentmemory/memory-proxy` |
| `memory-hub` | `MemoryPanel/` + `MemoryKnowledge/` combined | `agentmemory/memory-hub` |

## Prerequisites

```bash
docker login docker.io          # the account needs push access to agentmemory
docker buildx version           # buildx is required (the script creates a builder automatically)
```

## Usage

```bash
cd deploy/dockerhub

# Publish all three at once
VERSION=1.0.0 ./publish.sh all

# A single component
VERSION=1.0.0 ./publish.sh memory-core
VERSION=1.0.0 ./publish.sh memory-proxy
VERSION=1.0.0 ./publish.sh memory-hub

# Dry run: only secret-scan and context preparation, no build, no push
DRY_RUN=1 VERSION=1.0.0 ./publish.sh all

# Build a single architecture locally and spot-check the image contents, no push
PUSH=0 VERSION=1.0.0 ./publish.sh memory-core

# Also update :latest
ALSO_LATEST=1 VERSION=1.0.0 ./publish.sh all
```

`VERSION` is required and values starting with `dev-` are rejected, so development tags never reach the public registry.

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `VERSION` | none (required) | Image tag |
| `NAMESPACE` | `agentmemory` | Docker Hub namespace |
| `REGISTRY` | `docker.io` | Target registry |
| `PLATFORMS` | `linux/amd64,linux/arm64` | Multi-arch build targets |
| `ALSO_LATEST` | `0` | Whether to also push `:latest` |
| `PUSH` | `1` | Set to `0` to build a single architecture locally with `--load`, no push |
| `DRY_RUN` | `0` | Set to `1` to only run the scan and context preparation |
| `LOAD_PLATFORM` | `linux/amd64` | Architecture built locally when `PUSH=0` |
| `KEEP_CTX` | `0` | Set to `1` to reuse the previous temporary context |
| `APT_MIRROR` | `deb.debian.org` | Build-time apt source; can be set to an accelerated mirror on an internal network |

## Build-time apt acceleration

All four Dockerfiles control the apt source through the `APT_MIRROR` build-arg. The default is the official Debian source,
which works out of the box on the public internet. To speed up builds on an internal network, pass a single variable;
the resulting images are not affected:

```bash
APT_MIRROR=<your-debian-mirror> VERSION=1.0.0 ./publish.sh all
```

## About optional private modules

- `MemoryProxy/packages/cost-guard` is an optional extension and is not part of the public images. `publish.sh` generates
  a stub package in the temporary context so the dependency graph can resolve; at runtime, when the dynamic import in
  `src/guard-adapter.ts` fails, it automatically degrades to passthrough forwarding.
- `MemoryCore/src/integrations` is treated the same way: it is excluded in `MemoryCore/.dockerignore`,
  and runtime uses the fallback.

## Verification

```bash
docker pull agentmemory/memory-core:1.0.0
docker buildx imagetools inspect agentmemory/memory-core:1.0.0
```
