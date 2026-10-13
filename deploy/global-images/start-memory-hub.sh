#!/usr/bin/env bash
# Start memory-hub on its own (combined panel + knowledge image, ports 8125 + 8424).
#
# Dependency: memory must be up first (knowledge inside memory-hub calls memory for embed/RAG).
# If the memory container does not exist, this script prints a warn but continues (with LLM_MODE=proxy memory-hub
# can start by itself; only knowledge's first call to memory will fail).
#
# Usage:
#   ./start-memory-hub.sh
#
# Requires the following LLM parameters (set in .env):
#   MEMORY_LLM_BASE_URL / MEMORY_LLM_API_KEY / MEMORY_LLM_MODEL

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

load_env
require_vars \
  MEMORY_HUB_IMAGE PANEL_PORT KNOWLEDGE_PORT PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL

# Gateway internal credentials, consistent with memory-core (default local, for local experience only)
MEMORY_CORE_GATEWAY_API_KEY="${MEMORY_CORE_GATEWAY_API_KEY:-local}"

# Ensure the Panel ↔ Knowledge inter-service auth key exists (auto-generated on first run and written back to .env)
ensure_knowledge_service_key

# Base URL shown on the Panel UI "Client Access URL" card (for CodeBuddy / ClaudeCode to copy).
# In the open-source local deployment core and proxy run separately; clients should connect to the proxy, not core/gateway.
#
# By default the externally reachable host address is detected in this order:
#   1) on Linux, the first non-127 IPv4 from `hostname -I` (LAN IP)
#   2) on macOS, the IPv4 of common NICs (en0 / en1)
#   3) if both fail → localhost (same-machine use only; across machines the user must explicitly set MEMORY_HUB_PROXY_PUBLIC_URL)
#
# If the MEMORY_HUB_PROXY_PUBLIC_URL environment variable is explicitly set, the given value is used as is.
# If explicitly set to an empty string, the Panel frontend falls back to gateway_endpoint (old behavior).
# The Panel backend → Kernel forwarding address always uses REMOTE_INSTANCE_URL and is not affected by this variable.
detect_host_ip() {
  local ip=""
  # Linux
  if command -v hostname >/dev/null 2>&1; then
    ip=$(hostname -I 2>/dev/null | tr ' ' '\n' | awk '/^[0-9]+\./ && $0 !~ /^127\./ && $0 !~ /^169\.254\./' | head -n1)
    [[ -n "$ip" ]] && { echo "$ip"; return; }
  fi
  # macOS
  if command -v ipconfig >/dev/null 2>&1; then
    for iface in en0 en1 en2; do
      ip=$(ipconfig getifaddr "$iface" 2>/dev/null)
      [[ -n "$ip" ]] && { echo "$ip"; return; }
    done
  fi
  # Fallback: ip route (on Linux without hostname -I)
  if command -v ip >/dev/null 2>&1; then
    ip=$(ip -4 route get 1 2>/dev/null | awk '/src/ {for (i=1;i<=NF;i++) if ($i=="src") print $(i+1); exit}')
    [[ -n "$ip" ]] && { echo "$ip"; return; }
  fi
  echo "localhost"
}

if [[ -z "${MEMORY_HUB_PROXY_PUBLIC_URL+x}" ]]; then
  # Unset → build the default from the detected IP + PROXY_PORT
  _host_ip=$(detect_host_ip)
  MEMORY_HUB_PROXY_PUBLIC_URL="http://${_host_ip}:${PROXY_PORT:-8096}"
  info "Auto-detected host address: MEMORY_HUB_PROXY_PUBLIC_URL=$MEMORY_HUB_PROXY_PUBLIC_URL"
  info "  (to override, explicitly set in .env: MEMORY_HUB_PROXY_PUBLIC_URL=http://<your-ip>:${PROXY_PORT:-8096})"
fi

CONTAINER=tdai-memory-hub
NETWORK=tdai-memory-stack

if ! $DOCKER network inspect "$NETWORK" >/dev/null 2>&1; then
  info "Creating docker network $NETWORK"
  $DOCKER network create "$NETWORK" >/dev/null
fi

# Remind when memory is not up, without blocking
if ! $DOCKER ps --format '{{.Names}}' 2>/dev/null | grep -qx "tdai-memory-core"; then
  warn "memory-core container is not running. memory-hub can start, but knowledge calls to memory will fail."
  warn "Recommended: run ./start-memory-core.sh first and then come back here, or just run ./start-all.sh"
fi

pull_image "$MEMORY_HUB_IMAGE"
rm_container_if_exists "$CONTAINER"

# Internal knowledge calls the LLM through upstream memory in custom mode, pointing directly at MEMORY_LLM_*
# LLM_MODE=custom → does not go through memory's LLM proxy; knowledge connects directly to the user-provided endpoint
info "Starting memory-hub (image=$MEMORY_HUB_IMAGE, panel=$PANEL_PORT knowledge=$KNOWLEDGE_PORT)"
$DOCKER run -d --name "$CONTAINER" \
  --network "$NETWORK" \
  --network-alias memory-hub \
  --add-host=host.docker.internal:host-gateway \
  -p "${PANEL_PORT}:8125" \
  -p "${KNOWLEDGE_PORT}:8424" \
  -v "${PANEL_VOLUME}:/data/knowledge" \
  -e PANEL_PORT=8125 \
  -e KNOWLEDGE_PORT=8424 \
  -e KNOWLEDGE_PUBLIC_BASE_URL="$KNOWLEDGE_PUBLIC_BASE_URL" \
  -e KNOWLEDGE_SERVICE_KEY="$KNOWLEDGE_SERVICE_KEY" \
  -e KNOWLEDGE_AUTH_TOKEN="$KNOWLEDGE_SERVICE_KEY" \
  -e REMOTE_INSTANCE_ID=default \
  -e REMOTE_INSTANCE_NAME=default \
  -e REMOTE_INSTANCE_URL="http://memory-core:8420" \
  -e REMOTE_INSTANCE_KEY="$MEMORY_CORE_GATEWAY_API_KEY" \
  -e REMOTE_INSTANCE_PROXY_URL="$MEMORY_HUB_PROXY_PUBLIC_URL" \
  -e LLM_MODE=custom \
  -e LLM_PROTOCOL="${MEMORY_LLM_PROTOCOL:-openai}" \
  -e LLM_API_KEY="$MEMORY_LLM_API_KEY" \
  -e LLM_BASE_URL="$MEMORY_LLM_BASE_URL" \
  -e LLM_MODEL="$MEMORY_LLM_MODEL" \
  -e KNOWLEDGE_LLM_BINDING_SYNC=0 \
  "$MEMORY_HUB_IMAGE" >/dev/null

wait_healthy "$CONTAINER" 120
ok "memory-hub started"
ok "  Panel UI  → http://localhost:${PANEL_PORT}/"
ok "  KS Health → http://localhost:${KNOWLEDGE_PORT}/health"
