#!/usr/bin/env bash
# Start the memory → memory-hub → proxy trio with one command (interactive).
#
# Order: start memory (core) first and wait for healthy; then memory-hub (panel + knowledge) and wait for healthy;
# finally start proxy. Any step that fails aborts and prints the container logs.
#
# Usage:
#   ./start-all.sh            # Interactively fill in the LLM (Enter keeps the current value), auto-check connectivity, then start everything once it passes
#   PULL=1 ./start-all.sh     # docker pull all three images first, upgrading to the newest latest
#
# Interactive notes:
#   - if .env does not exist, copy it from .env.example automatically
#   - every run interactively confirms the memory group + proxy group LLM (existing values are defaults; Enter keeps them)
#   - check LLM connectivity right after filling in; on failure, prompt to re-enter until it passes or the user gives up
#   - finally write the entered values back to .env for persistence, reused by default on the next start

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

# Copy from the template when .env does not exist (the interactive flow guides filling in the LLM)
if [[ ! -f "$ENV_FILE" ]]; then
  info ".env does not exist, copying it from .env.example"
  cp "$SCRIPT_DIR/.env.example" "$ENV_FILE"
fi

load_env

# Interactively confirm the two LLM group configs + connectivity check + write back to .env
interactive_llm_setup

# Validate all required parameters at once, to avoid discovering missing proxy parameters only after memory is started
require_vars \
  MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
  MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
  MEMORY_CORE_VOLUME PANEL_VOLUME \
  MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
  KNOWLEDGE_PUBLIC_BASE_URL \
  PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL

# Port pre-check: check all 4 target ports at once and exit with an error if held by an external process,
# to avoid discovering hub/proxy port conflicts only after memory is started. (tdai's own old containers are excluded)
check_ports

info "═══ Step 1/3: memory ═══════════════════════════════════════"
"$SCRIPT_DIR/start-memory-core.sh"

info "═══ Step 2/3: memory-hub ═══════════════════════════════════"
"$SCRIPT_DIR/start-memory-hub.sh"

info "═══ Step 3/3: proxy ════════════════════════════════════════"
# The full pipeline is enabled by default (auth + sessionInit + tdai injection).
# Users can disable it with PROXY_FULL_STACK=0, or override the three switches individually in .env.
PROXY_FULL_STACK="${PROXY_FULL_STACK:-1}" "$SCRIPT_DIR/start-proxy.sh"

ok "═══ All services ready ═════════════════════════════════════════"
print_endpoints

# Print Claude Code / proxy usage commands
ADMIN_KEY_FILE="${MEMORY_CORE_ADMIN_KEY_FILE:-$SCRIPT_DIR/.admin-key}"
if [[ -s "$ADMIN_KEY_FILE" ]]; then
  ADMIN_KEY=$(cat "$ADMIN_KEY_FILE")
  UPSTREAM_MODEL="${PROXY_UPSTREAM_MODEL:-<your-model>}"
  echo ""
  echo "  ┌─ Use Claude Code via proxy ─────────────────────────────────────┐"
  echo "  │  export ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}/claude-code/default"
  echo "  │  export ANTHROPIC_AUTH_TOKEN='${ADMIN_KEY}'"
  echo "  │  claude --model ${UPSTREAM_MODEL}"
  echo "  │"
  echo "  │  admin user_key saved at: $ADMIN_KEY_FILE"
  echo "  └────────────────────────────────────────────────────────────────┘"
fi
echo ""
echo "  View logs:     docker logs -f tdai-memory-core | tdai-memory-hub | tdai-proxy"
echo "  Stop:          ./stop-all.sh"
echo ""
