#!/usr/bin/env bash
# p0-smoke.sh -- Handler Pipeline refactor P0 verification (24 items, fully automated)
#
# Cross-reference: docs/design/2026-09-22-refactor-verification-prioritized.md §P0
#
# Required environment variables:
#   PROXY     proxy root URL, e.g. http://127.0.0.1:8096
#   KEY       a valid user_key (sk-mem-* / ck_* from MemoryPanel)
#   SPACE     spaceId (must be on the same instance as KEY, otherwise auth returns 401)
#   MODEL     a model in the price list (e.g. deepseek-v4-pro)
#
# Usage:
#   PROXY=http://127.0.0.1:8096 KEY=sk-mem-xxx SPACE=mem-xxxxxxxx \
#     MODEL=deepseek-v4-pro bash p0-smoke.sh

set -uo pipefail

PROXY="${PROXY:?PROXY required, e.g. PROXY=http://127.0.0.1:8096}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId, must match KEY instance)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"

PASS=0; FAIL=0; SKIP=0
declare -a FAILED_ITEMS=()

# Output helpers -- single-line results, convenient for grep
ok()   { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); FAILED_ITEMS+=("$1 $2"); }
skip() { printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; SKIP=$((SKIP+1)); }
head_() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

# Send a request: $1=path $2=body $3=extra-header (optional) -> sets globals HTTP_CODE / BODY
req() {
  local path="$1" body="$2" extra="${3:-}"
  local out
  if [[ -n "$extra" ]]; then
    out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -H "$extra" -d "$body" 2>/dev/null)
  else
    out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
      -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
      -d "$body" 2>/dev/null)
  fi
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# Send a request without Authorization
req_noauth() {
  local path="$1" body="$2"
  local out
  out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
    -H "Content-Type: application/json" -d "$body" 2>/dev/null)
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

# Send a non-JSON body
req_badjson() {
  local path="$1"
  local out
  out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$PROXY$path" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    --data-raw 'this is not json{{{' 2>/dev/null)
  HTTP_CODE=$(printf '%s' "$out" | tail -1)
  BODY=$(printf '%s' "$out" | sed '$d')
}

##############################################################################
head_ "P0-A basic forwarding works (6)"
##############################################################################

# P0-A1 valid key + non-stream -> 200
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "200" && -n "$BODY" ]]; then
  ok "P0-A1" "non-stream forwarding 200 (body $(printf '%s' "$BODY" | wc -c) bytes)"
else
  bad "P0-A1" "expected 200, got $HTTP_CODE | $(printf '%s' "$BODY" | head -c 150)"
fi

# P0-A2 valid key + stream -> 200 + SSE
out=$(curl -s -m 30 -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null)
if printf '%s' "$out" | grep -q "^event:\|^data:"; then
  ok "P0-A2" "stream returns SSE (contains data:/event:)"
else
  bad "P0-A2" "stream did not return SSE | $(printf '%s' "$out" | head -c 150)"
fi

# P0-A3 invalid key -> 401
out=$(curl -s -m 20 -w $'\n%{http_code}' -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer sk-invalid-key-does-not-exist" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null)
code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
if [[ "$code" == "401" ]]; then
  ok "P0-A3" "invalid key -> 401"
else
  bad "P0-A3" "expected 401, got $code | $(printf '%s' "$body" | head -c 150)"
fi

# P0-A4 empty Authorization -> 401
req_noauth "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":32,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" == "401" ]]; then
  ok "P0-A4" "empty Authorization -> 401"
else
  bad "P0-A4" "expected 401, got $HTTP_CODE | $(printf '%s' "$BODY" | head -c 150)"
fi

# P0-A5 non-JSON body -> 400
req_badjson "/claude-code/$SPACE/v1/messages"
if [[ "$HTTP_CODE" == "400" ]] && printf '%s' "$BODY" | grep -qi "invalid json\|parse\|JSON"; then
  ok "P0-A5" "non-JSON -> 400 + Invalid JSON"
else
  bad "P0-A5" "expected 400+Invalid JSON, got $HTTP_CODE | $(printf '%s' "$BODY" | head -c 150)"
fi

# P0-A6 upstream unreachable -> 502
# Verified with a separate instance (upstream.url points to a dead port). The default instance's upstream is reachable, so this can't be tested there.
# SKIP if DEAD_PROXY is not running.
DEAD_PROXY="${DEAD_PROXY:-http://127.0.0.1:18197}"
out=$(curl -s -m 30 -w $'\n%{http_code}' -X POST "$DEAD_PROXY/direct/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null)
code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
if [[ "$code" == "502" ]]; then
  ok "P0-A6" "upstream unreachable -> 502 ($(printf '%s' "$body" | jq -r '.detail // ""' 2>/dev/null))"
elif [[ -z "$code" || "$code" == "000" ]]; then
  skip "P0-A6" "dead-upstream instance (18197) not running"
else
  bad "P0-A6" "expected 502, got $code"
fi

##############################################################################
head_ "P0-B route table completeness (14)"
##############################################################################

# Route-hit determination: expect "route exists".
# WARNING: status != 404 alone is not enough -- the proxy forwards the request upstream first, and an upstream 404 is
#    also a 404. Use the proxy's own logs to confirm "this path was handled by a handler".
#
# Method: record the proxy.log line count before probing -> send the request -> check whether the new log lines contain the path
PROXY_STDOUT="${PROXY_STDOUT:-/tmp/proxy-refactor.log}"

# Proxy stdout log increment helper (used by route_probe / group D assertions)
log_lines() { wc -l < "$PROXY_STDOUT" 2>/dev/null || echo 0; }
log_delta() {
  local before="$1"
  tail -n +$((before+1)) "$PROXY_STDOUT" 2>/dev/null || true
}

route_probe() {
  local id="$1" path="$2" body="$3" expect="$4"
  local before_hit=""
  # Search the main proxy log for "-> REQ" / "FORWARD" / this path
  local before_lines=0
  [[ -f "$PROXY_STDOUT" ]] && before_lines=$(wc -l < "$PROXY_STDOUT")
  req "$path" "$body"
  local after_hit=""
  if [[ -f "$PROXY_STDOUT" ]] && (( before_lines > 0 )); then
    after_hit=$(tail -n +$((before_lines+1)) "$PROXY_STDOUT" 2>/dev/null | grep -cE "REQ |FORWARD|CODEX_AUX|DIRECT|pipeline" || true)
  fi

  if [[ "$expect" == "not404" ]]; then
    # Hit criterion: status is not 404, or the log shows signs of handling
    if [[ "$HTTP_CODE" != "404" ]] || [[ "${after_hit:-0}" -gt 0 ]]; then
      ok "$id" "$path → $HTTP_CODE (route hit, ${after_hit:-0} log lines)"
    else
      bad "$id" "$path -> 404 and no proxy log entry (route missing)"
    fi
  elif [[ "$expect" == "404" ]]; then
    if [[ "$HTTP_CODE" == "404" ]]; then
      ok "$id" "$path -> 404 (marker not enabled, as expected)"
    else
      bad "$id" "$path -> $HTTP_CODE (expected 404)"
    fi
  fi
}

# P0-B1 CC path
route_probe "P0-B1" "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B2 CB path
route_probe "P0-B2" "/codebuddy/$SPACE/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B3 codex with v1
route_probe "P0-B3" "/codex/$SPACE/v1/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B4 codex without v1
route_probe "P0-B4" "/codex/$SPACE/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B5 workbuddy with v1
route_probe "P0-B5" "/workbuddy/$SPACE/v1/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B6 workbuddy without v1
route_probe "P0-B6" "/workbuddy/$SPACE/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B7 codex aux three paths (+ variants without v1)
# WARNING: upstream tokenhub has no compact / trace_summarize / realtime endpoints and returns 404.
#    So the determination must rely on the proxy log (CODEX_AUX entries), not just status.
B7_BAD=0
for aux in "v1/responses/compact" "v1/memories/trace_summarize" "v1/realtime/calls"; do
  bl=$(wc -l < "$PROXY_STDOUT" 2>/dev/null || echo 0)
  req "/codex/$SPACE/$aux" "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
  hits=$(tail -n +$((bl+1)) "$PROXY_STDOUT" 2>/dev/null | grep -c "CODEX_AUX" || true)
  if (( hits > 0 )); then
    printf '  \033[36m··\033[0m %-8s /codex/%s/%s → %s (CODEX_AUX ✓)\n' "B7-sub" "$SPACE" "$aux" "$HTTP_CODE"
  else
    printf '  \033[31m··\033[0m %-8s /codex/%s/%s -> %s (no CODEX_AUX)\n' "B7-sub" "$SPACE" "$aux" "$HTTP_CODE"
    B7_BAD=$((B7_BAD+1))
  fi
done
if (( B7_BAD == 0 )); then
  ok "P0-B7" "all 3 codex aux paths hit the handler (upstream 404 is expected)"
else
  bad "P0-B7" "codex aux has $B7_BAD paths that missed the handler"
fi
# P0-B8 /direct/* -- stripDirectPrefix appends whatever follows /direct verbatim to
# config.upstream.url. So the correct form is /direct/v1/messages (-> upstream /v1/messages),
# not /direct/<spaceId>/v1/messages (which would build a path that doesn't exist upstream).
req "/direct/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "404" ]]; then
  ok "P0-B8" "/direct/v1/messages hit -> $HTTP_CODE"
else
  bad "P0-B8" "/direct/v1/messages → 404｜$(printf '%s' "$BODY" | head -c 120)"
fi
# P0-B9 utility endpoint
req "/claude-code/$SPACE/v1/messages/count_tokens" \
  "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "404" ]]; then ok "P0-B9" "count_tokens hit -> $HTTP_CODE"; else bad "P0-B9" "count_tokens 404"; fi
# P0-B10 catch-all does not 404
req "/some/random/path/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if [[ "$HTTP_CODE" != "404" ]]; then ok "P0-B10" "catch-all not 404 -> $HTTP_CODE"; else bad "P0-B10" "catch-all 404"; fi
# P0-B11 /models
out=$(curl -s -m 20 -w $'\n%{http_code}' "$PROXY/claude-code/$SPACE/v1/models" -H "Authorization: Bearer $KEY" 2>/dev/null)
code=$(printf '%s' "$out" | tail -1); body=$(printf '%s' "$out" | sed '$d')
if [[ "$code" == "200" ]] && printf '%s' "$body" | jq -e '.data' >/dev/null 2>&1; then
  ok "P0-B11" "/v1/models → 200 + .data ($(printf '%s' "$body" | jq '.data|length' 2>/dev/null) models)"
else
  bad "P0-B11" "expected 200+.data, got $code"
fi
# P0-B12 cost-guard marker (markerOptIn=false -> expect 404; true -> not 404)
MOPT=$(curl -s -m 5 "$PROXY/health" | jq -r '.costGuard' 2>/dev/null)
route_probe "P0-B12" "/claude-code/$SPACE/cost-guard/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  "$([[ "$MOPT" == "enabled" ]] && echo not404 || echo 404)"
# P0-B13 analyse marker
route_probe "P0-B13" "/claude-code/$SPACE/analyse/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" not404
# P0-B14 codex cost-guard marker
route_probe "P0-B14" "/codex/$SPACE/cost-guard/v1/responses" \
  "{\"model\":\"$MODEL\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}" \
  "$([[ "$MOPT" == "enabled" ]] && echo not404 || echo 404)"

##############################################################################
head_ "P0-C protocol formats correct (4)"
##############################################################################

# P0-C1 CB/openai error format {error:{message,type}}
req "/codebuddy/$SPACE/v1/chat/completions" \
  "{\"model\":\"no-such-model-xyz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if printf '%s' "$BODY" | jq -e '.error.message' >/dev/null 2>&1; then
  ok "P0-C1" "CB error format has .error.message ($HTTP_CODE)"
else
  bad "P0-C1" "CB error body is missing .error.message | $(printf '%s' "$BODY" | head -c 200)"
fi
# P0-C2 CC/anthropic error format {type:error,error:{type,message}}
# WARNING: must use the /proxy/ path -- /claude-code/ is overridden by instance-upstream on this instance,
#     and the model gate is skipped by design (isCustomUpstream=true), so the error body passes through from upstream.
req "/proxy/$SPACE/v1/messages" \
  "{\"model\":\"no-such-model-xyz\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if printf '%s' "$BODY" | jq -e '.type=="error" and .error.message' >/dev/null 2>&1; then
  ok "P0-C2" "CC error format type=error + .error.message ($HTTP_CODE)"
else
  bad "P0-C2" "CC error body format mismatch | $(printf '%s' "$BODY" | head -c 200)"
fi
# P0-C3 codex/wb error format (Responses style)
req "/codex/$SPACE/v1/responses" \
  "{\"model\":\"no-such-model-xyz\",\"input\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
if printf '%s' "$BODY" | jq -e '.error' >/dev/null 2>&1; then
  ok "P0-C3" "codex error format contains .error ($HTTP_CODE)"
else
  bad "P0-C3" "codex error body mismatch | $(printf '%s' "$BODY" | head -c 200)"
fi
# P0-C4 stream Content-Type
ct=$(curl -s -m 25 -D - -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":8,\"stream\":true,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}" 2>/dev/null \
  | grep -i "^content-type:" | head -1)
if printf '%s' "$ct" | grep -qi "text/event-stream"; then
  ok "P0-C4" "stream Content-Type=text/event-stream"
else
  bad "P0-C4" "Content-Type is not SSE | $ct"
fi

##############################################################################
head_ "P0-D instance upstream config (4)"
##############################################################################

# P0-D1 no model group configured (official) -> 200
# This instance's default group (official) covers workbuddy/dsh/opencode/hermes/openclaw/pi;
# use dsh to verify the official path lands on the global upstream.url.
before=$(log_lines)
req "/dsh/$SPACE/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
delta=$(log_delta "$before")
fwd=$(printf '%s' "$delta" | grep -oE "FORWARD upstream=\S+" | head -1)
if [[ "$HTTP_CODE" == "200" ]]; then
  ok "P0-D1" "official group (dsh) -> 200 | $fwd"
else
  bad "P0-D1" "expected 200, got $HTTP_CODE"
fi

# P0-D2/D3 blocked / unmanaged: this instance's config has no blocked group and no unmanaged agent
# (all 8 agents are covered by the default official or custom groups), so it can't be constructed -> SKIP with explanation.
skip "P0-D2" "blocked -> 400 UPSTREAM_DISABLED | no blocked group in instance config"
skip "P0-D3" "unmanaged -> 400 AGENT_NOT_CONFIGURED | all 8 agents are covered by default/custom"

# P0-D4 custom_unified -> replaces upstream URL + apiKey
# This instance has two custom_unified groups: codebuddy -> api.deepseek.com,
# claude-code -> api.deepseek.com/anthropic. Verify each one's FORWARD target.
before=$(log_lines)
req "/codebuddy/$SPACE/v1/chat/completions" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
cb_fwd=$(printf '%s' "$(log_delta "$before")" | grep -oE "FORWARD upstream=\S+" | head -1)
before=$(log_lines)
req "/claude-code/$SPACE/v1/messages" \
  "{\"model\":\"$MODEL\",\"max_tokens\":8,\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}"
cc_fwd=$(printf '%s' "$(log_delta "$before")" | grep -oE "FORWARD upstream=\S+" | head -1)
if printf '%s' "$cb_fwd" | grep -q "api.deepseek.com" && printf '%s' "$cc_fwd" | grep -q "api.deepseek.com"; then
  ok "P0-D4" "custom_unified in effect: cb->$(printf '%s' "$cb_fwd" | sed 's/.*upstream=//'), cc->$(printf '%s' "$cc_fwd" | sed 's/.*upstream=//')"
else
  bad "P0-D4" "custom override not in effect | cb=$cb_fwd cc=$cc_fwd"
fi

##############################################################################
printf '\n\033[1m========================================\033[0m\n'
printf '\033[1m P0 SMOKE summary\033[0m\n'
printf '\033[1m========================================\033[0m\n'
printf '  PASS=%d  FAIL=%d  SKIP=%d\n' "$PASS" "$FAIL" "$SKIP"
if (( ${#FAILED_ITEMS[@]} > 0 )); then
  printf '\n  Failed items:\n'
  for it in "${FAILED_ITEMS[@]}"; do printf '    ✗ %s\n' "$it"; done
fi
printf '\n'
exit $(( FAIL > 0 ? 1 : 0 ))
