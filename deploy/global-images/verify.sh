#!/usr/bin/env bash
# Dry-run verification: starts no containers, only checks whether the environment is ready.
#
# Usage:
#   ./verify.sh               # Full check by default (including LLM connectivity pre-check)
#   ./verify.sh --skip-llm    # Skip the LLM check (for offline environments or when external requests are unwanted)
#
# Checks:
#   1. docker command available
#   2. .env file exists
#   3. all required parameters in .env are filled in (not REPLACE_ME and not empty)
#   4. whether the three images are present locally (absent locally is not a failure, only a warn)
#   5. whether target ports are in use
#   6. LLM upstream connectivity (memory group + proxy group, each pre-checked)
#      - openai protocol: GET {base}/models, consumes no tokens
#      - anthropic protocol: POST {base}/v1/messages max_tokens=1, consuming ≤ 10 tokens
#      - if the containers are already running, additionally docker exec a second request from inside the container (verifies container → LLM network reachability)
#
# All pass → exit 0; any error → exit 1; warn only → exit 0

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./_lib.sh
source "$SCRIPT_DIR/_lib.sh"

SKIP_LLM=0
for arg in "$@"; do
  case "$arg" in
    --skip-llm) SKIP_LLM=1 ;;
    --help|-h)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *) warn "Unknown argument: ${arg} (ignored)" ;;
  esac
done

ERRORS=0
WARNS=0
CURL=/usr/bin/curl

# ─── LLM connectivity check functions ───────────────────────────────────────────────
# check_llm_openai <label> <base_url> <api_key> <model>
#   OpenAI-compatible: GET {base}/models only verifies auth+URL and consumes no tokens.
#   base_url may or may not include /v1; normalized here.
check_llm_openai() {
  local label="$1" base="$2" key="$3" model="$4"
  # Normalize: strip trailing /, strip the /messages or /chat/completions suffix
  base="${base%/}"
  base="${base%/messages}"
  base="${base%/chat/completions}"
  local url="${base}/models"
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 10 -o "$body_file" -w "%{http_code}" \
    -H "Authorization: Bearer $key" \
    "$url" 2>/dev/null || echo "000")
  if [[ "$code" == "200" ]]; then
    # Try to check whether the model is in the list (loose match; a mismatch only warns)
    if grep -q "\"$model\"" "$body_file" 2>/dev/null; then
      ok "$label OpenAI protocol connectivity OK ($model is in the /models list)"
    else
      ok "$label OpenAI protocol connectivity OK (${model} not explicitly listed in /models, it may still be usable)"
    fi
    rm -f "$body_file"
    return 0
  elif [[ "$code" == "401" || "$code" == "403" ]]; then
    echo "${C_RED}[error]${C_RST} $label API key invalid (HTTP ${code}): $url" >&2
    head -c 200 "$body_file" >&2; echo >&2
    rm -f "$body_file"
    return 1
  elif [[ "$code" == "404" ]]; then
    # Some providers have no /models endpoint; switch to anthropic style or skip: warn, not error
    warn "$label GET /models 404 -- this provider may not have the endpoint, falling back to the anthropic protocol check"
    check_llm_anthropic "$label" "$base" "$key" "$model"
    rm -f "$body_file"
    return $?
  else
    warn "$label cannot reach ${url} (HTTP=${code})$(head -c 100 "$body_file" 2>/dev/null)"
    rm -f "$body_file"
    return 1
  fi
}

# check_llm_anthropic <label> <base_url> <api_key> <model>
#   Anthropic: POST {base}/v1/messages with max_tokens=1, consuming ≤ 10 tokens but verifying URL/auth/model at the same time.
check_llm_anthropic() {
  local label="$1" base="$2" key="$3" model="$4"
  base="${base%/}"
  # Normalize: use as is if it already contains /messages; otherwise append /v1/messages
  local url
  if [[ "$base" == */messages ]]; then
    url="$base"
  elif [[ "$base" == */v1 ]]; then
    url="${base}/messages"
  else
    url="${base}/v1/messages"
  fi
  local code body_file=/tmp/llm-check.$$
  code=$("$CURL" -sS --max-time 15 -o "$body_file" -w "%{http_code}" \
    -X POST -H "Content-Type: application/json" \
    -H "x-api-key: $key" \
    -H "Authorization: Bearer $key" \
    -H "anthropic-version: 2023-06-01" \
    -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
    "$url" 2>/dev/null || echo "000")
  case "$code" in
    200)
      ok "$label Anthropic protocol connectivity OK (model $model responded)"
      rm -f "$body_file"; return 0 ;;
    401|403)
      echo "${C_RED}[error]${C_RST} $label API key invalid (HTTP ${code}): $url" >&2
      head -c 200 "$body_file" >&2; echo >&2
      rm -f "$body_file"; return 1 ;;
    404)
      echo "${C_RED}[error]${C_RST} $label URL not found (HTTP 404): $url -- check BASE_URL" >&2
      rm -f "$body_file"; return 1 ;;
    400)
      # 400 is commonly caused by a nonexistent model name or body validation failure
      if grep -qE "model.*not.*found|invalid.*model|model_not_found" "$body_file" 2>/dev/null; then
        echo "${C_RED}[error]${C_RST} $label model name '$model' is invalid (HTTP 400)" >&2
        rm -f "$body_file"; return 1
      fi
      warn "$label HTTP 400 (possibly a parameter format issue, not a connectivity error): $(head -c 150 "$body_file")"
      rm -f "$body_file"; return 0 ;;
    *)
      warn "$label cannot reach ${url} (HTTP=${code})$(head -c 100 "$body_file" 2>/dev/null)"
      rm -f "$body_file"; return 1 ;;
  esac
}

# check_llm_group <label> <base_url> <api_key> <model> <protocol>
check_llm_group() {
  local label="$1" base="$2" key="$3" model="$4" proto="${5:-openai}"
  info "Checking $label connectivity (protocol=${proto}, base=${base}, model=${model})..."
  case "$proto" in
    anthropic) check_llm_anthropic "$label" "$base" "$key" "$model" ;;
    *)         check_llm_openai    "$label" "$base" "$key" "$model" ;;
  esac
}

# In-container curl verification (optional, only when the container is running)
check_llm_from_container() {
  local container="$1" label="$2" base="$3" key="$4" model="$5" proto="${6:-openai}"
  if ! $DOCKER ps --format '{{.Names}}' | grep -qx "$container"; then
    return 0  # container not running, skipping (not an error)
  fi
  info "  ↳ Re-testing $label from inside container $container..."
  # The focus is "network reachability": getting any HTTP status code counts as reachable; only 000 is unreachable.
  # Auth errors were already reported on the host side, so they are not raised again from inside the container.
  local url code
  case "$proto" in
    anthropic)
      base="${base%/}"; [[ "$base" == */messages ]] || base="${base}/v1/messages"
      url="$base"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 15 \
         -w "%{http_code}" -X POST -H "Content-Type: application/json" \
         -H "x-api-key: $key" -H "anthropic-version: 2023-06-01" \
         -d "{\"model\":\"$model\",\"max_tokens\":1,\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}" \
         "$url" 2>/dev/null || echo "000")
      ;;
    *)
      base="${base%/}"; base="${base%/v1}"
      url="${base}/v1/models"
      code=$($DOCKER exec "$container" curl -sS -o /dev/null --max-time 10 \
         -w "%{http_code}" -H "Authorization: Bearer $key" "$url" 2>/dev/null || echo "000")
      ;;
  esac
  if [[ "$code" == "000" ]]; then
    warn "  container ${container} cannot reach ${url} (network isolation / DNS failure)"
    WARNS=$((WARNS+1))
  else
    ok "  container ${container} → $label network reachable (HTTP ${code})"
  fi
}

# 1. docker
if command -v "$DOCKER" >/dev/null 2>&1 || [[ -x "$DOCKER" ]]; then
  ok "docker available: $DOCKER"
else
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} docker not available" >&2
fi

# 2. .env
if [[ ! -f "$ENV_FILE" ]]; then
  ERRORS=$((ERRORS+1))
  echo "${C_RED}[error]${C_RST} $ENV_FILE does not exist. Run: cp .env.example .env" >&2
else
  ok ".env exists"
  set -a; source "$ENV_FILE"; set +a

  # 3. Required parameters
  MISSING=()
  for var in \
    MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE \
    MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT \
    MEMORY_CORE_VOLUME PANEL_VOLUME \
    MEMORY_LLM_BASE_URL MEMORY_LLM_API_KEY MEMORY_LLM_MODEL \
    KNOWLEDGE_PUBLIC_BASE_URL \
    PROXY_UPSTREAM_URL PROXY_UPSTREAM_API_KEY PROXY_UPSTREAM_MODEL; do
    val="${!var:-}"
    if [[ -z "$val" || "$val" == "REPLACE_ME" ]]; then
      MISSING+=("$var")
    fi
  done
  if (( ${#MISSING[@]} > 0 )); then
    ERRORS=$((ERRORS+1))
    echo "${C_RED}[error]${C_RST} The following required parameters are not set:${MISSING[*]}" >&2
  else
    ok "All required parameters are filled in"
  fi

  # 4. Whether images exist locally
  for img_var in MEMORY_CORE_IMAGE MEMORY_HUB_IMAGE PROXY_IMAGE; do
    img="${!img_var:-}"
    if [[ -z "$img" ]]; then continue; fi
    if $DOCKER image inspect "$img" >/dev/null 2>&1; then
      ok "image exists locally: $img"
    else
      WARNS=$((WARNS+1))
      warn "image not present locally, will pull at startup: $img"
    fi
  done

  # 5. Port usage (reminder only)
  for port_var in MEMORY_CORE_PORT PANEL_PORT KNOWLEDGE_PORT PROXY_PORT; do
    port="${!port_var:-}"
    if [[ -z "$port" ]]; then continue; fi
    if lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      WARNS=$((WARNS+1))
      warn "Port $port ($port_var) is already in use; free it or change the port in .env before starting"
    else
      ok "Port $port ($port_var) is free"
    fi
  done

  # 6. LLM connectivity (checked by default, --skip-llm to skip)
  if (( SKIP_LLM == 1 )); then
    info "Skipping LLM connectivity check (--skip-llm)"
  elif (( ${#MISSING[@]} > 0 )); then
    warn "Skipping LLM connectivity check (required parameters incomplete)"
  else
    echo ""
    info "═══ LLM connectivity check ═══════════════════════════════════════"

    # memory group
    if ! check_llm_group "memory group" "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" \
         "$MEMORY_LLM_MODEL" "${MEMORY_LLM_PROTOCOL:-openai}"; then
      ERRORS=$((ERRORS+1))
    fi
    # If the container is running, verify from inside it too
    check_llm_from_container tdai-memory-hub "memory group (from container)" \
      "$MEMORY_LLM_BASE_URL" "$MEMORY_LLM_API_KEY" "$MEMORY_LLM_MODEL" \
      "${MEMORY_LLM_PROTOCOL:-openai}"

    # proxy group (if identical to the memory group, the user entered the same config, so check only once)
    if [[ "$PROXY_UPSTREAM_URL" == "$MEMORY_LLM_BASE_URL" && \
          "$PROXY_UPSTREAM_API_KEY" == "$MEMORY_LLM_API_KEY" && \
          "$PROXY_UPSTREAM_MODEL" == "$MEMORY_LLM_MODEL" ]]; then
      ok "proxy group is identical to memory group, skipping duplicate check"
    else
      # proxy group uses the openai protocol by default (consistent with config.yaml)
      if ! check_llm_group "proxy group" "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" \
           "$PROXY_UPSTREAM_MODEL" openai; then
        ERRORS=$((ERRORS+1))
      fi
      check_llm_from_container tdai-proxy "proxy group (from container)" \
        "$PROXY_UPSTREAM_URL" "$PROXY_UPSTREAM_API_KEY" "$PROXY_UPSTREAM_MODEL" openai
    fi
  fi
fi

echo ""
if (( ERRORS > 0 )); then
  echo "${C_RED}✗ ${ERRORS} errors, ${WARNS} warnings -- cannot start${C_RST}" >&2
  exit 1
elif (( WARNS > 0 )); then
  echo "${C_YLW}⚠ ${WARNS} warnings -- can start, but note the messages above${C_RST}"
  exit 0
else
  echo "${C_GRN}✓ All checks passed -- you can run ./start-all.sh directly${C_RST}"
  exit 0
fi
