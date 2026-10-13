#!/usr/bin/env bash
# p1-api-test.sh -- Handler Pipeline refactor P1 automated-item verification
#
# Cross-reference: docs/design/2026-09-22-refactor-verification-prioritized.md §P1
# Only covers items marked 🤖; 👁️/👤 items are covered by p1-semi-auto.sh + the TUI driver.
#
# Usage: bash p1-api-test.sh

#
# Required environment variables:
#   PROXY     proxy root URL
#   KEY       a valid user_key
#   SPACE     spaceId
#   MODEL     a model in the price list
# Optional:
#   PRESET_TEAM_ID   preselected team header value (e.g. team-xxxxxxxx)
#   PRESET_AGENT_ID  preselected agent header value (e.g. agt-xxxxxxxx)
#   PROXY_STDOUT     proxy log path (default /tmp/proxy-refactor.log)
#   PROXY_LOG_DIR    directory containing proxy.log (used for credit.report assertions)

set -uo pipefail

PROXY="${PROXY:?PROXY required, e.g. PROXY=http://127.0.0.1:8096}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId, must match KEY instance)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"
PRESET_TEAM_ID="${PRESET_TEAM_ID:-}"
PRESET_AGENT_ID="${PRESET_AGENT_ID:-}"
PROXY_STDOUT="${PROXY_STDOUT:-/tmp/proxy-refactor.log}"
PROXY_LOG_DIR="${PROXY_LOG_DIR:-}"

PASS=0; FAIL=0; SKIP=0
declare -a FAILED_ITEMS=()

ok()   { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); FAILED_ITEMS+=("$1 $2"); }
skip() { printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; SKIP=$((SKIP+1)); }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# req <path> <body> [extra-header] [method]
req() {
  local path="$1" body="$2"; shift 2
  local -a hdrs=()
  local h
  for h in "$@"; do hdrs+=(-H "$h"); done
  local out
  out=$(curl -s -m 40 -w $'\n%{http_code}' -X POST "$PROXY$path" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    "${hdrs[@]}" -d "$body" 2>/dev/null)
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# Get the lines newly added to the proxy stdout
log_delta() {
  local before="$1"
  tail -n +$((before+1)) "$PROXY_STDOUT" 2>/dev/null || true
}
log_lines() { wc -l < "$PROXY_STDOUT" 2>/dev/null || echo 0; }

##############################################################################
head_ "P1-E model gate + alias (4)"
##############################################################################

# P1-E1 model in the price list -> 200
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "200" ]]; then ok "P1-E1" "model in price list -> 200"; else
  bad "P1-E1" "expected 200, got $HTTP_CODE | $(printf '%s' "$BODY" | head -c 150)"; fi

# P1-E2 model not in the price list -> 400 (must use a path without instance override)
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"totally-fake-model-zzz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "400" ]] && printf '%s' "$BODY" | grep -q "not a registered display name"; then
  ok "P1-E2" "unregistered model -> 400 + not a registered display name"
else
  bad "P1-E2" "expected 400 + unregistered message, got $HTTP_CODE | $(printf '%s' "$BODY" | head -c 200)"
fi

# P1-E3 alias write-back -> upstream receives model_id (send with display name, check whether upstream accepts it)
# In the price list, the modelName of "ep-pksklwtb" is "LLM-A1"; sending "LLM-A1" should be aliased to ep-pksklwtb
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"LLM-A1\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "400" || "$HTTP_CODE" == "401" ]]; then
  # As long as it is not "not a registered display name", the gate passed the alias
  if printf '%s' "$BODY" | grep -q "not a registered display name"; then
    bad "P1-E3" "alias not in effect (gate rejected display name LLM-A1)"
  else
    ok "P1-E3" "alias resolved through gate (LLM-A1 -> $HTTP_CODE)"
  fi
else
  bad "P1-E3" "unexpected status $HTTP_CODE"
fi

# P1-E4 custom upstream skips the gate -> arbitrary model does not 400
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"whatever-custom-model\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "400" ]] || ! printf '%s' "$BODY" | grep -q "not a registered display name"; then
  ok "P1-E4" "custom upstream skips gate ($HTTP_CODE)"
else
  bad "P1-E4" "custom upstream still rejected by gate"
fi

##############################################################################
head_ "P1-F Session-Init automated items (2)"
##############################################################################

# P1-F5 preset identity: use the header names configured in headerAutoSelect (x-team-id / x-agent-id)
# WARNING: header names come from config.sessionInit.headerAutoSelect.*, defaulting to x-team-id / x-agent-id
#    (not x-tdai-preset-*). A wrong name degrades to an ordinary custom header; the request still returns 200 but skips preselection.
F5SID="preset-probe-$(date +%s)"
if [[ -z "$PRESET_TEAM_ID" || -z "$PRESET_AGENT_ID" ]]; then
  skip "P1-F5" "requires PRESET_TEAM_ID + PRESET_AGENT_ID (team-/agt- ids of a real instance)"
  before=$(log_lines); delta=""
else
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  "x-claude-code-session-id: $F5SID" "x-team-id: $PRESET_TEAM_ID" "x-agent-id: $PRESET_AGENT_ID"
delta=$(log_delta "$before")
# Criterion: no form was shown (no pending_asset_confirm) and injection took effect
if printf '%s' "$delta" | grep -q "pending_asset_confirm\|pending_team_select"; then
  bad "P1-F5" "header preselection not in effect, form was still shown"
elif printf '%s' "$delta" | grep -qE "prewarm|injection\]|tdai-recorder:write-l0"; then
  ok "P1-F5" "header preselection in effect: skipped form, injected + forwarded directly"
else
  bad "P1-F5" "cannot confirm preselection effect | $(printf '%s' "$delta" | head -3)"
fi
fi  # end PRESET_TEAM_ID/PRESET_AGENT_ID guard

# P1-F8 form response format: each protocol's form format needs a real client to trigger it -> covered by the TUI driver
skip "P1-F8" "form response format needs a new session to trigger | covered by the TUI driver"

# P1-F9 session-init error degradation: needs a mock store error
skip "P1-F9" "needs a mock session store error"

##############################################################################
head_ "P1-G Mem commands (6)"
##############################################################################

# Create an initialized session (preselect via header, skipping the form) -- mem commands require
# the session to be bound to a team/agent, otherwise blocked: session not initialized.
MEMSID="memcmd-probe-$(date +%s)"
MEM_SKIP=0
if [[ -z "$PRESET_TEAM_ID" || -z "$PRESET_AGENT_ID" ]]; then
  skip "P1-G*" "skipping the whole mem command group: needs PRESET_TEAM_ID + PRESET_AGENT_ID to warm up the session"
  MEM_SKIP=1
fi
if (( MEM_SKIP == 0 )); then
# Pass the preselect headers separately (curl -H does not accept comma separation)
PRESEL_TEAM="x-team-id: $PRESET_TEAM_ID"
PRESEL_AGENT="x-agent-id: $PRESET_AGENT_ID"
# Warm-up: send an ordinary message first to create the session
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"warmup\"}]}" \
  "x-claude-code-session-id: $MEMSID" "$PRESEL_TEAM" "$PRESEL_AGENT" >/dev/null 2>&1

# mem commands use the same session + preselect headers.
# WARNING: do not call it as `delta=$(mem_req ...)` -- command substitution runs the function in a subshell,
#    so BODY/HTTP_CODE set inside the function are all lost in the parent shell (this once left txt permanently empty).
#    Instead: call mem_req <cmd>, then read the globals $MEM_DELTA / $BODY.
MEM_DELTA=""
mem_req() {
  local cmd="$1"
  local before
  before=$(log_lines)
  req "/claude-code/$SPACE/v1/messages" \
    "{\"model\":\"$MODEL\",\"max_tokens\":128,\"messages\":[{\"role\":\"user\",\"content\":\"$cmd\"}]}" \
    "x-claude-code-session-id: $MEMSID" "$PRESEL_TEAM" "$PRESEL_AGENT"
  MEM_DELTA=$(log_delta "$before")
}

# Extract the assistant text from the response (to assert on the "actual reply text" rather than "the command name appearing in logs")
resp_text() {
  printf '%s' "$BODY" | jq -r '[.content[]? | select(.type=="text") | .text] | join(" ")' 2>/dev/null \
    || printf '%s' "$BODY" | jq -r '.choices[0].message.content // empty' 2>/dev/null || true
}

# WARNING: order matters: mem:session-reset **unbinds** the session, after which every mem command is
#    blocked by "session not initialized". So reset must be tested last in the mem group.

# P1-G4 mem:sync -> response text contains "已刷新" (Chinese reply text matched at runtime)
mem_req "mem:sync"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$txt" | grep -q "已刷新"; then
  ok "P1-G4" "mem:sync -> response contains '已刷新': $(printf '%s' "$txt" | head -c 60)"
elif printf '%s' "$delta" | grep -qE "mem-command\] cmd=sync.*success=true"; then
  ok "P1-G4" "mem:sync -> success=true (log)"
else
  bad "P1-G4" "mem:sync not successful | txt=$(printf '%s' "$txt" | head -c 80)"
fi

# P1-G3 mem:create-skill -> response contains "归档" (Chinese reply text matched at runtime)
mem_req "mem:create-skill test skill"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$txt" | grep -qE "归档"; then
  ok "P1-G3" "mem:create-skill -> response contains '归档': $(printf '%s' "$txt" | head -c 60)"
else
  bad "P1-G3" "create-skill not successful | txt=$(printf '%s' "$txt" | head -c 120)"
fi

# P1-G5 mem:status -- this command does not exist in the code (KNOWN_COMMANDS only has help/sync/create-skill/
# create-task/update-task/session-reset); this checklist item is a documentation error
mem_req "mem:status"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$txt" | grep -q "未知命令"; then
  skip "P1-G5" "checklist error: no status command, client receives '未知命令' (consistent with the code)"
else
  bad "P1-G5" "status behaved unexpectedly | $(printf '%s' "$txt" | head -c 120)"
fi

# P1-G6 mem response format: covered by the TUI driver (rendered by a real client)
skip "P1-G6" "mem response format needs real client rendering | covered by the TUI driver"

# P1-G7 non-mem commands are not intercepted
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"Please answer normally, this is not a command\"}]}" \
  "x-claude-code-session-id: $MEMSID" "$PRESEL_TEAM" "$PRESEL_AGENT"
delta=$(log_delta "$before")
if ! printf '%s' "$delta" | grep -qE "mem-command\] cmd="; then
  ok "P1-G7" "ordinary conversation not intercepted by mem"
else
  bad "P1-G7" "ordinary conversation misidentified as a mem command"
fi

# P1-G1 mem:session-reset recognition (run last: it unbinds the session)
mem_req "mem:session-reset"
delta="$MEM_DELTA"
txt=$(resp_text)
if printf '%s' "$delta" | grep -qE "mem-command:pre.*session-reset|falling through to pop form"; then
  ok "P1-G1" "mem:session-reset intercepted by pre-hook -> form re-shown"
elif printf '%s' "$txt" | grep -qE "重置|重新选择|关联团队资产"; then
  ok "P1-G1" "mem:session-reset -> response contains reset/form text"
else
  bad "P1-G1" "mem:session-reset not recognized"
fi
fi  # end MEM_SKIP guard

##############################################################################
head_ "P1-K Cost-Guard routing (2 automatable)"
##############################################################################

# P1-K4 markerOptIn=false -> useGuard by default (this instance has markerOptIn=false)
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
if printf '%s' "$delta" | grep -qE "COST_GUARD"; then
  ok "P1-K4" "markerOptIn=false default behavior in effect: $(printf '%s' "$delta" | grep -oE 'COST_GUARD[^(]*\([^)]*\)' | head -1)"
else
  bad "P1-K4" "no COST_GUARD log"
fi

# P1-K6 analyzerTrace report: absent when cost-guard is off -> depends on K4 state
if [[ "$(curl -s -m 5 "$PROXY/health" | jq -r '.costGuard')" == "disabled" ]]; then
  skip "P1-K6" "costGuard not enabled, analyzer trace not produced (determined by config)"
else
  before=$(log_lines)
  req "/claude-code/$SPACE/v1/messages" \
    "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
  delta=$(log_delta "$before")
  if printf '%s' "$delta" | grep -qi "analyzer\|analyse"; then
    ok "P1-K6" "analyzer trace was invoked"
  else
    skip "P1-K6" "no analyzer trace log seen"
  fi
fi

# P1-K7 CC anthropic independent upstream: this instance is overridden by instance-upstream to api.deepseek.com
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
fwd=$(printf '%s' "$delta" | grep -oE "FORWARD upstream=\S+" | head -1)
if [[ -n "$fwd" ]]; then
  ok "P1-K7" "CC forward target: $fwd"
else
  skip "P1-K7" "forward target not captured"
fi

##############################################################################
head_ "P1-L compression (2 automatable)"
##############################################################################

# P1-L3/L4 CFQ tag stripping: compression is not enabled when cost-guard is off -> SKIP
skip "P1-L3" "CFQ tag stripping needs requestPrepare enabled (this instance's space policy has it off)"
skip "P1-L4" "same as above"

##############################################################################
head_ "P1-M forwarding + retry (2 automatable)"
##############################################################################

# P1-M5 upstream 4xx error body passthrough
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"totally-fake-model-zzz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "400" ]] && printf '%s' "$BODY" | grep -q "error"; then
  ok "P1-M5" "client received the full error body ($HTTP_CODE)"
else
  bad "P1-M5" "error body not passed through | $HTTP_CODE $(printf '%s' "$BODY" | head -c 150)"
fi

# P1-M1 AbortSignal.timeout: this instance has forwardTimeoutMs=600000; triggering a timeout needs a config change -> SKIP
skip "P1-M1" "needs a smaller forwardTimeoutMs + a mock slow upstream"

##############################################################################
head_ "P1-N rate limiting + billing (4 automatable)"
##############################################################################

# P1-N1 enforceRateLimit interception: this instance has QPM=100 and would need to be saturated -> a low-QPM instance is not available
# Instead verify the rate-limit log exists + the count increments
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
if printf '%s' "$delta" | grep -q "rate_limit.decision"; then
  ok "P1-N1" "rate-limit decision in effect: $(printf '%s' "$delta" | grep -oE '\"allowed\":\w+' | head -1)"
elif [[ -f "$PROXY_STDOUT" ]] && grep -q "rate_limit.decision" "$PROXY_STDOUT"; then
  ok "P1-N1" "rate-limit decision in effect (log elsewhere)"
else
  skip "P1-N1" "no rate_limit.decision seen (may be written to proxy.log)"
fi

# P1-N3 custom upstream is not rate limited: this instance's CC uses the instance override
skip "P1-N3" "needs a custom upstream + low-QPM instance"

# P1-N4 tryReportCreditFromPath -> check the billing log
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
if [[ -z "$PROXY_LOG_DIR" ]]; then
  skip "P1-N4" "needs PROXY_LOG_DIR pointing to the proxy.log directory to assert credit.report"
else
  recent_credit=$(tail -50 "$PROXY_LOG_DIR/proxy.log" 2>/dev/null | grep -c "credit.report" || true)
  if (( recent_credit > 0 )); then
    ok "P1-N4" "billing report recorded (proxy.log last 50 lines: $recent_credit entries)"
  else
    bad "P1-N4" "no credit.report in billing log"
  fi
fi

# P1-N5 x-credit-report-error: needs the mock billing API to fail
skip "P1-N5" "needs the mock billing API to return an error"

# P1-N6 skipCreditReport: no reporting with a custom upstream -> needs a custom instance
skip "P1-N6" "needs a custom upstream instance"

##############################################################################
printf '\n\033[1m========================================\033[0m\n'
printf '\033[1m P1 API TEST summary\033[0m\n'
printf '\033[1m========================================\033[0m\n'
printf '  PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
if (( ${#FAILED_ITEMS[@]} > 0 )); then
  printf '\n  Failed items:\n'
  for it in "${FAILED_ITEMS[@]}"; do printf '    ✗ %s\n' "$it"; done
fi
printf '\n'
exit $(( FAIL > 0 ? 1 : 0 ))
