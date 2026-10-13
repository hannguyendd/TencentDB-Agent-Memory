#!/usr/bin/env bash
# Build the combined panel + knowledge image.
#
# Usage (run from deploy/panel-knowledge-combined/):
#   ./build.sh                              # use default paths + default tag
#   TMC_DIR=/path/to/MemoryPanel ./build.sh # custom panel source directory
#   KNOWLEDGE_DIR=/path/to/MemoryKnowledge ./build.sh
#   IMAGE_TAG=my-tag ./build.sh             # custom tag
#   CTX_DIR=/tmp/my-ctx ./build.sh          # custom temporary context directory
#   KEEP_CTX=1 ./build.sh                    # do not clean up the context (for debugging)
#   PREPARE_ONLY=1 ./build.sh                # only rsync the context, no docker build (for publish.sh)
#
# Default sources are all under this repo's root:
#   memory-tencentdb/
#   ├── MemoryPanel/                         # panel backend + web frontend
#   ├── MemoryKnowledge/                     # knowledge service
#   └── deploy/panel-knowledge-combined/     # this recipe
#
# Output image name: team-memory-panel-knowledge:${TAG} (default tag=amd64)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"          # memory-tencentdb root
WORKSPACE_ROOT="$(dirname "$REPO_ROOT")"               # parent directory (where the default CTX_DIR lands)

TMC_DIR="${TMC_DIR:-$REPO_ROOT/MemoryPanel}"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$REPO_ROOT/MemoryKnowledge}"
IMAGE_NAME="${IMAGE_NAME:-team-memory-panel-knowledge}"
IMAGE_TAG="${IMAGE_TAG:-amd64}"
CTX_DIR="${CTX_DIR:-$WORKSPACE_ROOT/panel-knowledge-builder}"
KEEP_CTX="${KEEP_CTX:-0}"
PREPARE_ONLY="${PREPARE_ONLY:-0}"
PLATFORM="${PLATFORM:-linux/amd64}"

err() { echo "[build-combined] error: $*" >&2; exit 1; }

[[ -d "$TMC_DIR/package.json" || -f "$TMC_DIR/package.json" ]] \
  || err "MemoryPanel not found at $TMC_DIR (set TMC_DIR=<path> to specify)"
[[ -f "$KNOWLEDGE_DIR/package.json" ]] \
  || err "MemoryKnowledge not found at $KNOWLEDGE_DIR (set KNOWLEDGE_DIR=<path> to specify)"
[[ -f "$SCRIPT_DIR/Dockerfile" ]] || err "Dockerfile not found at $SCRIPT_DIR"
[[ -f "$SCRIPT_DIR/start-combined.sh" ]] || err "start-combined.sh not found at $SCRIPT_DIR"

echo "[build-combined] panel  (MemoryPanel): $TMC_DIR"
echo "[build-combined] knowledge:            $KNOWLEDGE_DIR"
echo "[build-combined] context dir:                 $CTX_DIR"
echo "[build-combined] image:                       $IMAGE_NAME:$IMAGE_TAG"
echo ""

# Clean the old context (skipped when KEEP_CTX=1)
if [[ "$KEEP_CTX" == "1" ]]; then
  echo "[build-combined] KEEP_CTX=1 → keeping old context"
else
  rm -rf "$CTX_DIR"
fi
mkdir -p "$CTX_DIR"

# rsync panel (the builder stage needs src/ + web/ + package*.json + tsconfig.json to compile,
# excluding non-essential files such as sensitive real-value config/*.json, docs, tests, .claude, docker config)
echo "[build-combined] rsync panel → $CTX_DIR/panel/"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude web/node_modules \
  --exclude dist \
  --exclude build \
  --exclude coverage \
  --exclude data \
  --exclude .claude \
  --exclude .env \
  --exclude .env.* \
  --exclude config/metadata-instances.json \
  --exclude config/*.yaml \
  --exclude config/*.yml \
  --exclude docs/ \
  --exclude tests/ \
  --exclude scripts/ \
  --exclude docker/ \
  --exclude e2e-*.sh \
  --exclude *.md \
  --exclude pnpm-lock.yaml \
  --exclude pnpm-workspace.yaml \
  --exclude vitest.config.ts \
  "$TMC_DIR"/ "$CTX_DIR/panel"/

# rsync knowledge (the builder stage needs src/ + package*.json + tsconfig.json + tsdown.config.ts to compile,
# runtime needs openapi.yaml at the package root (Swagger UI). Exclude docs, tests, .claude, docker config, etc.)
echo "[build-combined] rsync knowledge → $CTX_DIR/knowledge/"
rsync -a --delete \
  --exclude .git \
  --exclude node_modules \
  --exclude dist \
  --exclude coverage \
  --exclude data \
  --exclude .claude \
  --exclude .env \
  --exclude .env.* \
  --exclude bin/ \
  --exclude docs/ \
  --exclude __tests__/ \
  --exclude docker/ \
  --exclude docker-compose*.yml \
  --exclude Dockerfile \
  --exclude .dockerignore \
  --exclude *.md \
  --exclude pnpm-lock.yaml \
  --exclude vitest.config.ts \
  --exclude start.sh \
  "$KNOWLEDGE_DIR"/ "$CTX_DIR/knowledge"/

# Copy Dockerfile + start-combined.sh + .dockerignore + README (rsync already filtered sensitive files; .dockerignore is the backstop)
cp "$SCRIPT_DIR/Dockerfile" "$CTX_DIR"/
cp "$SCRIPT_DIR/start-combined.sh" "$CTX_DIR"/
cp "$SCRIPT_DIR/README.md" "$CTX_DIR"/
if [[ -f "$SCRIPT_DIR/.dockerignore" ]]; then
  cp "$SCRIPT_DIR/.dockerignore" "$CTX_DIR"/
fi

if [[ "$PREPARE_ONLY" == "1" ]]; then
  echo ""
  echo "[build-combined] PREPARE_ONLY=1 → context ready: $CTX_DIR"
  exit 0
fi

# build
echo "[build-combined] docker build --platform $PLATFORM -t $IMAGE_NAME:$IMAGE_TAG $CTX_DIR"
docker build --platform "$PLATFORM" -t "$IMAGE_NAME:$IMAGE_TAG" "$CTX_DIR"

echo ""
echo "[build-combined] ✅ done: $IMAGE_NAME:$IMAGE_TAG"
echo "[build-combined] context kept at $CTX_DIR (it will be cleaned next time when KEEP_CTX=0)"
