#!/usr/bin/env bash
# =============================================================================
# install-openclaw-plugin.sh
#
# Purpose: install the "OpenClaw adapter layer" memory plugin (this branch = Memory Gateway v3 client).
#          This is not a Gateway kernel installation; nor is it OpenClaw's built-in flow. OpenClaw itself does not call this script.
#
# Alignment notes:
#   - Plugin directory: MemoryCore/openclaw-plugin/ (flat, v3 only; no v2 client coexisting)
#   - Plugin ID: memory-tencentdb-client (consistent with the historical ID; the semantics are now /v3 + isolation)
#   - SDK     : npm @tencentdb-agent-memory/memory-sdk-ts-v2@1.0.0-beta.2
#               https://www.npmjs.com/package/@tencentdb-agent-memory/memory-sdk-ts-v2/v/1.0.0-beta.2
#               (pulled by the plugin's npm install; the repo's file: local SDK is not the delivery path)
#   - Data plane: v3 MemoryClient → /v3/*; COS file-read bypass tdai_read_file (MemoryFileReader)
#   - Excludes: Offload; the E2E harness (scripts/e2e-openclaw-plugin*) is owned by other colleagues and is not covered by this script
#
# What this script does (a wrapper layer):
#   1. Parse MEMORY_INSTALL_MODE=local|server, validate/fill in endpoint, API Key, instance, isolation
#   2. openclaw-plugin: npm install (pull the SDK) + npm run build
#   3. Call: openclaw plugins install -l <PLUGIN_DIR>
#   4. Write ~/.openclaw/openclaw.json (slots.memory + entries + server/isolation + hooks gating)
#
# If you use only the CLI and not this script: you can still run openclaw plugins install -l manually, but you must npm install/build and write the config yourself.
#
# Examples:
#   # Local Gateway (default)
#   bash scripts/install-openclaw-plugin.sh
#
#   # Remote Gateway
#   MEMORY_INSTALL_MODE=server \
#     TDAI_MEMORY_ENDPOINT="https://..." TDAI_MEMORY_API_KEY="<instance-api-key>" \
#     TDAI_MEMORY_INSTANCE_ID="<instance-id>" \
#     TDAI_MEMORY_TEAM_ID="..." TDAI_MEMORY_AGENT_ID="..." TDAI_MEMORY_USER_ID="..." \
#     bash scripts/install-openclaw-plugin.sh
#
# Design doc: docs/design/2026-07-20-v3-plugin-install-dual-mode-design.md
#
# Note: the local/server environment resolution functions are inlined here (scripts/_lib/ is no longer used).
#       Unit tests can source this script (only loading the functions, without running the main install flow).
# =============================================================================
set -euo pipefail

# ---------------------------------------------------------------------------
# Install env helpers (MEMORY_INSTALL_MODE=local|server)
# ---------------------------------------------------------------------------

memory_install_log() {
  printf '[memory-install] %s\n' "$*" >&2
}

memory_install_fail() {
  printf '[memory-install][ERROR] %s\n' "$*" >&2
  exit 1
}

# Normalize aliases into canonical TDAI_MEMORY_* vars (exported).
memory_normalize_env() {
  if [[ -z "${TDAI_MEMORY_ENDPOINT:-}" && -n "${TDAI_MEMORY_GATEWAY_URL:-}" ]]; then
    export TDAI_MEMORY_ENDPOINT="$TDAI_MEMORY_GATEWAY_URL"
  fi

  # INSTANCE_ID ↔ SERVICE_ID
  if [[ -z "${TDAI_MEMORY_SERVICE_ID:-}" && -n "${TDAI_MEMORY_INSTANCE_ID:-}" ]]; then
    export TDAI_MEMORY_SERVICE_ID="$TDAI_MEMORY_INSTANCE_ID"
  fi
  if [[ -z "${TDAI_MEMORY_INSTANCE_ID:-}" && -n "${TDAI_MEMORY_SERVICE_ID:-}" ]]; then
    export TDAI_MEMORY_INSTANCE_ID="$TDAI_MEMORY_SERVICE_ID"
  fi
}

# Resolve MEMORY_INSTALL_MODE=local|server. Uses explicit value or endpoint heuristic.
# Prints the mode on stdout; also exports MEMORY_INSTALL_MODE.
memory_resolve_mode() {
  memory_normalize_env
  local mode="${MEMORY_INSTALL_MODE:-}"
  local endpoint="${TDAI_MEMORY_ENDPOINT:-}"

  if [[ -z "$mode" ]]; then
    if [[ -z "$endpoint" ]] \
      || [[ "$endpoint" == *"127.0.0.1"* ]] \
      || [[ "$endpoint" == *"localhost"* ]]; then
      mode="local"
    else
      mode="server"
    fi
  fi

  case "$mode" in
    local|server) ;;
    *) memory_install_fail "MEMORY_INSTALL_MODE must be local or server (got: $mode)" ;;
  esac

  export MEMORY_INSTALL_MODE="$mode"
  printf '%s\n' "$mode"
}

# Apply local defaults for auth + isolation (does not overwrite non-empty values).
memory_apply_local_defaults() {
  export TDAI_MEMORY_ENDPOINT="${TDAI_MEMORY_ENDPOINT:-http://127.0.0.1:8420}"
  export TDAI_MEMORY_API_KEY="${TDAI_MEMORY_API_KEY:-local}"
  export TDAI_MEMORY_SERVICE_ID="${TDAI_MEMORY_SERVICE_ID:-default}"
  export TDAI_MEMORY_INSTANCE_ID="${TDAI_MEMORY_INSTANCE_ID:-$TDAI_MEMORY_SERVICE_ID}"
  export TDAI_MEMORY_TEAM_ID="${TDAI_MEMORY_TEAM_ID:-default}"
  export TDAI_MEMORY_AGENT_ID="${TDAI_MEMORY_AGENT_ID:-default}"
  export TDAI_MEMORY_USER_ID="${TDAI_MEMORY_USER_ID:-default}"
}

# Strict server validation. Exit 1 on failure.
memory_validate_server() {
  memory_normalize_env
  local missing=()
  local bad=()

  [[ -n "${TDAI_MEMORY_ENDPOINT:-}" ]] || missing+=(TDAI_MEMORY_ENDPOINT)
  [[ -n "${TDAI_MEMORY_API_KEY:-}" ]] || missing+=(TDAI_MEMORY_API_KEY)
  [[ -n "${TDAI_MEMORY_SERVICE_ID:-}${TDAI_MEMORY_INSTANCE_ID:-}" ]] || missing+=(TDAI_MEMORY_SERVICE_ID/TDAI_MEMORY_INSTANCE_ID)
  [[ -n "${TDAI_MEMORY_TEAM_ID:-}" ]] || missing+=(TDAI_MEMORY_TEAM_ID)
  [[ -n "${TDAI_MEMORY_AGENT_ID:-}" ]] || missing+=(TDAI_MEMORY_AGENT_ID)
  [[ -n "${TDAI_MEMORY_USER_ID:-}" ]] || missing+=(TDAI_MEMORY_USER_ID)

  if ((${#missing[@]} > 0)); then
    memory_install_fail "server mode requires: ${missing[*]}"
  fi

  # Keep INSTANCE_ID / SERVICE_ID in sync after validation inputs
  if [[ -z "${TDAI_MEMORY_SERVICE_ID:-}" && -n "${TDAI_MEMORY_INSTANCE_ID:-}" ]]; then
    export TDAI_MEMORY_SERVICE_ID="$TDAI_MEMORY_INSTANCE_ID"
  fi
  if [[ -z "${TDAI_MEMORY_INSTANCE_ID:-}" && -n "${TDAI_MEMORY_SERVICE_ID:-}" ]]; then
    export TDAI_MEMORY_INSTANCE_ID="$TDAI_MEMORY_SERVICE_ID"
  fi

  local key="${TDAI_MEMORY_API_KEY}"
  local sid="${TDAI_MEMORY_SERVICE_ID:-$TDAI_MEMORY_INSTANCE_ID}"

  if [[ "$key" == "local" || "$key" == "sk-xxxx" ]]; then
    bad+=("TDAI_MEMORY_API_KEY must not be a local placeholder in server mode (got: $key)")
  fi

  if [[ "${ALLOW_DEFAULT_SERVICE_ID:-0}" != "1" ]]; then
    if [[ "$sid" == "default" ]]; then
      bad+=("TDAI_MEMORY_SERVICE_ID/INSTANCE_ID must not be 'default' in server mode (set ALLOW_DEFAULT_SERVICE_ID=1 to override)")
    fi
  fi

  if [[ "${ALLOW_DEFAULT_ISOLATION:-0}" != "1" ]]; then
    if [[ "$TDAI_MEMORY_TEAM_ID" == "default" ]] \
      || [[ "$TDAI_MEMORY_AGENT_ID" == "default" ]] \
      || [[ "$TDAI_MEMORY_USER_ID" == "default" ]]; then
      bad+=("team/agent/user must not be 'default' in server mode (aligns with DEFAULT_ISOLATION_ID local bucket; set ALLOW_DEFAULT_ISOLATION=1 to override)")
    fi
  fi

  if ((${#bad[@]} > 0)); then
    printf '[memory-install][ERROR] server mode validation failed:\n' >&2
    local line
    for line in "${bad[@]}"; do
      printf '  - %s\n' "$line" >&2
    done
    exit 1
  fi
}

# Prepare env for install: resolve mode, apply defaults or validate.
# Exports MEMORY_INSTALL_MODE and all TDAI_MEMORY_* used by installers.
memory_prepare_install_env() {
  local mode
  mode="$(memory_resolve_mode)"
  memory_install_log "MODE=$mode"

  if [[ "$mode" == "local" ]]; then
    memory_apply_local_defaults
  else
    memory_validate_server
    # Ensure both ID aliases are set after validation
    export TDAI_MEMORY_SERVICE_ID="${TDAI_MEMORY_SERVICE_ID:-$TDAI_MEMORY_INSTANCE_ID}"
    export TDAI_MEMORY_INSTANCE_ID="${TDAI_MEMORY_INSTANCE_ID:-$TDAI_MEMORY_SERVICE_ID}"
  fi
}

# Print a redacted summary (no full api key).
memory_log_summary() {
  local key="${TDAI_MEMORY_API_KEY:-}"
  local key_hint="(empty)"
  if [[ -n "$key" ]]; then
    if ((${#key} <= 4)); then
      key_hint="****"
    else
      key_hint="${key:0:2}***${key: -2}"
    fi
  fi

  cat >&2 <<EOF
  MODE=${MEMORY_INSTALL_MODE:-?}
  endpoint=${TDAI_MEMORY_ENDPOINT:-}
  apiKey=${key_hint}
  serviceId/instanceId=${TDAI_MEMORY_SERVICE_ID:-${TDAI_MEMORY_INSTANCE_ID:-}}
  teamId=${TDAI_MEMORY_TEAM_ID:-}
  agentId=${TDAI_MEMORY_AGENT_ID:-}
  userId=${TDAI_MEMORY_USER_ID:-}
EOF
}

# ---------------------------------------------------------------------------
# Main install flow (skipped when this file is sourced by unit tests)
# ---------------------------------------------------------------------------
if [[ "${BASH_SOURCE[0]}" != "${0}" ]]; then
  return 0 2>/dev/null || exit 0
fi

log() { printf '[install-openclaw-plugin] %s\n' "$*" >&2; }
fail() { printf '[install-openclaw-plugin][ERROR] %s\n' "$*" >&2; exit 1; }
need_cmd() { command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# Source root of the OpenClaw adapter memory plugin (v3); can be overridden with OPENCLAW_PLUGIN_DIR
PLUGIN_DIR="${OPENCLAW_PLUGIN_DIR:-$REPO_ROOT/openclaw-plugin}"
INSTALL_OPENCLAW="${INSTALL_OPENCLAW:-1}"
OPENCLAW_INSTALL_FLAGS="${OPENCLAW_INSTALL_FLAGS:-}"
WRITE_OPENCLAW_CONFIG="${WRITE_OPENCLAW_CONFIG:-1}"
OPENCLAW_CONFIG_FILE="${OPENCLAW_CONFIG_FILE:-$HOME/.openclaw/openclaw.json}"
# Consistent with the id in openclaw.plugin.json (historical name; this branch implements v3)
MEMORY_PLUGIN_ID="memory-tencentdb-client"
TDAI_MEMORY_RECALL_MAX_RESULTS="${TDAI_MEMORY_RECALL_MAX_RESULTS:-5}"
TDAI_MEMORY_INCLUDE_PERSONA="${TDAI_MEMORY_INCLUDE_PERSONA:-true}"
TDAI_MEMORY_INCLUDE_SCENE_NAV="${TDAI_MEMORY_INCLUDE_SCENE_NAV:-true}"
TDAI_MEMORY_CAPTURE_ENABLED="${TDAI_MEMORY_CAPTURE_ENABLED:-true}"
TDAI_MEMORY_ALLOW_PROMPT_INJECTION="${TDAI_MEMORY_ALLOW_PROMPT_INJECTION:-true}"
TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS="${TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS:-true}"

need_cmd npm
need_cmd node
need_cmd curl

memory_prepare_install_env
log "Install env:"
memory_log_summary

if [[ ! -d "$PLUGIN_DIR" ]]; then
  fail "OpenClaw plugin directory not found: $PLUGIN_DIR"
fi

if ! command -v openclaw >/dev/null 2>&1; then
  if [[ "$INSTALL_OPENCLAW" == "1" ]]; then
    log "OpenClaw CLI not found; installing from https://get.openclaw.dev"
    curl -fsSL https://get.openclaw.dev | bash
    export PATH="$HOME/.local/bin:$HOME/bin:/usr/local/bin:$PATH"
  else
    fail "OpenClaw CLI not found. Install it first or run with INSTALL_OPENCLAW=1."
  fi
fi

command -v openclaw >/dev/null 2>&1 || fail "OpenClaw CLI still not found after install; please check PATH"
OPENCLAW_VERSION_RAW="$(openclaw --version 2>/dev/null || printf 'unknown')"
log "OpenClaw version: $OPENCLAW_VERSION_RAW"

HOOK_POLICY_MIN="2026.4.24"
WRITE_HOOK_POLICY=0
if [[ "$OPENCLAW_VERSION_RAW" =~ ([0-9]+)\.([0-9]+)\.([0-9]+) ]]; then
  v_major="${BASH_REMATCH[1]}"
  v_minor="${BASH_REMATCH[2]}"
  v_patch="${BASH_REMATCH[3]}"
  IFS=. read -r m_major m_minor m_patch <<<"$HOOK_POLICY_MIN"
  if (( v_major > m_major )) \
     || { (( v_major == m_major )) && (( v_minor > m_minor )); } \
     || { (( v_major == m_major )) && (( v_minor == m_minor )) && (( v_patch >= m_patch )); }; then
    WRITE_HOOK_POLICY=1
  fi
fi
if [[ "$WRITE_HOOK_POLICY" == "1" ]]; then
  log "Detected OpenClaw >= $HOOK_POLICY_MIN — will write hooks.allowPromptInjection / allowConversationAccess"
else
  log "Detected OpenClaw < $HOOK_POLICY_MIN (or version unparseable) — will SKIP hooks.* policy fields"
fi

# SDK comes from npm (@tencentdb-agent-memory/memory-sdk-ts-v2); no local file: build step.
log "Installing plugin dependencies (npm pulls memory-sdk-ts-v2)"
(cd "$PLUGIN_DIR" && npm install)

log "Building plugin"
(cd "$PLUGIN_DIR" && npm run build)

log "Installing linked OpenClaw v3 memory adapter plugin: $PLUGIN_DIR"
# shellcheck disable=SC2086
# OpenClaw native mounting step; the rest of this script handles build + writing the config v3 needs
openclaw plugins install -l "$PLUGIN_DIR" $OPENCLAW_INSTALL_FLAGS

if [[ "$WRITE_OPENCLAW_CONFIG" == "1" ]]; then
  log "Updating OpenClaw config: $OPENCLAW_CONFIG_FILE"
  mkdir -p "$(dirname "$OPENCLAW_CONFIG_FILE")"
  if [[ -f "$OPENCLAW_CONFIG_FILE" ]]; then
    cp "$OPENCLAW_CONFIG_FILE" "$OPENCLAW_CONFIG_FILE.bak.$(date +%Y%m%d%H%M%S)"
  fi

  OPENCLAW_CONFIG_FILE="$OPENCLAW_CONFIG_FILE" \
  MEMORY_PLUGIN_ID="$MEMORY_PLUGIN_ID" \
  TDAI_MEMORY_ENDPOINT="$TDAI_MEMORY_ENDPOINT" \
  TDAI_MEMORY_API_KEY="$TDAI_MEMORY_API_KEY" \
  TDAI_MEMORY_INSTANCE_ID="$TDAI_MEMORY_INSTANCE_ID" \
  TDAI_MEMORY_TEAM_ID="$TDAI_MEMORY_TEAM_ID" \
  TDAI_MEMORY_AGENT_ID="$TDAI_MEMORY_AGENT_ID" \
  TDAI_MEMORY_USER_ID="$TDAI_MEMORY_USER_ID" \
  TDAI_MEMORY_RECALL_MAX_RESULTS="$TDAI_MEMORY_RECALL_MAX_RESULTS" \
  TDAI_MEMORY_INCLUDE_PERSONA="$TDAI_MEMORY_INCLUDE_PERSONA" \
  TDAI_MEMORY_INCLUDE_SCENE_NAV="$TDAI_MEMORY_INCLUDE_SCENE_NAV" \
  TDAI_MEMORY_CAPTURE_ENABLED="$TDAI_MEMORY_CAPTURE_ENABLED" \
  TDAI_MEMORY_ALLOW_PROMPT_INJECTION="$TDAI_MEMORY_ALLOW_PROMPT_INJECTION" \
  TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS="$TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS" \
  WRITE_HOOK_POLICY="$WRITE_HOOK_POLICY" \
  node <<'NODE'
const fs = require('node:fs');

const file = process.env.OPENCLAW_CONFIG_FILE;
const pluginId = process.env.MEMORY_PLUGIN_ID;

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

let config = {};
if (fs.existsSync(file)) {
  const raw = fs.readFileSync(file, 'utf8').trim();
  if (raw) config = JSON.parse(raw);
}

config.plugins ??= {};
config.plugins.slots ??= {};
config.plugins.slots.memory = pluginId;
config.plugins.entries ??= {};

const entry = config.plugins.entries[pluginId] ?? {};
entry.enabled = true;
const writeHookPolicy = process.env.WRITE_HOOK_POLICY === '1';
if (writeHookPolicy) {
  entry.hooks ??= {};
  entry.hooks.allowPromptInjection = parseBool(process.env.TDAI_MEMORY_ALLOW_PROMPT_INJECTION, entry.hooks.allowPromptInjection ?? true);
  entry.hooks.allowConversationAccess = parseBool(process.env.TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS, entry.hooks.allowConversationAccess ?? true);
} else if (entry.hooks && (entry.hooks.allowPromptInjection !== undefined || entry.hooks.allowConversationAccess !== undefined)) {
  delete entry.hooks.allowPromptInjection;
  delete entry.hooks.allowConversationAccess;
  if (Object.keys(entry.hooks).length === 0) delete entry.hooks;
}
entry.config ??= {};
entry.config.server ??= {};
entry.config.recall ??= {};
entry.config.capture ??= {};

entry.config.server.url = process.env.TDAI_MEMORY_ENDPOINT || entry.config.server.url || 'http://127.0.0.1:8420';
entry.config.server.apiKey = process.env.TDAI_MEMORY_API_KEY || entry.config.server.apiKey || 'local';
entry.config.server.instanceId = process.env.TDAI_MEMORY_INSTANCE_ID || entry.config.server.instanceId || 'default';
entry.config.server.teamId = process.env.TDAI_MEMORY_TEAM_ID || entry.config.server.teamId || 'default';
entry.config.server.agentId = process.env.TDAI_MEMORY_AGENT_ID || entry.config.server.agentId || 'default';
entry.config.server.userId = process.env.TDAI_MEMORY_USER_ID || entry.config.server.userId || 'default';
entry.config.recall.maxResults = parsePositiveInt(process.env.TDAI_MEMORY_RECALL_MAX_RESULTS, entry.config.recall.maxResults ?? 5);
entry.config.recall.includePersona = parseBool(process.env.TDAI_MEMORY_INCLUDE_PERSONA, entry.config.recall.includePersona ?? true);
entry.config.recall.includeSceneNav = parseBool(process.env.TDAI_MEMORY_INCLUDE_SCENE_NAV, entry.config.recall.includeSceneNav ?? true);
entry.config.capture.enabled = parseBool(process.env.TDAI_MEMORY_CAPTURE_ENABLED, entry.config.capture.enabled ?? true);

config.plugins.entries[pluginId] = entry;
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
else
  log "Skipping OpenClaw config update because WRITE_OPENCLAW_CONFIG=$WRITE_OPENCLAW_CONFIG"
fi

if [[ "$WRITE_HOOK_POLICY" == "1" ]]; then
  HOOK_SUMMARY="  plugins.entries[\"$MEMORY_PLUGIN_ID\"].hooks.allowPromptInjection = $TDAI_MEMORY_ALLOW_PROMPT_INJECTION
  plugins.entries[\"$MEMORY_PLUGIN_ID\"].hooks.allowConversationAccess = $TDAI_MEMORY_ALLOW_CONVERSATION_ACCESS"
else
  HOOK_SUMMARY="  plugins.entries[\"$MEMORY_PLUGIN_ID\"].hooks.* = (skipped — OpenClaw < $HOOK_POLICY_MIN)"
fi

cat >&2 <<EOF

[install-openclaw-plugin] Done.
Memory plugin configured:
  plugins.slots.memory = "$MEMORY_PLUGIN_ID"
  plugins.entries["$MEMORY_PLUGIN_ID"].enabled = true
$HOOK_SUMMARY
  server.url = "$TDAI_MEMORY_ENDPOINT"
  server.apiKey = "(redacted)"
  server.instanceId = "$TDAI_MEMORY_INSTANCE_ID"
  server.teamId = "$TDAI_MEMORY_TEAM_ID"
  server.agentId = "$TDAI_MEMORY_AGENT_ID"
  server.userId = "$TDAI_MEMORY_USER_ID"

Next steps:
1. Ensure Memory Gateway is running at $TDAI_MEMORY_ENDPOINT (v3 API).
2. Restart OpenClaw Gateway if needed:
   openclaw gateway restart
EOF
