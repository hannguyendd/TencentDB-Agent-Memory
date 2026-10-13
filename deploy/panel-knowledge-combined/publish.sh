#!/usr/bin/env bash
# Publish the Memory Hub multi-arch image to Docker Hub.
#
# Flow:
#   1) secret-scan the source (MemoryPanel + MemoryKnowledge)
#   2) PREPARE_ONLY to prepare the context, then scan the context again
#   3) docker buildx builds linux/amd64 + linux/arm64 and pushes
#
# Usage:
#   ./publish.sh                              # default VERSION=1.0.0-beta.1, and also push :beta
#   VERSION=1.0.0-beta.2 ./publish.sh         # version tag + floating :beta (default ALSO_BETA=1)
#   ALSO_BETA=0 VERSION=1.0.0-beta.2 ./publish.sh   # push only the version tag, do not move :beta
#   DRY_RUN=1 ./publish.sh                    # only scan + prepare the context, no build/push
#   PUSH=0 ./publish.sh                       # local --load single arch (default amd64) for spot checks
#   ALSO_LATEST=1 ./publish.sh                # additionally tag agentmemory/memory-hub:latest (use for official releases)
#
# Prerequisites:
#   - docker login done (the account needs push permission on the agentmemory org)
#   - docker buildx available; default builder name multiarch (created automatically if missing)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
WORKSPACE_ROOT="$(dirname "$REPO_ROOT")"

TMC_DIR="${TMC_DIR:-$REPO_ROOT/MemoryPanel}"
KNOWLEDGE_DIR="${KNOWLEDGE_DIR:-$REPO_ROOT/MemoryKnowledge}"
CTX_DIR="${CTX_DIR:-$WORKSPACE_ROOT/panel-knowledge-builder}"
VERSION="${VERSION:-1.0.0-beta.1}"
HUB_IMAGE="${HUB_IMAGE:-agentmemory/memory-hub}"
LOCAL_NAME="${LOCAL_NAME:-team-memory-panel-knowledge}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILDER="${BUILDER:-multiarch}"
DRY_RUN="${DRY_RUN:-0}"
PUSH="${PUSH:-1}"
ALSO_BETA="${ALSO_BETA:-1}"
ALSO_LATEST="${ALSO_LATEST:-0}"
SECRET_SCAN="${SECRET_SCAN:-$TMC_DIR/scripts/secret-scan.sh}"

err() { echo "[publish-hub] error: $*" >&2; exit 1; }
log() { echo "[publish-hub] $*"; }

[[ -f "$TMC_DIR/package.json" ]] || err "MemoryPanel not found at $TMC_DIR"
[[ -f "$KNOWLEDGE_DIR/package.json" ]] || err "MemoryKnowledge not found at $KNOWLEDGE_DIR"
[[ -f "$SECRET_SCAN" ]] || err "secret-scan not found at $SECRET_SCAN"
[[ -f "$SCRIPT_DIR/Dockerfile" ]] || err "Dockerfile missing"
command -v docker >/dev/null || err "docker is required"
command -v rsync >/dev/null || err "rsync is required"

# ── 1) Source secret-scan ─────────────────────────────────────────────
log "secret-scan: MemoryPanel"
(
  cd "$TMC_DIR"
  bash "$SECRET_SCAN" src web/src config package.json
)
log "secret-scan: MemoryKnowledge"
(
  cd "$KNOWLEDGE_DIR"
  bash "$SECRET_SCAN" src .env.example package.json
)

# ── 2) Prepare context ─────────────────────────────────────────────────
log "prepare context → $CTX_DIR"
KEEP_CTX=1 PREPARE_ONLY=1 CTX_DIR="$CTX_DIR" IMAGE_TAG="scan-$VERSION" \
  bash "$SCRIPT_DIR/build.sh"

[[ -f "$CTX_DIR/panel/package.json" && -f "$CTX_DIR/knowledge/package.json" ]] \
  || err "context preparation failed: $CTX_DIR"

log "secret-scan: build context"
(
  cd "$CTX_DIR"
  bash "$SECRET_SCAN" panel knowledge Dockerfile start-combined.sh .dockerignore
)

if [[ "$DRY_RUN" == "1" ]]; then
  log "DRY_RUN=1 → skipping build/push. Context kept at $CTX_DIR"
  exit 0
fi

# ── 3) buildx multi-arch ────────────────────────────────────────────
# Note: --push only pushes the names in TAG_ARGS. The local name team-memory-panel-knowledge
# must not appear in --push, otherwise it is treated as docker.io/library/... and causes authorization failed.
HUB_TAGS=(-t "${HUB_IMAGE}:${VERSION}")
if [[ "$ALSO_BETA" == "1" ]]; then
  HUB_TAGS+=(-t "${HUB_IMAGE}:beta")
fi
if [[ "$ALSO_LATEST" == "1" ]]; then
  HUB_TAGS+=(-t "${HUB_IMAGE}:latest")
fi

log "builder=$BUILDER platforms=$PLATFORMS version=$VERSION also_beta=$ALSO_BETA also_latest=$ALSO_LATEST"
if ! docker buildx inspect "$BUILDER" >/dev/null 2>&1; then
  log "create buildx builder: $BUILDER"
  docker buildx create --name "$BUILDER" --driver docker-container --use
fi
docker buildx use "$BUILDER"
docker buildx inspect --bootstrap >/dev/null

if [[ "$PUSH" == "1" ]]; then
  log "buildx build --push ${HUB_IMAGE}:${VERSION} ($PLATFORMS)"
  docker buildx build \
    --builder "$BUILDER" \
    --platform "$PLATFORMS" \
    "${HUB_TAGS[@]}" \
    --push \
    "$CTX_DIR"
  log "pushed ${HUB_IMAGE}:${VERSION}"
  [[ "$ALSO_BETA" == "1" ]] && log "also ${HUB_IMAGE}:beta"
  [[ "$ALSO_LATEST" == "1" ]] && log "also ${HUB_IMAGE}:latest"
else
  LOAD_PLATFORM="${LOAD_PLATFORM:-linux/amd64}"
  log "PUSH=0 → buildx --load ($LOAD_PLATFORM) as ${LOCAL_NAME}:${VERSION}"
  docker buildx build \
    --builder "$BUILDER" \
    --platform "$LOAD_PLATFORM" \
    -t "${LOCAL_NAME}:${VERSION}" \
    --load \
    "$CTX_DIR"
  log "spot-check image filesystem for .env / metadata-instances"
  cid=$(docker create "${LOCAL_NAME}:${VERSION}")
  cleanup() { docker rm -f "$cid" >/dev/null 2>&1 || true; }
  trap cleanup EXIT
  if docker export "$cid" | tar -t 2>/dev/null \
    | grep -E '(\.env$|metadata-instances\.json|/app/panel/\.env)' ; then
    err "Suspected sensitive path found in the image, aborting"
  fi
  cleanup
  trap - EXIT
  log "local image ready: ${LOCAL_NAME}:${VERSION} (not pushed)"
fi

log "done. Verify: docker pull ${HUB_IMAGE}:${VERSION} && docker buildx imagetools inspect ${HUB_IMAGE}:${VERSION}"
