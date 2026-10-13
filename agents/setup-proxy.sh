#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# agents/setup-proxy.sh — One-shot interactive proxy configuration for AI agents
#
# Supports: Claude Code | CodeBuddy | Codex | WorkBuddy | dsh | Hermes | OpenClaw
#
# Usage:
#   bash agents/setup-proxy.sh            # interactive
#   bash agents/setup-proxy.sh --agent claude-code --quick   # skip confirmations
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ─── Colors & Helpers ─────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; BLUE='\033[0;34m'
CYAN='\033[0;36m'; BOLD='\033[1m'; DIM='\033[2m'; RESET='\033[0m'

info()    { echo -e "${BLUE}ℹ${RESET}  $*"; }
success() { echo -e "${GREEN}✔${RESET}  $*"; }
warn()    { echo -e "${YELLOW}⚠${RESET}  $*"; }
error()   { echo -e "${RED}✖${RESET}  $*" >&2; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${RESET}\n"; }
prompt_input() {
  local varname="$1" prompt="$2" default="${3:-}"
  if [[ -n "$default" ]]; then
    echo -en "${BOLD}?${RESET} ${prompt} ${DIM}[${default}]${RESET}: "
    read -r val
    eval "$varname=\"\${val:-$default}\""
  else
    echo -en "${BOLD}?${RESET} ${prompt}: "
    read -r val
    eval "$varname=\"\$val\""
  fi
}

# numbered list selector, sets SELECTED_IDX (0-based) and SELECTED_VAL
select_one() {
  local prompt="$1"; shift
  local options=("$@")
  echo -e "${BOLD}?${RESET} ${prompt}"
  for i in "${!options[@]}"; do
    echo -e "  ${CYAN}$((i+1))${RESET}) ${options[$i]}"
  done
  while true; do
    echo -en "  ${DIM}Enter number [1-${#options[@]}]${RESET}: "
    read -r num
    if [[ "$num" =~ ^[0-9]+$ ]] && (( num >= 1 && num <= ${#options[@]} )); then
      SELECTED_IDX=$((num - 1))
      SELECTED_VAL="${options[$SELECTED_IDX]}"
      return 0
    fi
    echo -e "  ${RED}Invalid choice, try again${RESET}"
  done
}

confirm() {
  local prompt="$1" default="${2:-y}"
  local hint="[Y/n]"
  [[ "$default" == "n" ]] && hint="[y/N]"
  echo -en "${BOLD}?${RESET} ${prompt} ${DIM}${hint}${RESET}: "
  read -r ans
  ans="${ans:-$default}"
  # Don't use ${ans,,}: that is bash 4+ syntax, and the bash 3.2 bundled with macOS reports bad substitution.
  # Use tr to lowercase instead; equivalent and compatible with all bash versions.
  ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
  [[ "$ans" == "y" || "$ans" == "yes" ]]
}

backup_file() {
  local filepath="$1"
  if [[ -f "$filepath" ]]; then
    local bak="${filepath}.bak.$(date +%Y%m%d_%H%M%S)"
    cp "$filepath" "$bak"
    info "Backed up: ${DIM}${bak}${RESET}"
  fi
}

ensure_dir() {
  local dir
  dir="$(dirname "$1")"
  [[ -d "$dir" ]] || mkdir -p "$dir"
}

check_jq() {
  if ! command -v jq &>/dev/null; then
    error "jq is required but not found. Install: apt install jq / brew install jq"
    exit 1
  fi
}

# ─── Constants ────────────────────────────────────────────────────────────────
AGENTS=("claude-code" "codebuddy" "codex" "workbuddy" "dsh" "hermes" "openclaw")
AGENT_LABELS=(
  "Claude Code       — Anthropic Messages, ~/.claude/settings.json"
  "CodeBuddy         — OpenAI Chat, ~/.codebuddy/models.json"
  "Codex             — OpenAI Responses, ~/.codex/config.toml"
  "WorkBuddy         — OpenAI Responses/Chat, ~/.workbuddy/models.json"
  "dsh (DeepSeek)    — OpenAI Chat, ~/.dsh/settings.yaml + .credentials.yaml"
  "Hermes            — OpenAI Chat + Header preselection, ~/.hermes/config.yaml"
  "OpenClaw          — OpenAI Chat + Header preselection, ~/.openclaw/openclaw.json"
)

DEFAULT_CONFIG_PATHS=(
  "~/.claude/settings.json"
  "~/.codebuddy/models.json"
  "~/.codex/config.toml"
  "~/.workbuddy/models.json"
  "~/.dsh/settings.yaml"
  "~/.hermes/config.yaml"
  "~/.openclaw/openclaw.json"
)

# Expand ~ to $HOME for actual file operations
expand_path() { echo "${1/#\~/$HOME}"; }

# For agents that need header preselect
HEADER_AGENTS=("hermes" "openclaw")

# ─── Parse args ───────────────────────────────────────────────────────────────
ARG_AGENT="" ; ARG_QUICK=false ; ARG_NONINTERACTIVE=false
ARG_PROXY="" ; ARG_INSTANCE="" ; ARG_KEY="" ; ARG_MODEL=""
ARG_TEAM_ID="" ; ARG_AGENT_ID="" ; ARG_TASK_ID="" ; ARG_CONV_ID=""
ARG_CONFIG_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --agent)          ARG_AGENT="$2"; shift 2 ;;
    --quick)          ARG_QUICK=true; shift ;;
    --non-interactive) ARG_NONINTERACTIVE=true; shift ;;
    --proxy-host)     ARG_PROXY="$2"; shift 2 ;;
    --instance-id)    ARG_INSTANCE="$2"; shift 2 ;;
    --user-key)       ARG_KEY="$2"; shift 2 ;;
    --model)          ARG_MODEL="$2"; shift 2 ;;
    --team-id)        ARG_TEAM_ID="$2"; shift 2 ;;
    --agent-id)       ARG_AGENT_ID="$2"; shift 2 ;;
    --task-id)        ARG_TASK_ID="$2"; shift 2 ;;
    --conv-id)        ARG_CONV_ID="$2"; shift 2 ;;
    --config-path)    ARG_CONFIG_PATH="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: $0 [OPTIONS]"
      echo ""
      echo "Interactive mode (default):"
      echo "  --agent <name>     Pre-select agent"
      echo "  --quick            Skip confirmations"
      echo ""
      echo "Non-interactive mode (all params required):"
      echo "  --non-interactive  Skip all prompts, use flags below"
      echo "  --proxy-host URL   Proxy address (e.g. http://127.0.0.1:8096)"
      echo "  --instance-id ID   Memory instance ID (default: default)"
      echo "  --user-key KEY     User API key"
      echo "  --model MODEL      Upstream model ID"
      echo "  --agent <name>     Agent to configure"
      echo "  --config-path PATH Override config file path"
      echo ""
      echo "  For Hermes/OpenClaw (header preselect):"
      echo "  --team-id ID       Team ID"
      echo "  --agent-id ID      Agent ID (the memory agent, not the client)"
      echo "  --task-id ID       Task ID (or 'no-task')"
      echo "  --conv-id ID       Conversation ID"
      echo ""
      echo "Agents: claude-code|codebuddy|codex|workbuddy|dsh|hermes|openclaw"
      exit 0 ;;
    *) error "Unknown arg: $1"; exit 1 ;;
  esac
done

# ─── Non-interactive fast path ────────────────────────────────────────────────
if $ARG_NONINTERACTIVE; then
  # Validate required params
  [[ -z "$ARG_PROXY" ]] && { error "--proxy-host is required in non-interactive mode"; exit 1; }
  [[ -z "$ARG_KEY" ]] && { error "--user-key is required in non-interactive mode"; exit 1; }
  [[ -z "$ARG_AGENT" ]] && { error "--agent is required in non-interactive mode"; exit 1; }
  [[ -z "$ARG_MODEL" ]] && { error "--model is required in non-interactive mode"; exit 1; }

  PROXY_HOST="${ARG_PROXY%/}"
  INSTANCE_ID="${ARG_INSTANCE:-default}"
  USER_KEY="$ARG_KEY"
  MODEL_ID="$ARG_MODEL"

  # Resolve agent index
  AGENT_FOUND=false
  for i in "${!AGENTS[@]}"; do
    if [[ "${AGENTS[$i]}" == "$ARG_AGENT" ]]; then
      SELECTED_IDX=$i; AGENT_FOUND=true; break
    fi
  done
  $AGENT_FOUND || { error "Unknown agent: $ARG_AGENT"; exit 1; }

  CHOSEN_AGENT="$ARG_AGENT"
  CHOSEN_CONFIG_PATH="${DEFAULT_CONFIG_PATHS[$SELECTED_IDX]}"
  TEAM_ID="$ARG_TEAM_ID"
  AGENT_ID="$ARG_AGENT_ID"
  TASK_ID="$ARG_TASK_ID"
  CONVERSATION_ID="${ARG_CONV_ID:-conv-$(date +%Y%m%d)-$(head -c 4 /dev/urandom | xxd -p)}"

  # Config path
  if [[ -n "$ARG_CONFIG_PATH" ]]; then
    CONFIG_DISPLAY="$ARG_CONFIG_PATH"
    CONFIG_PATH="$(expand_path "$ARG_CONFIG_PATH")"
  else
    CONFIG_DISPLAY="$CHOSEN_CONFIG_PATH"
    CONFIG_PATH="$(expand_path "$CHOSEN_CONFIG_PATH")"
  fi

  # dsh dual-file
  if [[ "$CHOSEN_AGENT" == "dsh" ]]; then
    DSH_SETTINGS_PATH="$CONFIG_PATH"
    DSH_CREDENTIALS_PATH="$(dirname "$CONFIG_PATH")/.credentials.yaml"
    DSH_DISPLAY_SETTINGS="$CONFIG_DISPLAY"
    DSH_DISPLAY_CREDENTIALS="$(dirname "$CONFIG_DISPLAY")/.credentials.yaml"
  fi

  USE_SCANNED=false
  CONFIG_DISPLAY="${CONFIG_DISPLAY:-$CHOSEN_CONFIG_PATH}"

  check_jq
  info "Non-interactive mode: configuring ${CHOSEN_AGENT}..."
fi

# ─── Main Flow ────────────────────────────────────────────────────────────────
if ! $ARG_NONINTERACTIVE; then

echo -e "${BOLD}${CYAN}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║   Memory Proxy — Agent Configuration Wizard             ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${RESET}"

check_jq

# ━━━ Step 0: Scan existing agent configs for proxy settings ━━━━━━━━━━━━━━━━━━
header "Scanning existing configuration"

SCAN_PROXY="" ; SCAN_KEY="" ; SCAN_MODEL="" ; SCAN_INSTANCE=""
SCAN_FOUND=false
SCAN_SOURCES=()

# --- Scan Claude Code (~/.claude/settings.json) ---
_cc_path="$(expand_path "~/.claude/settings.json")"
if [[ -f "$_cc_path" && -s "$_cc_path" ]]; then
  _cc_url=$(jq -r '.env.ANTHROPIC_BASE_URL // empty' "$_cc_path" 2>/dev/null)
  if [[ "$_cc_url" == *"/claude-code/"* ]]; then
    SCAN_PROXY=$(echo "$_cc_url" | sed -E 's|(/claude-code/.*)$||')
    SCAN_INSTANCE=$(echo "$_cc_url" | sed -E 's|.*/claude-code/([^/]+).*|\1|')
    SCAN_KEY=$(jq -r '.env.ANTHROPIC_AUTH_TOKEN // empty' "$_cc_path" 2>/dev/null)
    SCAN_MODEL=$(jq -r '.env.ANTHROPIC_MODEL // empty' "$_cc_path" 2>/dev/null)
    [[ -n "$SCAN_PROXY" ]] && SCAN_FOUND=true && SCAN_SOURCES+=("claude-code → $_cc_path")
  fi
fi

# --- Scan CodeBuddy (~/.codebuddy/models.json) ---
if ! $SCAN_FOUND; then
  _cb_path="$(expand_path "~/.codebuddy/models.json")"
  if [[ -f "$_cb_path" && -s "$_cb_path" ]]; then
    _cb_url=$(jq -r '.models[]? | select(.url and (.url | contains("/codebuddy/"))) | .url' "$_cb_path" 2>/dev/null | head -1)
    if [[ -n "$_cb_url" ]]; then
      SCAN_PROXY=$(echo "$_cb_url" | sed -E 's|(/codebuddy/.*)$||')
      SCAN_INSTANCE=$(echo "$_cb_url" | sed -E 's|.*/codebuddy/([^/]+).*|\1|')
      SCAN_KEY=$(jq -r '.models[]? | select(.url and (.url | contains("/codebuddy/"))) | .apiKey' "$_cb_path" 2>/dev/null | head -1)
      SCAN_MODEL=$(jq -r '.models[]? | select(.url and (.url | contains("/codebuddy/"))) | .id' "$_cb_path" 2>/dev/null | head -1)
      [[ -n "$SCAN_PROXY" ]] && SCAN_FOUND=true && SCAN_SOURCES+=("codebuddy → $_cb_path")
    fi
  fi
fi

# --- Scan WorkBuddy (~/.workbuddy/models.json) ---
if ! $SCAN_FOUND; then
  _wb_path="$(expand_path "~/.workbuddy/models.json")"
  if [[ -f "$_wb_path" && -s "$_wb_path" ]]; then
    _wb_url=$(jq -r '.[]? | select(.url and (.url | contains("/workbuddy/"))) | .url' "$_wb_path" 2>/dev/null | head -1)
    if [[ -n "$_wb_url" ]]; then
      SCAN_PROXY=$(echo "$_wb_url" | sed -E 's|(/workbuddy/.*)$||')
      SCAN_INSTANCE=$(echo "$_wb_url" | sed -E 's|.*/workbuddy/([^/]+).*|\1|')
      SCAN_KEY=$(jq -r '.[]? | select(.url and (.url | contains("/workbuddy/"))) | .apiKey' "$_wb_path" 2>/dev/null | head -1)
      SCAN_MODEL=$(jq -r '.[]? | select(.url and (.url | contains("/workbuddy/"))) | .id' "$_wb_path" 2>/dev/null | head -1)
      [[ -n "$SCAN_PROXY" ]] && SCAN_FOUND=true && SCAN_SOURCES+=("workbuddy → $_wb_path")
    fi
  fi
fi

# --- Scan Codex (~/.codex/config.toml) ---
if ! $SCAN_FOUND; then
  _codex_path="$(expand_path "~/.codex/config.toml")"
  if [[ -f "$_codex_path" && -s "$_codex_path" ]]; then
    _codex_url=$(grep -E '^\s*base_url\s*=' "$_codex_path" 2>/dev/null | head -1 | sed -E 's/.*=\s*"(.*)"/\1/')
    if [[ "$_codex_url" == *"/codex/"* ]]; then
      SCAN_PROXY=$(echo "$_codex_url" | sed -E 's|(/codex/.*)$||')
      SCAN_INSTANCE=$(echo "$_codex_url" | sed -E 's|.*/codex/([^/]+).*|\1|')
      SCAN_KEY=$(grep -E '^\s*experimental_bearer_token\s*=' "$_codex_path" 2>/dev/null | head -1 | sed -E 's/.*=\s*"(.*)"/\1/')
      SCAN_MODEL=$(grep -E '^\s*model\s*=' "$_codex_path" 2>/dev/null | head -1 | sed -E 's/.*=\s*"(.*)"/\1/')
      [[ -n "$SCAN_PROXY" ]] && SCAN_FOUND=true && SCAN_SOURCES+=("codex → $_codex_path")
    fi
  fi
fi

# --- Scan dsh (~/.dsh/settings.yaml) ---
if ! $SCAN_FOUND; then
  _dsh_path="$(expand_path "~/.dsh/settings.yaml")"
  _dsh_cred="$(expand_path "~/.dsh/.credentials.yaml")"
  if [[ -f "$_dsh_path" && -s "$_dsh_path" ]]; then
    _dsh_url=$(grep -E '^\s*baseURL:' "$_dsh_path" 2>/dev/null | head -1 | sed -E 's/.*baseURL:\s*//')
    if [[ "$_dsh_url" == *"/dsh/"* ]]; then
      SCAN_PROXY=$(echo "$_dsh_url" | sed -E 's|(/dsh/.*)$||')
      SCAN_INSTANCE=$(echo "$_dsh_url" | sed -E 's|.*/dsh/([^/]+).*|\1|')
      SCAN_MODEL=$(grep -E '^\s*model:' "$_dsh_path" 2>/dev/null | head -1 | sed -E 's/.*model:\s*//')
      if [[ -f "$_dsh_cred" ]]; then
        SCAN_KEY=$(grep -E '^\s*PROXY_USER_KEY:' "$_dsh_cred" 2>/dev/null | head -1 | sed -E 's/.*PROXY_USER_KEY:\s*//')
      fi
      [[ -n "$SCAN_PROXY" ]] && SCAN_FOUND=true && SCAN_SOURCES+=("dsh → $_dsh_path")
    fi
  fi
fi

# --- Scan Hermes (~/.hermes/config.yaml) ---
if ! $SCAN_FOUND; then
  _hermes_path="$(expand_path "~/.hermes/config.yaml")"
  if [[ -f "$_hermes_path" && -s "$_hermes_path" ]]; then
    _hermes_url=$(grep -E '^\s*base_url:' "$_hermes_path" 2>/dev/null | head -1 | sed -E 's/.*base_url:\s*//')
    if [[ "$_hermes_url" == *"/hermes/"* ]]; then
      SCAN_PROXY=$(echo "$_hermes_url" | sed -E 's|(/hermes/.*)$||')
      SCAN_INSTANCE=$(echo "$_hermes_url" | sed -E 's|.*/hermes/([^/]+).*|\1|')
      SCAN_KEY=$(grep -E '^\s*api_key:' "$_hermes_path" 2>/dev/null | head -1 | sed -E 's/.*api_key:\s*//')
      SCAN_MODEL=$(grep -E '^\s*default:' "$_hermes_path" 2>/dev/null | head -1 | sed -E 's/.*default:\s*//')
      [[ -n "$SCAN_PROXY" ]] && SCAN_FOUND=true && SCAN_SOURCES+=("hermes → $_hermes_path")
    fi
  fi
fi

# --- Scan OpenClaw (~/.openclaw/openclaw.json) ---
if ! $SCAN_FOUND; then
  _oc_path="$(expand_path "~/.openclaw/openclaw.json")"
  if [[ -f "$_oc_path" && -s "$_oc_path" ]]; then
    _oc_url=$(jq -r '.models.providers[]? | select(.baseUrl and (.baseUrl | contains("/openclaw/"))) | .baseUrl' "$_oc_path" 2>/dev/null | head -1)
    if [[ -n "$_oc_url" ]]; then
      SCAN_PROXY=$(echo "$_oc_url" | sed -E 's|(/openclaw/.*)$||')
      SCAN_INSTANCE=$(echo "$_oc_url" | sed -E 's|.*/openclaw/([^/]+).*|\1|')
      SCAN_KEY=$(jq -r '.models.providers[]? | select(.baseUrl and (.baseUrl | contains("/openclaw/"))) | .apiKey' "$_oc_path" 2>/dev/null | head -1)
      SCAN_MODEL=$(jq -r '.models.providers[]? | select(.baseUrl and (.baseUrl | contains("/openclaw/"))) | .models[0].id' "$_oc_path" 2>/dev/null | head -1)
      [[ -n "$SCAN_PROXY" ]] && SCAN_FOUND=true && SCAN_SOURCES+=("openclaw → $_oc_path")
    fi
  fi
fi

# --- Show scan results and let user confirm or override ---
USE_SCANNED=false
if $SCAN_FOUND; then
  success "Existing Proxy configuration detected:"
  echo ""
  echo -e "  Source:     ${DIM}${SCAN_SOURCES[*]}${RESET}"
  echo -e "  Proxy:     ${BOLD}${SCAN_PROXY}${RESET}"
  echo -e "  Instance:  ${BOLD}${SCAN_INSTANCE}${RESET}"
  if [[ ${#SCAN_KEY} -gt 8 ]]; then
    echo -e "  User Key:  ${BOLD}${SCAN_KEY:0:4}...${SCAN_KEY: -4}${RESET}"
  elif [[ -n "$SCAN_KEY" ]]; then
    echo -e "  User Key:  ${BOLD}***${RESET}"
  fi
  echo -e "  Model:     ${BOLD}${SCAN_MODEL}${RESET}"
  echo ""
  if confirm "Use the configuration above? (choose n to enter manually)" "y"; then
    USE_SCANNED=true
    PROXY_HOST="$SCAN_PROXY"
    INSTANCE_ID="${SCAN_INSTANCE:-default}"
    USER_KEY="$SCAN_KEY"
    MODEL_ID="$SCAN_MODEL"
    success "Existing configuration adopted"
  fi
else
  info "No existing Proxy configuration detected; guiding manual input"
fi

# ━━━ Step 1: Proxy address + Instance ID ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if ! $USE_SCANNED; then
  header "Step 1: Proxy Address"

  prompt_input PROXY_HOST "Proxy address (including protocol and port)" "http://127.0.0.1:8096"
  # Strip trailing slash
  PROXY_HOST="${PROXY_HOST%/}"

  prompt_input INSTANCE_ID "Memory instance ID (usually default for local deployments)" "default"

  success "Proxy: ${PROXY_HOST}, Instance: ${INSTANCE_ID}"

  # ━━━ Step 2: User Key ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  header "Step 2: User API Key"

  info "This is the API Key issued by team memory; get it from the panel -> API Key page"
  while true; do
    prompt_input USER_KEY "User Key"
    if [[ -n "$USER_KEY" ]]; then
      break
    fi
    warn "Key cannot be empty, please re-enter"
  done
  # Show only the first and last characters, mask the middle
  if [[ ${#USER_KEY} -gt 8 ]]; then
    success "User Key: ${USER_KEY:0:4}...${USER_KEY: -4}"
  else
    success "User Key: ***"
  fi
fi

# ━━━ Select Agent ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
header "Select the Agent to configure"

if [[ -n "$ARG_AGENT" ]]; then
  # Validate pre-selected agent
  AGENT_FOUND=false
  for i in "${!AGENTS[@]}"; do
    if [[ "${AGENTS[$i]}" == "$ARG_AGENT" ]]; then
      SELECTED_IDX=$i
      SELECTED_VAL="${AGENT_LABELS[$i]}"
      AGENT_FOUND=true
      break
    fi
  done
  if ! $AGENT_FOUND; then
    error "Unknown agent: $ARG_AGENT"
    error "Available: ${AGENTS[*]}"
    exit 1
  fi
  info "Pre-selected: ${AGENTS[$SELECTED_IDX]}"
else
  select_one "Which Agent do you want to configure this time?" "${AGENT_LABELS[@]}"
fi

CHOSEN_AGENT="${AGENTS[$SELECTED_IDX]}"
CHOSEN_CONFIG_PATH="${DEFAULT_CONFIG_PATHS[$SELECTED_IDX]}"
success "Selected: ${CHOSEN_AGENT}"

# ━━━ Model ID ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
if $USE_SCANNED && [[ -n "$MODEL_ID" ]]; then
  header "Model configuration"
  info "Using the scanned model: ${BOLD}${MODEL_ID}${RESET}"
  info "To change it, enter a new model ID; press Enter to keep it unchanged"
  prompt_input MODEL_ID "Model ID" "$MODEL_ID"
else
  header "Model configuration"
  info "Enter the upstream model ID (the Proxy's upstream must support this model)"
  info "e.g.: claude-sonnet-4-20250514, claude-opus-4.7, gpt-5.5, deepseek-r1"

  case "$CHOSEN_AGENT" in
    claude-code) DEFAULT_MODEL="claude-sonnet-4-20250514" ;;
    codex)       DEFAULT_MODEL="claude-opus-4.7" ;;
    dsh)         DEFAULT_MODEL="deepseek-r1" ;;
    *)           DEFAULT_MODEL="claude-sonnet-4-20250514" ;;
  esac

  prompt_input MODEL_ID "Model ID" "$DEFAULT_MODEL"
fi
success "Model: ${MODEL_ID}"

# ━━━ Health Probe (uses the real agent + model) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
header "Proxy health probe"

# Build probe URL based on chosen agent's actual protocol path
case "$CHOSEN_AGENT" in
  claude-code)
    PROBE_URL="${PROXY_HOST}/claude-code/${INSTANCE_ID}/v1/messages"
    PROBE_BODY="{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"stream\":false}"
    ;;
  codex)
    PROBE_URL="${PROXY_HOST}/codex/${INSTANCE_ID}/v1/responses"
    PROBE_BODY="{\"model\":\"${MODEL_ID}\",\"input\":[{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"type\":\"input_text\",\"text\":\"ping\"}]}],\"stream\":false}"
    ;;
  workbuddy)
    # WorkBuddy has dual protocols (Desktop=Responses, Web=Chat); probing with Chat is more universal
    PROBE_URL="${PROXY_HOST}/workbuddy/${INSTANCE_ID}/v1/chat/completions"
    PROBE_BODY="{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"stream\":false}"
    ;;
  dsh)
    # dsh has no /v1
    PROBE_URL="${PROXY_HOST}/dsh/${INSTANCE_ID}/chat/completions"
    PROBE_BODY="{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"stream\":false}"
    ;;
  *)
    # codebuddy / hermes / openclaw → OpenAI Chat
    PROBE_URL="${PROXY_HOST}/${CHOSEN_AGENT}/${INSTANCE_ID}/v1/chat/completions"
    PROBE_BODY="{\"model\":\"${MODEL_ID}\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1,\"stream\":false}"
    ;;
esac

info "Probe URL: ${PROBE_URL}"
info "Probe Model: ${MODEL_ID}"

PROBE_RESPONSE_FILE=$(mktemp)
HTTP_CODE=$(curl -s -w "%{http_code}" \
  --connect-timeout 5 -m 10 \
  -X POST "$PROBE_URL" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d "$PROBE_BODY" \
  -o "$PROBE_RESPONSE_FILE" 2>/dev/null || echo "000")

if [[ "$HTTP_CODE" == "000" ]]; then
  error "Unable to connect to the Proxy (${PROXY_HOST}); please check that the address and port are correct"
  error "Confirm the proxy service is running: docker ps | grep proxy"
  rm -f "$PROBE_RESPONSE_FILE"
  exit 1
elif [[ "$HTTP_CODE" =~ ^2 ]]; then
  success "Proxy connectivity OK, request succeeded (HTTP ${HTTP_CODE})"
elif [[ "$HTTP_CODE" =~ ^4 ]]; then
  # 4xx = proxy alive, show response for transparency
  success "Proxy connectivity OK (HTTP ${HTTP_CODE})"
  PROBE_RESP=$(cat "$PROBE_RESPONSE_FILE" 2>/dev/null)
  if [[ -n "$PROBE_RESP" ]]; then
    info "Response content (for reference):"
    echo -e "  ${DIM}$(echo "$PROBE_RESP" | head -c 500)${RESET}"
  fi
else
  warn "Proxy returned HTTP ${HTTP_CODE}; the service may have a problem"
  PROBE_RESP=$(cat "$PROBE_RESPONSE_FILE" 2>/dev/null)
  if [[ -n "$PROBE_RESP" ]]; then
    error "Response content:"
    echo -e "  ${RED}$(echo "$PROBE_RESP" | head -c 500)${RESET}"
  fi
  if ! confirm "Continue with configuration?" "y"; then
    rm -f "$PROBE_RESPONSE_FILE"
    exit 1
  fi
fi
rm -f "$PROBE_RESPONSE_FILE"

# ━━━ Header Preselect (Hermes/OpenClaw only) ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
TEAM_ID="" ; AGENT_ID="" ; TASK_ID="" ; CONVERSATION_ID=""

needs_header_preselect() {
  for ha in "${HEADER_AGENTS[@]}"; do
    [[ "$ha" == "$1" ]] && return 0
  done
  return 1
}

if needs_header_preselect "$CHOSEN_AGENT"; then
  header "Header preselection configuration (${CHOSEN_AGENT})"
  info "${CHOSEN_AGENT} does not support the interactive Form; team/agent/task IDs must be prefilled in the config file"
  echo ""

  # Ask if user wants to provide Panel address for auto-discovery
  USE_PANEL_API=false
  if confirm "Provide the panel backend address to automatically fetch the Team/Agent/Task lists?" "y"; then
    prompt_input PANEL_URL "Panel backend address (Panel API)" "http://127.0.0.1:8125"
    PANEL_URL="${PANEL_URL%/}"

    # Verify panel connectivity
    PANEL_HTTP=$(curl -s -o /dev/null -w "%{http_code}" \
      --connect-timeout 5 -m 10 \
      "${PANEL_URL}/health" 2>/dev/null || echo "000")

    if [[ "$PANEL_HTTP" == "000" || "$PANEL_HTTP" =~ ^5 ]]; then
      warn "Panel backend unreachable (HTTP ${PANEL_HTTP}); falling back to manual input"
    else
      success "Panel backend connectivity OK"
      USE_PANEL_API=true
    fi
  fi

  if $USE_PANEL_API; then
    # ── Resolve user_id from user_key (needed to filter agents by owner) ──
    RESOLVED_USER_ID=""
    VERIFY_JSON=$(curl -s --connect-timeout 5 -m 10 \
      -X POST "${PANEL_URL}/api/v1/meta/auth/verify" \
      -H "Content-Type: application/json" \
      -H "x-tdai-service-id: ${INSTANCE_ID}" \
      -d "{\"user_key\":\"${USER_KEY}\"}" 2>/dev/null || echo '{}')
    RESOLVED_USER_ID=$(echo "$VERIFY_JSON" | jq -r '.data.user.user_id // empty' 2>/dev/null)
    if [[ -n "$RESOLVED_USER_ID" ]]; then
      info "User: $(echo "$VERIFY_JSON" | jq -r '.data.user.username // empty') (${RESOLVED_USER_ID})"
    fi

    # ── Pick Team ──
    info "Fetching Team list..."
    TEAMS_JSON=$(curl -s --connect-timeout 5 -m 10 \
      -X POST "${PANEL_URL}/api/v1/meta/team/list" \
      -H "Content-Type: application/json" \
      -H "x-tdai-user-key: ${USER_KEY}" \
      -H "x-tdai-service-id: ${INSTANCE_ID}" \
      -d "{\"user_key\":\"${USER_KEY}\"}" 2>/dev/null || echo '{}')

    TEAM_COUNT=$(echo "$TEAMS_JSON" | jq -r '.data.items // .data // [] | length' 2>/dev/null || echo "0")

    if [[ "$TEAM_COUNT" -eq 0 ]]; then
      warn "No Team found (the Key may lack permission or no Team has been created); falling back to manual input"
      USE_PANEL_API=false
    else
      # Build team options — Panel returns {data: {items: [...]}}
      TEAM_NAMES=()
      TEAM_IDS=()
      while IFS= read -r line; do
        TEAM_NAMES+=("$line")
      done < <(echo "$TEAMS_JSON" | jq -r '(.data.items // .data // [])[] | .name // .team_name // .id')
      while IFS= read -r line; do
        TEAM_IDS+=("$line")
      done < <(echo "$TEAMS_JSON" | jq -r '(.data.items // .data // [])[] | .team_id // .id')

      select_one "Select Team:" "${TEAM_NAMES[@]}"
      TEAM_ID="${TEAM_IDS[$SELECTED_IDX]}"
      success "Team: ${TEAM_NAMES[$SELECTED_IDX]} (${TEAM_ID})"

      # ── Pick Agent ──
      info "Fetching Agent list..."
      _agent_body="{\"team_id\":\"${TEAM_ID}\",\"user_key\":\"${USER_KEY}\"}"
      if [[ -n "$RESOLVED_USER_ID" ]]; then
        _agent_body="{\"team_id\":\"${TEAM_ID}\",\"user_key\":\"${USER_KEY}\",\"owner_user_id\":\"${RESOLVED_USER_ID}\"}"
      fi
      AGENTS_JSON=$(curl -s --connect-timeout 5 -m 10 \
        -X POST "${PANEL_URL}/api/v1/meta/agent/list" \
        -H "Content-Type: application/json" \
        -H "x-tdai-user-key: ${USER_KEY}" \
        -H "x-tdai-service-id: ${INSTANCE_ID}" \
        -d "$_agent_body" 2>/dev/null || echo '{}')

      AGENT_COUNT=$(echo "$AGENTS_JSON" | jq -r '.data.items // .data // [] | length' 2>/dev/null || echo "0")

      if [[ "$AGENT_COUNT" -eq 0 ]]; then
        warn "No Agent found under this Team; please enter agent_id manually"
        prompt_input AGENT_ID "Agent ID"
      else
        AGENT_NAMES=()
        AGENT_IDS_LIST=()
        while IFS= read -r line; do
          AGENT_NAMES+=("$line")
        done < <(echo "$AGENTS_JSON" | jq -r '(.data.items // .data // [])[] | .name // .agent_name // .id')
        while IFS= read -r line; do
          AGENT_IDS_LIST+=("$line")
        done < <(echo "$AGENTS_JSON" | jq -r '(.data.items // .data // [])[] | .agent_id // .id')

        select_one "Select Agent:" "${AGENT_NAMES[@]}"
        AGENT_ID="${AGENT_IDS_LIST[$SELECTED_IDX]}"
        success "Agent: ${AGENT_NAMES[$SELECTED_IDX]} (${AGENT_ID})"
      fi

      # ── Pick Task ──
      info "Fetching Task list..."
      TASKS_JSON=$(curl -s --connect-timeout 5 -m 10 \
        -X POST "${PANEL_URL}/api/v1/meta/task/list" \
        -H "Content-Type: application/json" \
        -H "x-tdai-user-key: ${USER_KEY}" \
        -H "x-tdai-service-id: ${INSTANCE_ID}" \
        -d "{\"team_id\":\"${TEAM_ID}\",\"user_key\":\"${USER_KEY}\"}" 2>/dev/null || echo '{}')

      TASK_COUNT=$(echo "$TASKS_JSON" | jq -r '.data.items // .data // [] | length' 2>/dev/null || echo "0")

      if [[ "$TASK_COUNT" -eq 0 ]]; then
        warn "No Task found under this Team"
        if confirm "Skip Task binding (use 'no-task')?" "y"; then
          TASK_ID="no-task"
        else
          prompt_input TASK_ID "Task ID"
        fi
      else
        TASK_NAMES=("Do not associate a task this time (no-task)")
        TASK_IDS_LIST=("no-task")
        while IFS= read -r line; do
          TASK_NAMES+=("$line")
        done < <(echo "$TASKS_JSON" | jq -r '(.data.items // .data // [])[] | .name // .title // .id')
        while IFS= read -r line; do
          TASK_IDS_LIST+=("$line")
        done < <(echo "$TASKS_JSON" | jq -r '(.data.items // .data // [])[] | .task_id // .id')

        select_one "Select Task (optional):" "${TASK_NAMES[@]}"
        TASK_ID="${TASK_IDS_LIST[$SELECTED_IDX]}"
        success "Task: ${TASK_NAMES[$SELECTED_IDX]} (${TASK_ID})"
      fi
    fi
  fi

  # Manual fallback
  if ! $USE_PANEL_API; then
    info "Enter the Header preselection info manually (get the IDs from the corresponding panel pages)"
    prompt_input TEAM_ID "x-team-id (Team ID)"
    prompt_input AGENT_ID "x-agent-id (Agent ID)"
    prompt_input TASK_ID "x-task-id (Task ID, enter no-task if there is no Task)" "no-task"
  fi

  # conversation-id: auto-generate a default
  DEFAULT_CONV_ID="conv-$(date +%Y%m%d)-$(head -c 4 /dev/urandom | xxd -p)"
  prompt_input CONVERSATION_ID "x-conversation-id (conversation identifier, must be changed for each new conversation)" "$DEFAULT_CONV_ID"
  success "Header preselection complete"
else
  header "Header preselection configuration"
  info "${CHOSEN_AGENT} supports the interactive Form; no need to prefill headers (skipped)"
fi

# ━━━ Config File Path & Write ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
header "Writing config file"

# dsh has two files
if [[ "$CHOSEN_AGENT" == "dsh" ]]; then
  DSH_DISPLAY_SETTINGS="~/.dsh/settings.yaml"
  DSH_DISPLAY_CREDENTIALS="~/.dsh/.credentials.yaml"
  info "dsh requires configuring two files:"
  echo -e "  1) ${BOLD}${DSH_DISPLAY_SETTINGS}${RESET}"
  echo -e "  2) ${BOLD}${DSH_DISPLAY_CREDENTIALS}${RESET}"
  if ! confirm "Use the default paths above?" "y"; then
    prompt_input DSH_DISPLAY_SETTINGS "settings.yaml path" "$DSH_DISPLAY_SETTINGS"
    DSH_DISPLAY_CREDENTIALS="$(dirname "$DSH_DISPLAY_SETTINGS")/.credentials.yaml"
    prompt_input DSH_DISPLAY_CREDENTIALS "credentials.yaml path" "$DSH_DISPLAY_CREDENTIALS"
  fi
  DSH_SETTINGS_PATH="$(expand_path "$DSH_DISPLAY_SETTINGS")"
  DSH_CREDENTIALS_PATH="$(expand_path "$DSH_DISPLAY_CREDENTIALS")"
  CONFIG_PATH="$DSH_SETTINGS_PATH"
  CONFIG_DISPLAY="$DSH_DISPLAY_SETTINGS"
else
  info "Default config file path: ${BOLD}${CHOSEN_CONFIG_PATH}${RESET}"
  if confirm "Use this path?" "y"; then
    CONFIG_DISPLAY="$CHOSEN_CONFIG_PATH"
    CONFIG_PATH="$(expand_path "$CHOSEN_CONFIG_PATH")"
  else
    prompt_input CONFIG_DISPLAY "Enter the config file path" "$CHOSEN_CONFIG_PATH"
    CONFIG_PATH="$(expand_path "$CONFIG_DISPLAY")"
  fi
fi

fi  # end if ! $ARG_NONINTERACTIVE

# ─── Write Functions ──────────────────────────────────────────────────────────

write_claude_code() {
  local filepath="$1"
  ensure_dir "$filepath"
  backup_file "$filepath"

  local base_url="${PROXY_HOST}/claude-code/${INSTANCE_ID}"

  local write_fresh=false

  if [[ -f "$filepath" && -s "$filepath" ]]; then
    # File exists and is non-empty — try to merge
    local tmp
    tmp=$(mktemp)
    if jq --arg url "$base_url" \
          --arg key "$USER_KEY" \
          --arg model "$MODEL_ID" \
          '.env = (.env // {}) |
           .env.ANTHROPIC_BASE_URL = $url |
           .env.ANTHROPIC_AUTH_TOKEN = $key |
           .env.ANTHROPIC_MODEL = $model |
           .env.ANTHROPIC_DEFAULT_HAIKU_MODEL = $model |
           .env.ANTHROPIC_DEFAULT_SONNET_MODEL = $model |
           .env.ANTHROPIC_DEFAULT_OPUS_MODEL = $model |
           .env.CLAUDE_CODE_SUBAGENT_MODEL = $model' \
          "$filepath" > "$tmp" 2>/dev/null && [[ -s "$tmp" ]]; then
      mv "$tmp" "$filepath"
    else
      rm -f "$tmp"
      warn "Existing ${filepath} is not valid JSON; it will be overwritten"
      write_fresh=true
    fi
  else
    write_fresh=true
  fi

  if $write_fresh; then
    cat > "$filepath" <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "${base_url}",
    "ANTHROPIC_AUTH_TOKEN": "${USER_KEY}",
    "ANTHROPIC_MODEL": "${MODEL_ID}",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "${MODEL_ID}",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "${MODEL_ID}",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "${MODEL_ID}",
    "CLAUDE_CODE_SUBAGENT_MODEL": "${MODEL_ID}"
  }
}
EOF
  fi
  success "Written to ${filepath}"
  echo ""
  info "How to launch:"
  echo -e "  ${GREEN}claude${RESET}   ${DIM}# launch directly; env is read from settings.json${RESET}"
  echo -e "  ${DIM}or: claude --model ${MODEL_ID}${RESET}"
}

write_codebuddy() {
  local filepath="$1"
  ensure_dir "$filepath"
  backup_file "$filepath"

  local base_url="${PROXY_HOST}/codebuddy/${INSTANCE_ID}"
  local new_entry
  new_entry=$(jq -n \
    --arg id "$MODEL_ID" \
    --arg url "$base_url" \
    --arg key "$USER_KEY" \
    '{
      id: $id,
      name: "proxy-memory-agent",
      vendor: "claude",
      apiKey: $key,
      maxInputTokens: 200000,
      url: $url,
      supportsToolCall: true,
      supportsImages: true
    }')

  if [[ -f "$filepath" ]]; then
    local tmp
    tmp=$(mktemp)
    # Remove existing entry with same id, then append
    jq --arg id "$MODEL_ID" --argjson entry "$new_entry" \
      '.models = ([(.models // [])[] | select(.id != $id)] + [$entry])' \
      "$filepath" > "$tmp"
    mv "$tmp" "$filepath"
  else
    jq -n --argjson entry "$new_entry" '{ models: [$entry] }' > "$filepath"
  fi
  success "Written to ${filepath}"
  echo ""
  info "How to launch: select the model in the CodeBuddy dialog: ${BOLD}proxy-memory-agent${RESET}"
}

write_codex() {
  local filepath="$1"
  ensure_dir "$filepath"
  backup_file "$filepath"

  local base_url="${PROXY_HOST}/codex/${INSTANCE_ID}"

  if [[ -f "$filepath" ]]; then
    # Patch existing config.toml: replace top-level proxy keys + [model_providers.team-proxy] section
    local tmp
    tmp=$(mktemp)

    # 1) Remove top-level keys we manage (model_provider, model, model_reasoning_effort, disable_response_storage)
    # 2) Remove existing [model_providers.team-proxy] section entirely (until next [section] or EOF)
    awk '
      # Skip top-level keys we will re-add
      /^model_provider[[:space:]]*=/ { next }
      /^model[[:space:]]*=/ { next }
      /^model_reasoning_effort[[:space:]]*=/ { next }
      /^disable_response_storage[[:space:]]*=/ { next }

      # Skip [model_providers.team-proxy] section
      /^\[model_providers\.team-proxy\]/ { in_section=1; next }
      in_section && /^\[/ { in_section=0 }
      in_section { next }

      { print }
    ' "$filepath" > "$tmp"

    # 2) Prepend our top-level keys (after any leading comments)
    {
      echo "# --- managed by setup-proxy.sh ---"
      echo "model_provider = \"team-proxy\""
      echo "model = \"${MODEL_ID}\""
      echo "model_reasoning_effort = \"high\""
      echo "disable_response_storage = true"
      echo "# --- end managed ---"
      echo ""
      cat "$tmp"
      echo ""
      echo "[model_providers.team-proxy]"
      echo "name       = \"TDAI team-proxy\""
      echo "wire_api   = \"responses\""
      echo "base_url   = \"${base_url}\""
      echo "experimental_bearer_token = \"${USER_KEY}\""
      echo ""
      echo "request_max_retries    = 2"
      echo "stream_max_retries     = 3"
      echo "stream_idle_timeout_ms = 120000"
    } > "${tmp}.final"
    mv "${tmp}.final" "$filepath"
    rm -f "$tmp"
  else
    # Fresh file
    cat > "$filepath" <<EOF
# Generated by setup-proxy.sh at $(date '+%Y-%m-%d %H:%M:%S')
model_provider = "team-proxy"
model = "${MODEL_ID}"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "TDAI team-proxy"
wire_api   = "responses"
base_url   = "${base_url}"
experimental_bearer_token = "${USER_KEY}"

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000
EOF
  fi

  success "Written to ${filepath}"
  echo ""
  info "How to launch:"
  echo -e "  ${GREEN}codex${RESET}"
  warn "⚠️  Before the first conversation you must switch to Plan mode (Shift+Tab); after selecting Team->Agent->Task, switch back to Agent mode"
}

write_workbuddy() {
  local filepath="$1"
  ensure_dir "$filepath"
  backup_file "$filepath"

  local base_url="${PROXY_HOST}/workbuddy/${INSTANCE_ID}"
  local new_entry
  new_entry=$(jq -n \
    --arg id "$MODEL_ID" \
    --arg url "$base_url" \
    --arg key "$USER_KEY" \
    '{
      id: $id,
      name: $id,
      vendor: "Custom",
      url: $url,
      apiKey: $key,
      supportsToolCall: true,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: false
    }')

  if [[ -f "$filepath" ]]; then
    local tmp
    tmp=$(mktemp)
    # WorkBuddy models.json is a top-level array
    jq --arg id "$MODEL_ID" --argjson entry "$new_entry" \
      '[.[] | select(.id != $id)] + [$entry]' \
      "$filepath" > "$tmp"
    mv "$tmp" "$filepath"
  else
    jq -n --argjson entry "$new_entry" '[$entry]' > "$filepath"
  fi
  success "Written to ${filepath}"
  echo ""
  info "How to launch: select in the WorkBuddy custom model list: ${BOLD}${MODEL_ID}${RESET}"
}

write_dsh() {
  local settings_path="$1"
  local credentials_path="$DSH_CREDENTIALS_PATH"

  local dsh_dir
  dsh_dir="$(dirname "$settings_path")"
  mkdir -p "$dsh_dir"

  backup_file "$settings_path"
  backup_file "$credentials_path"

  local base_url="${PROXY_HOST}/dsh/${INSTANCE_ID}"

  cat > "$settings_path" <<EOF
# Generated by setup-proxy.sh at $(date '+%Y-%m-%d %H:%M:%S')
llm-deepseek:
  # dsh reads the proxy user_key from this environment variable name
  apiKeyEnv: PROXY_USER_KEY

  # WARNING: do not add /v1 at the end -- dsh hardcodes \${baseURL}/chat/completions
  baseURL: ${base_url}

  model: ${MODEL_ID}

  # thinking mode
  reasoningEffort: high
EOF

  cat > "$credentials_path" <<EOF
# Generated by setup-proxy.sh at $(date '+%Y-%m-%d %H:%M:%S')
PROXY_USER_KEY: ${USER_KEY}
EOF

  # Set permissions (dsh hard-checks these)
  chmod 700 "$dsh_dir"
  chmod 600 "$credentials_path"

  success "Written to ${settings_path}"
  success "Written to ${credentials_path}"
  info "Permissions set: chmod 700 ${dsh_dir}, chmod 600 ${credentials_path}"
  echo ""
  info "How to launch:"
  echo -e "  ${GREEN}dsh${RESET}   ${DIM}# CLI mode${RESET}"
  echo -e "  ${GREEN}dsh web --port 3080${RESET}   ${DIM}# Web UI mode${RESET}"
}

write_hermes() {
  local filepath="$1"
  ensure_dir "$filepath"
  backup_file "$filepath"

  local base_url="${PROXY_HOST}/hermes/${INSTANCE_ID}"

  cat > "$filepath" <<EOF
# Generated by setup-proxy.sh at $(date '+%Y-%m-%d %H:%M:%S')
model:
  default: ${MODEL_ID}
  provider: custom
  base_url: ${base_url}
  api_key: ${USER_KEY}
  extra_headers:
    x-team-id: "${TEAM_ID}"
    x-agent-id: "${AGENT_ID}"
    x-task-id: "${TASK_ID}"
    x-conversation-id: "${CONVERSATION_ID}"
EOF

  success "Written to ${filepath}"
  echo ""
  warn "⚠️  Notes:"
  echo -e "  • x-conversation-id identifies the current conversation, ${BOLD}must be changed manually for each new conversation${RESET}"
  echo -e "  • x-task-id is required in the current version; enter 'no-task' if there is no Task"
  echo -e "  • Switching Team/Agent/Task requires editing the config file"
}

write_openclaw() {
  local filepath="$1"
  ensure_dir "$filepath"
  backup_file "$filepath"

  local base_url="${PROXY_HOST}/openclaw/${INSTANCE_ID}"

  local provider_block
  provider_block=$(jq -n \
    --arg url "$base_url" \
    --arg key "$USER_KEY" \
    --arg tid "$TEAM_ID" \
    --arg aid "$AGENT_ID" \
    --arg taskid "$TASK_ID" \
    --arg convid "$CONVERSATION_ID" \
    --arg model "$MODEL_ID" \
    '{
      baseUrl: $url,
      apiKey: $key,
      api: "openai-completions",
      headers: {
        "x-team-id": $tid,
        "x-agent-id": $aid,
        "x-task-id": $taskid,
        "x-conversation-id": $convid
      },
      request: { allowPrivateNetwork: true },
      models: [{
        id: $model,
        name: $model,
        reasoning: false,
        input: ["text"],
        contextWindow: 128000,
        maxTokens: 32000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }]
    }')

  if [[ -f "$filepath" ]]; then
    local tmp
    tmp=$(mktemp)
    # Merge provider into existing openclaw.json
    jq --argjson provider "$provider_block" \
      '.models = (.models // {}) |
       .models.mode = (.models.mode // "merge") |
       .models.providers = (.models.providers // {}) |
       .models.providers["memory-proxy"] = $provider' \
      "$filepath" > "$tmp"
    mv "$tmp" "$filepath"
  else
    jq -n --argjson provider "$provider_block" \
      '{ models: { mode: "merge", providers: { "memory-proxy": $provider } } }' \
      > "$filepath"
  fi
  success "Written to ${filepath}"
  echo ""
  warn "⚠️  Notes:"
  echo -e "  • x-conversation-id identifies the current conversation, ${BOLD}must be changed manually for each new conversation${RESET}"
  echo -e "  • x-task-id is required in the current version; enter 'no-task' if there is no Task"
  echo -e "  • In OpenClaw select the provider ${BOLD}memory-proxy${RESET}, and select the model ${BOLD}${MODEL_ID}${RESET}"
}

# ─── Execute Write ────────────────────────────────────────────────────────────
case "$CHOSEN_AGENT" in
  claude-code) write_claude_code "$CONFIG_PATH" ;;
  codebuddy)   write_codebuddy "$CONFIG_PATH" ;;
  codex)       write_codex "$CONFIG_PATH" ;;
  workbuddy)   write_workbuddy "$CONFIG_PATH" ;;
  dsh)         write_dsh "$CONFIG_PATH" ;;
  hermes)      write_hermes "$CONFIG_PATH" ;;
  openclaw)    write_openclaw "$CONFIG_PATH" ;;
esac

# ━━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
echo -e "${BOLD}${GREEN}═══ Setup complete ═══${RESET}"
echo ""
echo -e "  Agent:     ${BOLD}${CHOSEN_AGENT}${RESET}"
echo -e "  Proxy:     ${PROXY_HOST}"
echo -e "  Instance:  ${INSTANCE_ID}"
echo -e "  Model:     ${MODEL_ID}"
echo -e "  Config:    ${CONFIG_DISPLAY}"
if [[ "$CHOSEN_AGENT" == "dsh" ]]; then
  echo -e "  Creds:     ${DSH_DISPLAY_CREDENTIALS}"
fi
if [[ -n "$TEAM_ID" ]]; then
  echo -e "  Team ID:   ${TEAM_ID}"
  echo -e "  Agent ID:  ${AGENT_ID}"
  echo -e "  Task ID:   ${TASK_ID}"
  echo -e "  Conv ID:   ${CONVERSATION_ID}"
fi
echo ""
# Model switch reminder (per agent)
case "$CHOSEN_AGENT" in
  claude-code)
    warn "Just run claude directly; the model is already specified via settings.json as ${MODEL_ID}"
    ;;
  codebuddy)
    warn "You must switch the model to ${BOLD}proxy-memory-agent${RESET} (${MODEL_ID})  in the CodeBuddy dialog for requests to go through the Proxy"
    ;;
  codex)
    warn "Just run codex directly; config.toml already specifies model = ${MODEL_ID}"
    ;;
  workbuddy)
    warn "You must switch to the custom model ${BOLD}${MODEL_ID}${RESET}  in the WorkBuddy model selector for requests to go through the Proxy"
    ;;
  dsh)
    warn "Just run dsh directly; settings.yaml already specifies the model"
    ;;
  hermes|openclaw)
    warn "Make sure the model/provider selected in the client points to the Proxy configuration (${MODEL_ID})"
    ;;
esac
echo ""
info "On first use a Team->Agent->Task selection will pop up (if ${CHOSEN_AGENT} supports the interactive Form)"
info "Run this script again to configure other Agents"

# ━━━ Optional: Asset Import ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
echo ""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ASSET_IMPORT_SCRIPT="${SCRIPT_DIR}/asset-import.ts"

if [[ -f "$ASSET_IMPORT_SCRIPT" ]] && ! $ARG_NONINTERACTIVE; then
  header "Asset import (optional)"
  info "Asset import script detected; you can import this Agent's local skills/conversation history into team memory"
  info "Cold-start skill extraction always uses ${BOLD}strict mode${RESET}(v1 five-category + four-dimension scoring gate),"
  info "it only captures high-value SOPs, reducing low-value skill noise of the Background/Preference kind;"
  info "Real-time extraction (daily proxy calls) still uses the lenient default mode; behavior is unchanged."
  echo ""
  if confirm "Import this Agent's local assets (skill + conversations) into team memory?" "n"; then
    # Determine Panel URL for asset-import
    IMPORT_PANEL_URL="${PANEL_URL:-}"
    if [[ -z "$IMPORT_PANEL_URL" ]]; then
      prompt_input IMPORT_PANEL_URL "Panel backend address (Panel API)" "http://127.0.0.1:8125"
    fi

    # Determine team-id and agent-id for asset-import (required params)
    IMPORT_TEAM_ID=""
    IMPORT_AGENT_ID=""

    if [[ -n "$TEAM_ID" && -n "$AGENT_ID" ]]; then
      # Hermes/OpenClaw path: already picked team/agent earlier
      info "Previously selected Team/Agent detected:"
      echo -e "  Team ID:  ${BOLD}${TEAM_ID}${RESET}"
      echo -e "  Agent ID: ${BOLD}${AGENT_ID}${RESET}"
      if confirm "Use the Team/Agent above for asset import?" "y"; then
        IMPORT_TEAM_ID="$TEAM_ID"
        IMPORT_AGENT_ID="$AGENT_ID"
      fi
    fi

    if [[ -z "$IMPORT_TEAM_ID" ]]; then
      info "Asset import requires specifying the target Team and Agent"
      prompt_input IMPORT_TEAM_ID "Team ID (get it from the panel)"
      prompt_input IMPORT_AGENT_ID "Agent ID (get it from the panel)"
    fi

    # Check if tsx/npx is available
    RUNNER=""
    if command -v tsx &>/dev/null; then
      RUNNER="tsx"
    elif command -v npx &>/dev/null; then
      RUNNER="npx tsx"
    fi

    IMPORT_ARGS=(--source "$CHOSEN_AGENT" --team-id "$IMPORT_TEAM_ID" --agent-id "$IMPORT_AGENT_ID")

    if [[ -z "$RUNNER" ]]; then
      warn "tsx or npx not found; cannot run the asset import script directly"
      info "Please run manually:"
      echo -e "  ${GREEN}PANEL_URL=${IMPORT_PANEL_URL} TDAI_SERVICE_ID=${INSTANCE_ID} TDAI_USER_KEY=${USER_KEY} \\"
      echo -e "    tsx agents/asset-import.ts ${IMPORT_ARGS[*]}${RESET}"
    else
      info "Starting asset import (source=${CHOSEN_AGENT}, team=${IMPORT_TEAM_ID})..."
      echo -e "${DIM}────────────────────────────────────────${RESET}"
      # Hand off to asset-import — it handles its own interactive flow from here
      PANEL_URL="$IMPORT_PANEL_URL" \
      TDAI_SERVICE_ID="$INSTANCE_ID" \
      TDAI_USER_KEY="$USER_KEY" \
        $RUNNER "$ASSET_IMPORT_SCRIPT" "${IMPORT_ARGS[@]}" || true
      echo -e "${DIM}────────────────────────────────────────${RESET}"
      success "Asset import flow finished"
    fi
  fi
fi
echo ""
