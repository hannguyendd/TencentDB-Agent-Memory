#!/usr/bin/env bash
# iu-smoke.sh -- P0-D2/D3/D4 instance-upstream 4-state verification (self-contained: starts a mock core + temporary proxies)
#
# Why not test against the main instance:
#   The blocked / unmanaged states require setting a group's enabled to false, or
#   leaving the agent out of every group. Modifying the shared test instance would
#   disrupt sessions other people are running, so a mock core provides the three
#   response shapes of instance-upstream/list instead.
#
# Usage: bash iu-smoke.sh
#   On exit, all mock + temporary proxy processes are cleaned up automatically.

#
# Required environment variables:
#   MPROJ        Local MemoryProxy repository root
#   BASECFG      Path to the proxy's base config.yaml (the script copies several variants via sed; the original is untouched)
#   CORE_URL     Original core address in the config to replace (e.g. http://10.0.0.1:8420),
#                which the script rewrites to http://127.0.0.1:<mock-port>
# Optional:
#   DRIVE        Directory containing mock-core.mjs (default /tmp/tui-drive)
#   SPACE        spaceId (default: default)
#   MODEL        A model in the price list (default deepseek-v4-pro)

set -uo pipefail

MPROJ="${MPROJ:?MPROJ required, e.g. /path/to/tdai-memory-openclaw-plugin/MemoryProxy}"
BASECFG="${BASECFG:?BASECFG required, path to the proxy base config.yaml}"
CORE_URL="${CORE_URL:?CORE_URL required, the core http URL to swap out (e.g. http://10.0.0.1:8420)}"
DRIVE="${DRIVE:-/tmp/tui-drive}"
KEY=any-mock-key
SPACE="${SPACE:-default}"
MODEL="${MODEL:-deepseek-v4-pro}"

PASS=0; FAIL=0
ok()  { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad() { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

PIDS=()
cleanup() {
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  sleep 1
  for p in "${PIDS[@]:-}"; do kill -9 "$p" 2>/dev/null || true; done
}
trap cleanup EXIT

start_mock() { # $1=mode $2=port
  MOCK_MODE="$1" MOCK_PORT="$2" node "$DRIVE/mock-core.mjs" > "/tmp/iu-mock-$2.log" 2>&1 &
  PIDS+=($!)
}

start_proxy() { # $1=port $2=core_port
  local cfg="$DRIVE/iu-test-$1.yaml"
  sed -e "s|^  port: 8096|  port: $1|" \
      -e "s|$CORE_URL|http://127.0.0.1:$2|g" "$BASECFG" > "$cfg"
  (cd "$MPROJ" && node --import tsx/esm src/index.ts --config "$cfg") > "/tmp/iu-proxy-$1.log" 2>&1 &
  PIDS+=($!)
}

wait_up() { # $1=url
  for _ in $(seq 1 40); do
    curl -sf -m 2 "$1" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  return 1
}

# Three shapes: blocked-default(18610/18620) blocked-custom(18611/18621) unmanaged(18612/18622)
start_mock blocked-default 18610
start_mock blocked-custom  18611
start_mock unmanaged       18612
sleep 2
start_proxy 18620 18610
start_proxy 18621 18611
start_proxy 18622 18612

for u in http://127.0.0.1:18620/health http://127.0.0.1:18621/health http://127.0.0.1:18622/health; do
  if ! wait_up "$u"; then echo "[FATAL] $u not ready"; exit 2; fi
done

printf '\n\033[1m== P0-D instance-upstream 4 states (mock core) ==\033[0m\n'

# D2 blocked (default group disabled) -- anthropic shape
body_a="{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18620/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | grep -q "upstream_disabled"; then
  ok "P0-D2" "blocked(default_disabled) → 400 upstream_disabled (anthropic envelope)"
else
  bad "P0-D2" "expected 400+upstream_disabled, got $code | $(printf '%s' "$b" | head -c 120)"
fi

# D2 blocked (custom group disabled) -- openai shape
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18621/codebuddy/$SPACE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | jq -e '.error_code=="UPSTREAM_DISABLED"' >/dev/null 2>&1; then
  ok "P0-D2" "blocked(custom_disabled) → 400 UPSTREAM_DISABLED (openai envelope)"
else
  bad "P0-D2" "expected 400+UPSTREAM_DISABLED, got $code | $(printf '%s' "$b" | head -c 120)"
fi

# D3 unmanaged -- openai shape
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18622/codebuddy/$SPACE/v1/chat/completions" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | jq -e '.error_code=="AGENT_NOT_CONFIGURED"' >/dev/null 2>&1; then
  ok "P0-D3" "unmanaged → 400 AGENT_NOT_CONFIGURED (openai envelope)"
else
  bad "P0-D3" "expected 400+AGENT_NOT_CONFIGURED, got $code | $(printf '%s' "$b" | head -c 120)"
fi

# D3 unmanaged -- anthropic shape
r=$(curl -s -m 20 -w '\n%{http_code}' -X POST "http://127.0.0.1:18622/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" -d "$body_a")
code=$(printf '%s' "$r" | tail -1); b=$(printf '%s' "$r" | sed '$d')
if [[ "$code" == "400" ]] && printf '%s' "$b" | grep -q "agent_not_configured"; then
  ok "P0-D3" "unmanaged → 400 agent_not_configured (anthropic envelope)"
else
  bad "P0-D3" "expected 400+agent_not_configured, got $code | $(printf '%s' "$b" | head -c 120)"
fi

printf '\n  PASS=%d FAIL=%d\n\n' "$PASS" "$FAIL"
exit $(( FAIL > 0 ? 1 : 0 ))
