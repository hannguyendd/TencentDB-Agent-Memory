#!/usr/bin/env bash
set -euo pipefail

# First make sure the config directory exists, so that when a user bind-mounts a file, a missing parent directory is not mounted as a directory.
mkdir -p /app/panel/config "${KNOWLEDGE_DATA_DIR:-/data/knowledge}" "$(dirname "${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}")"

# Users can provide a multi-instance config by mounting /app/panel/config/metadata-instances.json;
# in that case the REMOTE_INSTANCE_* env vars are no longer required, and the script will not overwrite that file.
INSTANCES_FILE="/app/panel/config/metadata-instances.json"
USER_PROVIDED_INSTANCES=0
if [[ -f "$INSTANCES_FILE" ]]; then
  USER_PROVIDED_INSTANCES=1
  echo "[start-combined] detected user-provided $INSTANCES_FILE; skipping env-based generation"
fi

if [[ "$USER_PROVIDED_INSTANCES" -ne 1 ]]; then
  : "${REMOTE_INSTANCE_URL:?REMOTE_INSTANCE_URL is required, e.g. http://host.docker.internal:8420 (or mount metadata-instances.json)}"
  : "${REMOTE_INSTANCE_KEY:?REMOTE_INSTANCE_KEY is required, e.g. local or admin gateway key (or mount metadata-instances.json)}"
fi

PANEL_PORT="${PANEL_PORT:-8125}"
KNOWLEDGE_PORT="${KNOWLEDGE_PORT:-8424}"
INSTANCE_ID="${REMOTE_INSTANCE_ID:-default}"
INSTANCE_NAME="${REMOTE_INSTANCE_NAME:-$INSTANCE_ID}"
KS_INTERNAL_URL="http://127.0.0.1:${KNOWLEDGE_PORT}"
# service_url must include the API prefix (/v3); context_proxy joins it into {service_url}/tools/list.
KS_PUBLIC_URL="${KNOWLEDGE_PUBLIC_BASE_URL:-${KS_INTERNAL_URL}/v3}"
PROXY_BASE_URL="${KNOWLEDGE_LLM_PROXY_BASE_URL:-}"

# Only when the user has not provided an instances file, generate a single-instance config from the REMOTE_INSTANCE_* env vars.
# REMOTE_INSTANCE_PROXY_URL is optional:
#   - not set → the proxy_endpoint field is not written, and the Panel UI "client access address" card keeps the old behavior,
#     falling back to gateway_endpoint (in production deployments where the gateway fronts the proxy the two coincide; no change needed)
#   - set → proxy_endpoint is written; the access address shown on the UI card switches to the proxy,
#     but the Panel backend → Kernel forwarding address still uses gateway_endpoint (unaffected)
if [[ "$USER_PROVIDED_INSTANCES" -ne 1 ]]; then
# Only when non-empty is a proxy_endpoint line added to the dict literal; when empty it does not appear at all, preserving the old behavior.
PROXY_ENDPOINT_LINE=""
if [[ -n "${REMOTE_INSTANCE_PROXY_URL:-}" ]]; then
  PROXY_ENDPOINT_LINE="    'proxy_endpoint': '${REMOTE_INSTANCE_PROXY_URL}',"
fi
python3 - <<PY
import json
from pathlib import Path
p=Path('$INSTANCES_FILE')
p.write_text(json.dumps({
  'instances': [{
    'id': '${INSTANCE_ID}',
    'name': '${INSTANCE_NAME}',
    'gateway_endpoint': '${REMOTE_INSTANCE_URL}',
${PROXY_ENDPOINT_LINE}
    'api_key': '${REMOTE_INSTANCE_KEY}',
  }]
}, ensure_ascii=False, indent=2) + '\n')
PY
fi

cleanup() {
  jobs -p | xargs -r kill 2>/dev/null || true
}
trap cleanup INT TERM EXIT

export API_PREFIX="${API_PREFIX:-/v3}"
export KNOWLEDGE_DATA_DIR="${KNOWLEDGE_DATA_DIR:-/data/knowledge}"
export KNOWLEDGE_DB_PATH="${KNOWLEDGE_DB_PATH:-/data/knowledge/knowledge.db}"
export TDAI_AGENT_TEMPLATE_DIR="${TDAI_AGENT_TEMPLATE_DIR:-/data/knowledge/agent-templates}"
export KNOWLEDGE_PUBLIC_BASE_URL="${KS_PUBLIC_URL}"
export TMC_CALLBACK_URL="${TMC_CALLBACK_URL:-http://127.0.0.1:${PANEL_PORT}}"

# Logs go to files (persisted under /data/knowledge/logs/, not lost on container restart) + stdout (visible via docker logs).
# Panel and KS each get their own file, to avoid mixing them together and making troubleshooting hard.
LOG_DIR="${LOG_DIR:-/data/knowledge/logs}"
mkdir -p "$LOG_DIR"
PANEL_LOG="$LOG_DIR/panel.log"
KNOWLEDGE_LOG="$LOG_DIR/knowledge.log"
# Rotate once on every start (keep the previous one as .prev), to avoid unbounded growth of a single file.
[[ -f "$PANEL_LOG" ]] && mv "$PANEL_LOG" "$PANEL_LOG.prev"
[[ -f "$KNOWLEDGE_LOG" ]] && mv "$KNOWLEDGE_LOG" "$KNOWLEDGE_LOG.prev"
echo "[start-combined] panel log → $PANEL_LOG" ; echo "[start-combined] knowledge log → $KNOWLEDGE_LOG"

# Knowledge LLM routing (aligned with the variable names read by MemoryKnowledge/src/config.ts).
#   LLM_MODE=proxy (default): wiki ingest goes through context_proxy (depends on panel pushing llm_binding).
#   LLM_MODE=custom: connect directly to an OpenAI-compatible endpoint; requires LLM_API_KEY / LLM_BASE_URL.
export LLM_MODE="${LLM_MODE:-proxy}"
export LLM_PROVIDER="${LLM_PROVIDER:-custom}"
export LLM_API_KEY="${LLM_API_KEY:-}"
export LLM_BASE_URL="${LLM_BASE_URL:-}"
export LLM_MODEL="${LLM_MODEL:-Memory-Model}"
export LLM_MAX_TOKENS="${LLM_MAX_TOKENS:-32768}"
export LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-1200000}"

# On startup the Panel pushes a mode=proxy llm_binding for each instance to knowledge.
# When LLM_MODE=proxy sync is forced (proxy mode needs a binding to work);
# When LLM_MODE=custom the user decides KNOWLEDGE_LLM_BINDING_SYNC (still defaults to 1).
SYNC_ENV="${KNOWLEDGE_LLM_BINDING_SYNC:-1}"
if [[ "${LLM_MODE}" == "proxy" ]]; then
  SYNC_ENV=1
fi

cd /app/knowledge
PORT="${KNOWLEDGE_PORT}" LOG_LEVEL="${LOG_LEVEL:-info}" \
  KNOWLEDGE_SERVICE_KEY="${KNOWLEDGE_SERVICE_KEY:-}" \
  node "$(test -f dist/server.js && echo dist/server.js || echo dist/server.mjs)" 2>&1 \
  | tee -a "$KNOWLEDGE_LOG" &
KNOWLEDGE_PID=$!

# Wait for KS to be ready before starting panel: on startup the panel calls KS /v3/internal/llm-binding/status
# to check whether the binding exists (ensureKnowledgeLlmBindings); if KS is not up, fetch fails.
for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${KNOWLEDGE_PORT}/health" >/dev/null 2>&1; then
    echo "knowledge service ready on :${KNOWLEDGE_PORT}"
    break
  fi
  sleep 0.5
  if ! kill -0 "$KNOWLEDGE_PID" 2>/dev/null; then
    echo "knowledge service exited before ready" >&2
    wait "$KNOWLEDGE_PID"
  fi
done

cd /app/panel
HOST=0.0.0.0 \
PORT="${PANEL_PORT}" \
UI_DIST_DIR=/app/panel/web/dist \
METADATA_INSTANCES_CONFIG=/app/panel/config/metadata-instances.json \
METADATA_REMOTE_TIMEOUT_MS="${METADATA_REMOTE_TIMEOUT_MS:-15000}" \
KNOWLEDGE_SERVICE_URL="${KS_INTERNAL_URL}" \
KNOWLEDGE_AUTH_TOKEN="${KNOWLEDGE_AUTH_TOKEN:-}" \
KNOWLEDGE_TIMEOUT_MS="${KNOWLEDGE_TIMEOUT_MS:-15000}" \
KNOWLEDGE_LLM_BINDING_SYNC="${SYNC_ENV}" \
KNOWLEDGE_LLM_PROXY_BASE_URL="${PROXY_BASE_URL}" \
LOG_LEVEL="${LOG_LEVEL:-info}" \
LOG_FORMAT="${LOG_FORMAT:-json}" \
node dist/index.js 2>&1 \
  | tee -a "$PANEL_LOG" &
PANEL_PID=$!

for i in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:${PANEL_PORT}/health" >/dev/null 2>&1; then
    echo "combined service ready: panel=:${PANEL_PORT}, knowledge=:${KNOWLEDGE_PORT}, instance=${INSTANCE_ID}"
    break
  fi
  sleep 0.5
  if ! kill -0 "$PANEL_PID" 2>/dev/null; then
    echo "panel service exited" >&2
    wait "$PANEL_PID"
  fi
done

wait -n "$KNOWLEDGE_PID" "$PANEL_PID"
