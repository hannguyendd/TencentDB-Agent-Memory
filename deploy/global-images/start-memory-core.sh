#!/usr/bin/env bash
# Start memory-core on its own (core gateway, port 8420); on first start, automatically run init-admin +
# persist the generated user_key to .admin-key for use by proxy / claude-code.
#
# Usage:
#   ./start-memory-core.sh
#
# Data is persisted to a named volume (default tdai-memory-core-data; change MEMORY_CORE_VOLUME in .env).
# Re-running removes the old container before starting a new one; volume data is kept -- so is the admin user_key.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars MEMORY_CORE_IMAGE MEMORY_CORE_PORT MEMORY_CORE_VOLUME

# ── Gateway internal admin credentials ─────────────────────────────────────────
# Use ${VAR-default} (not :-default): allows .env to explicitly set an empty string to disable the Bearer gate.
#
# The current memory-core Bearer gate has a **known incompatibility** with proxy auth: the proxy calls
# /v3/meta/auth/verify without a Bearer (a source oversight, see MemoryProxy/src/auth.ts),
# so MEMORY_CORE_GATEWAY_API_KEY must be left empty when the proxy enables auth. It is empty by default.
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY-}"
MEMORY_CORE_ADMIN_USERNAME="${MEMORY_CORE_ADMIN_USERNAME:-admin}"

# Where the admin user_key is persisted (host side; delete this file along with the volume data when it is cleared)
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"

if [[ -n "$MEMORY_CORE_GATEWAY_API_KEY" ]]; then
  warn "MEMORY_CORE_GATEWAY_API_KEY is non-empty -- proxy sessionInit/auth currently fails because of the missing Bearer."
  warn "For a local experience, leave MEMORY_CORE_GATEWAY_API_KEY empty in .env."
fi

CONTAINER=tdai-memory-core
NETWORK=tdai-memory-stack

# Create the shared network (idempotent)
if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "Creating docker network $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# ── Storage backend: sqlite (default) / mongodb ─────────────────────────────────────
# When MEMORY_CORE_STORE_MODE=mongodb the data plane uses MongoDB (L0/L1/profile/skill +
# mongot native BM25). The target Mongo must be 7.0+ with mongot -- core probes on first connect,
# and init fails outright without mongot (FTS is mandatory, no silent degradation).
#   MONGODB_ENDPOINT set     → use external Mongo (Atlas or a self-hosted replica set with mongot)
#   MONGODB_ENDPOINT unset   → automatically start a mongodb-atlas-local container on the same network
#                             (mongod + mongot combined, data persisted in mongo-local-* volumes)
#
# Metadata backend (meta_* team/user/agent/task/ACL):
#   MEMORY_CORE_METADATA_BACKEND=auto(default, follows STORE_MODE)/ sqlite / mongodb
#   with mongodb, the same Mongo is reused by default (TDAI_METADATA_MONGO_URI can override);
#   metadata uses multi-document transactions, so the target must be a replica set (atlas-local single-node RS qualifies).
MEMORY_CORE_STORE_MODE="${MEMORY_CORE_STORE_MODE:-sqlite}"
MEMORY_CORE_METADATA_BACKEND="${MEMORY_CORE_METADATA_BACKEND:-auto}"
MONGODB_DATABASE="${MONGODB_DATABASE:-tdai_memory}"
MONGO_LOCAL_CONTAINER="${MONGO_LOCAL_CONTAINER:-tdai-mongo-local}"
MONGO_LOCAL_IMAGE="${MONGO_LOCAL_IMAGE:-mongodb/mongodb-atlas-local:8.3}"
MONGO_ENV_ARGS=()

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "auto" ]]; then
  if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
    MEMORY_CORE_METADATA_BACKEND="mongodb"
  else
    MEMORY_CORE_METADATA_BACKEND="sqlite"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" || "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  if [[ -z "${MONGODB_ENDPOINT:-}" ]]; then
    info "MONGODB_ENDPOINT not set → starting local atlas-local ($MONGO_LOCAL_IMAGE)"
    if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "$MONGO_LOCAL_CONTAINER"; then
      rm_container_if_exists "$MONGO_LOCAL_CONTAINER"
      # --hostname must be fixed: atlas-local uses the container hostname to initialize the single-node RS member.
      # If not fixed, recreating the container → hostname changes → the old member name in the RS config mismatches → no primary ever
      # (not primary / ReplicaSetNoPrimary), and the only fix is to wipe the volume and start over.
      $DOCKER run -d --name "$MONGO_LOCAL_CONTAINER" \
        --hostname mongo-search \
        --network "$NETWORK" \
        --network-alias mongo-search \
        -v mongo-local-db:/data/db \
        -v mongo-local-configdb:/data/configdb \
        -v mongo-local-mongot:/data/mongot \
        "$MONGO_LOCAL_IMAGE" >/dev/null
    fi
    info "Waiting for mongo to be ready..."
    mongo_ready=0
    for _ in $(seq 1 30); do
      # ping also succeeds when the RS has no primary -- we must wait for isWritablePrimary,
      # otherwise core starts before the RS election completes and all startup ensureIndex/transactions fail.
      if $DOCKER exec "$MONGO_LOCAL_CONTAINER" mongosh --quiet --eval \
          'if (db.adminCommand("hello").isWritablePrimary === true) quit(0); else quit(1)' >/dev/null 2>&1; then
        mongo_ready=1; break
      fi
      sleep 2
    done
    [[ "$mongo_ready" == "1" ]] || die "mongo container not ready within 60s; check docker logs $MONGO_LOCAL_CONTAINER"
    ok "mongo ready (container $MONGO_LOCAL_CONTAINER, in-network alias mongo-search)"
    MONGODB_ENDPOINT="mongodb://mongo-search:27017/?directConnection=true"
  fi
fi

if [[ "$MEMORY_CORE_STORE_MODE" == "mongodb" ]]; then
  MONGO_ENV_ARGS+=( -e "MONGODB_ENDPOINT=$MONGODB_ENDPOINT" -e "MONGODB_DATABASE=$MONGODB_DATABASE" )
  info "memory-core data plane backend = mongodb（endpoint=$MONGODB_ENDPOINT, db=$MONGODB_DATABASE）"
fi

if [[ "$MEMORY_CORE_METADATA_BACKEND" == "mongodb" ]]; then
  # Metadata shares the same Mongo instance as the data plane by default (different databases: {prefix}_{instance_id}, default prefix tdai_metadata).
  # Note: the metadata client is self-built, bypasses the shared connection pool, and does not inherit the data plane's w:1 (transaction durability relies on the server default majority).
  TDAI_METADATA_MONGO_URI="${TDAI_METADATA_MONGO_URI:-$MONGODB_ENDPOINT}"
  MONGO_ENV_ARGS+=( -e "TDAI_METADATA_MONGO_URI=$TDAI_METADATA_MONGO_URI" )
  info "memory-core metadata backend = mongodb (uri=$TDAI_METADATA_MONGO_URI, database name tdai_metadata_<instance>)"
else
  info "memory-core metadata backend = sqlite (inside the container volume)"
fi

pull_image "$MEMORY_CORE_IMAGE"
rm_container_if_exists "$CONTAINER"

# ── Generate gateway config.yaml and mount it at /data/config/tdai-gateway.yaml in the container ──
# The default image has no config; memory-core uses its compile-time defaults (skill / knowledge modules off).
# Generate a minimal standalone+skill config from MEMORY_LLM_* in .env.
CORE_CONFIG_DIR="${MEMORY_CORE_CONFIG_DIR:-$SCRIPT_DIR/.memory-core-config}"
mkdir -p "$CORE_CONFIG_DIR"
CORE_CONFIG_FILE="$CORE_CONFIG_DIR/tdai-gateway.yaml"
info "Generating gateway config → $CORE_CONFIG_FILE"
cat > "$CORE_CONFIG_FILE" <<YAML
# Auto-generated by start-memory-core.sh -- overwritten on every start, do not edit by hand.
deployMode: standalone
stateBackend: local

server:
  port: 8420
  host: 0.0.0.0

data:
  baseDir: /data/tdai-memory

llm:
  baseUrl: "${MEMORY_LLM_BASE_URL:-}"
  apiKey: "${MEMORY_LLM_API_KEY:-}"
  model: "${MEMORY_LLM_MODEL:-}"
  maxTokens: 32000
  timeoutMs: 300000

memory:
  # promptMode: code(default, for code engineering scenarios; extracts team-shared memory such as project facts/tasks/decisions/SOPs/taboos)
  #           | chat(for general chat/teaching scenarios; extracts personal memory such as persona/episodic/instruction)
  # Override via MEMORY_PROMPT_MODE in .env.
  # Note: in code mode, pure casual conversation may yield 0 memories (the LLM sees no engineering content worth retaining).
  promptMode: ${MEMORY_PROMPT_MODE:-code}
  capture: { enabled: true }
  extraction:
    enabled: true
    enableDedup: true
    maxMemoriesPerSession: 20
  persona:
    triggerEveryN: 50
    maxScenes: 15
  pipeline:
    everyNConversations: 5
    enableWarmup: true
    l1IdleTimeoutSeconds: 600
    l2DelayAfterL1Seconds: 90
    l2MinIntervalSeconds: 900
    l2MaxIntervalSeconds: 3600
  recall:
    enabled: true
    maxResults: 5
    scoreThreshold: 0.3
    strategy: hybrid
    timeoutMs: 5000
  # In gateway form the storage backend is actually determined by the STORE_MODE environment variable (see docker run -e STORE_MODE);
  # the same value is kept here only for readability; only plugin/SDK forms read this field.
  storeBackend: ${MEMORY_CORE_STORE_MODE}
  embedding:
    provider: none

# ── Skill module ──
skill:
  enabled: true
  routing:
    mode: bm25
    searchTopK: 20
  extraction:
    enabled: true
    maxIterations: 16
    queue:
      backend: local
      keyPrefix: tdai
      resultTtlSeconds: 86400
      lockTtlMs: 600000
      maxRetries: 2
      retryBackoffsMs: [5000, 15000]
  resources:
    maxResourceSizeBytes: 5000000
YAML

info "Starting memory-core (image=$MEMORY_CORE_IMAGE, port=$MEMORY_CORE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-core \
  -p "${MEMORY_CORE_PORT}:8420" \
  -v "${MEMORY_CORE_VOLUME}:/data/tdai-memory" \
  -v "$CORE_CONFIG_FILE:/data/config/tdai-gateway.yaml:ro" \
  -e TDAI_GATEWAY_PORT=8420 \
  -e TDAI_GATEWAY_HOST=0.0.0.0 \
  -e TDAI_GATEWAY_API_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e TDAI_DATA_DIR=/data/tdai-memory \
  -e STORE_MODE="$MEMORY_CORE_STORE_MODE" \
  ${MONGO_ENV_ARGS[@]+"${MONGO_ENV_ARGS[@]}"} \
  "$MEMORY_CORE_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 90
ok "memory-core started → http://localhost:${MEMORY_CORE_PORT}/"

# ── Admin user lifecycle ─────────────────────────────────────────
# First start: pass **our generated random user_key** to init-admin, read it back from the response body and save it to a file.
# Restart when already initialized (409): read .admin-key first; if the volume is newly created but .admin-key is
#   stale, it cannot be recovered (volume/key must stay in sync; prompt the user to clean up).
#
# The init-admin endpoint honors the passed-in user_key (see MemoryCore/src/metadata/store/sqlite-adapter.ts
# defaultKeyValue = input.default_key_value ?? generateUserKey()); as long as the volume is empty
# and we pass a fixed key, we get the key we specified. On first start the script generates a 32-byte random
# base32url -- every machine / every purge gets an independent key, so there are no collisions.

generate_user_key() {
  # sk-mem-<32 chars A-Za-z0-9>, consistent with the format in metadata/utils/user-key.ts
  # Use openssl (portable; tr filters +/= out of base64 down to 32 chars)
  local raw
  if command -v openssl >/dev/null 2>&1; then
    raw=$(openssl rand -base64 48 | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  else
    # Fallback: read enough urandom to guarantee >=32 after filtering
    raw=$(head -c 256 /dev/urandom | LC_ALL=C tr -dc 'A-Za-z0-9' | head -c 32)
  fi
  echo "sk-mem-${raw}"
}

verify_user_key() {
  local key="$1"
  local code
  code=$(/usr/bin/curl -sS -o /dev/null -w "%{http_code}" --max-time 5 \
    -X POST -H "Content-Type: application/json" \
    -H "x-tdai-service-id: default" \
    ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
    "http://localhost:${MEMORY_CORE_PORT}/v3/meta/auth/verify" \
    -d "$(printf '{"user_key":"%s"}' "$key")" 2>/dev/null || echo "000")
  [[ "$code" == "200" ]]
}

info "Initializing admin user (username=${MEMORY_CORE_ADMIN_USERNAME}, key persisted → ${ADMIN_KEY_FILE})..."

# Generate a random key (used for the first init-admin; reuse the file if one exists)
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  info "  Reusing saved admin key (.admin-key already exists)"
else
  ADMIN_KEY=$(generate_user_key)
fi

init_body=$(printf '{"username":"%s","user_key":"%s"}' \
  "$MEMORY_CORE_ADMIN_USERNAME" "$ADMIN_KEY")
init_resp=$(/usr/bin/curl -sS -o /tmp/init-admin.$$ -w "%{http_code}" \
  -X POST -H "Content-Type: application/json" \
  ${MEMORY_CORE_GATEWAY_API_KEY:+-H "Authorization: Bearer ${MEMORY_CORE_GATEWAY_API_KEY}"} \
  -H "x-tdai-service-id: default" \
  "http://localhost:${MEMORY_CORE_PORT}/v3/internal/meta/user/init-admin" \
  -d "$init_body" 2>/dev/null || echo "000")

case "$init_resp" in
  200)
    ok "admin user created"
    # Write the key to disk (tighten the permissions of the host file)
    umask 077
    echo -n "$ADMIN_KEY" > "$ADMIN_KEY_FILE"
    ok "  admin user_key saved to $ADMIN_KEY_FILE"
    ;;
  409)
    if [[ -s "$ADMIN_KEY_FILE" ]]; then
      ok "admin user already exists (skipping init-admin, using the key in $ADMIN_KEY_FILE)"
    else
      warn "admin user already exists, but $ADMIN_KEY_FILE is missing, so user_key cannot be recovered."
      warn "Option A: purge the volume and rebuild -- ./stop-all.sh --purge && ./start-memory-core.sh"
      warn "Option B: manually create a new admin user_key (requires the old key or the gateway apiKey)"
    fi
    ;;
  *)
    warn "init-admin returned HTTP=${init_resp}; manual investigation may be needed:"
    cat /tmp/init-admin.$$ 2>/dev/null; echo
    ;;
esac
rm -f /tmp/init-admin.$$

# ── Verify the admin key works ─────────────────────────────────────────
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  if verify_user_key "$ADMIN_KEY"; then
    # Only print a masked value at the end: the whole string is masked so the terminal history does not keep the full value
    masked="${ADMIN_KEY:0:11}****${ADMIN_KEY: -4}"
    ok "admin user_key verified (auth/verify 200) -- $masked"
    ok "  key file: $ADMIN_KEY_FILE"
  else
    warn "admin user_key verification failed (auth/verify not 200). Check whether $ADMIN_KEY_FILE matches the volume."
  fi
fi
