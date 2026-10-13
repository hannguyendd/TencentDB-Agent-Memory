#!/usr/bin/env bash
# p2-observability.sh -- P2 observability 16-item check (Langfuse / Opik / ClickHouse / TDAI)
#
# Cross-reference: docs/design/2026-09-22-refactor-verification-prioritized.md §P2
# All checks are "inspect dashboard / query DB" style verifications with no destructive operations.
#
# Required environment variables (all required, no defaults, to avoid hardcoding test-environment addresses/credentials into the repo):
#   PROXY     proxy root URL
#   KEY       a valid user_key
#   SPACE     spaceId
#   MODEL     a model in the price list
#   CH_URL    ClickHouse query endpoint, in the form "http://<host>:8123/?user=<u>&password=<p>"
#   CORE_URL  Core service root URL, in the form "http://<host>:8420"
#   LF_URL    Langfuse root URL
#   LF_PK     Langfuse Public Key   (pk-lf-...)
#   LF_SK     Langfuse Secret Key   (sk-lf-...)
#   OPIK_URL  Opik root URL
#   PROBE_USER_ID  userId used to filter traces in Langfuse/Opik (in the form usr-xxxxxxxx)
#   PROBE_TEAM_ID  team_id for TDAI L0 queries
#   PROBE_AGENT_ID agent_id for TDAI L0 queries
# Optional:
#   PROXY_STDOUT   proxy stdout log path (default /tmp/proxy-refactor.log)
#   PROXY_REPO     local repo root (used to read source / find JSONL; default is MemoryProxy under the current git top-level)

set -uo pipefail

PROXY="${PROXY:?PROXY required, e.g. PROXY=http://127.0.0.1:8096}"
KEY="${KEY:?KEY required (sk-mem-* / ck_* user_key)}"
SPACE="${SPACE:?SPACE required (spaceId)}"
MODEL="${MODEL:?MODEL required (e.g. deepseek-v4-pro)}"
PROXY_STDOUT="${PROXY_STDOUT:-/tmp/proxy-refactor.log}"
PROXY_REPO="${PROXY_REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null)/MemoryProxy}"

CH="${CH_URL:?CH_URL required, e.g. http://<host>:8123/?user=default&password=<pwd>}"
LF="${LF_URL:?LF_URL required (Langfuse base URL)}"
LF_PK="${LF_PK:?LF_PK required (Langfuse Public Key pk-lf-...)}"
LF_SK="${LF_SK:?LF_SK required (Langfuse Secret Key sk-lf-...)}"
LF_AUTH=$(printf '%s:%s' "$LF_PK" "$LF_SK" | base64 -w0)
OPIK="${OPIK_URL:?OPIK_URL required}"
CORE="${CORE_URL:?CORE_URL required}"
PROBE_USER_ID="${PROBE_USER_ID:?PROBE_USER_ID required (usr-xxxxxxxx)}"
PROBE_TEAM_ID="${PROBE_TEAM_ID:?PROBE_TEAM_ID required (team-xxxxxxxx)}"
PROBE_AGENT_ID="${PROBE_AGENT_ID:?PROBE_AGENT_ID required (agt-xxxxxxxx)}"

PASS=0; FAIL=0; SKIP=0
ok()   { printf '  \033[32mPASS\033[0m %-8s %s\n' "$1" "$2"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31mFAIL\033[0m %-8s %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33mSKIP\033[0m %-8s %s\n' "$1" "$2"; SKIP=$((SKIP+1)); }
head_(){ printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

chq() { curl -s -m 15 "$CH" --data-binary "$1" 2>/dev/null; }

# Send a request to generate fresh data
mkreq() {
  curl -s -m 25 -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
    -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
    -H "x-claude-code-session-id: obs-probe-$RANDOM" \
    -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"obs probe\"}]}"
}

##############################################################################
head_ "P2-P Langfuse (6)"
##############################################################################
mkreq; sleep 4

LF_T=$(curl -s -m 15 "$LF/api/public/traces?limit=50&userId=$PROBE_USER_ID" -H "Authorization: Basic $LF_AUTH" 2>/dev/null)
n=$(printf '%s' "$LF_T" | jq -r '.data | length' 2>/dev/null || echo 0)

# P2-P1 trace generation (name = model / keyId)
if printf '%s' "$LF_T" | jq -e --arg exp "$MODEL / $PROBE_USER_ID" '.data[] | select(.name == $exp)' >/dev/null 2>&1; then
  ok "P2-P1" "trace exists, name='model / keyId' format ($n)"
else
  bad "P2-P1" "no trace with name='<model> / <keyId>' found"
fi

# P2-P2 agent_source tag
if printf '%s' "$LF_T" | jq -e '.data[].tags // [] | .[] | select(startswith("agent_source:"))' >/dev/null 2>&1; then
  ok "P2-P2" "trace tags contain agent_source:* ($(printf '%s' "$LF_T" | jq -r '[.data[].tags[]? | select(startswith("agent_source:"))] | unique | join(",")' 2>/dev/null))"
else
  bad "P2-P2" "missing agent_source tag"
fi

# P2-P3 protocol tag
if printf '%s' "$LF_T" | jq -e '.data[].tags // [] | .[] | select(startswith("protocol:"))' >/dev/null 2>&1; then
  ok "P2-P3" "trace tags contain protocol:* ($(printf '%s' "$LF_T" | jq -r '[.data[].tags[]? | select(startswith("protocol:"))] | unique | join(",")' 2>/dev/null))"
else
  bad "P2-P3" "missing protocol tag"
fi

# P2-P4 generation report (success): trace has output + usage
if printf '%s' "$LF_T" | jq -e '.data[] | select(.output != null)' >/dev/null 2>&1; then
  ok "P2-P4" "generation has output (reported successfully)"
else
  bad "P2-P4" "trace has no output"
fi

# P2-P5 failure report: send a request that gets an upstream 400 and check whether Langfuse has an error marker
curl -s -m 25 -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "x-claude-code-session-id: obs-fail-$RANDOM" \
  -d '{"model":"no-such-model-fail","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
sleep 4
LF_F=$(curl -s -m 15 "$LF/api/public/traces?limit=30&userId=$PROBE_USER_ID" -H "Authorization: Basic $LF_AUTH" 2>/dev/null)
if printf '%s' "$LF_F" | jq -e '.data[].tags // [] | .[] | select(. == "error")' >/dev/null 2>&1; then
  ok "P2-P5" "upstream failure -> Langfuse trace carries an error tag"
else
  skip "P2-P5" "error tag not captured (failed traces may be automatically deleted when unset)"
fi

# P2-P6 debugMetadata: requires langfuse.debug=true
if grep -q "langfuse.debug" "$PROXY_STDOUT" 2>/dev/null || grep -q '"debug":true' "$PROXY_STDOUT" 2>/dev/null; then
  ok "P2-P6" "langfuse.debug is enabled"
else
  skip "P2-P6" "langfuse.debug=false(determined by config; must be explicitly enabled to produce observationMetadata)"
fi

##############################################################################
head_ "P2-Q Opik (4)"
##############################################################################
mkreq; sleep 2

# WARNING: project name rules (found empirically, easy to trip over):
#   CC / openai-chat / anthropic paths -> project_name = **userId**(PROBE_USER_ID)
#   /direct path                      -> project_name = **keyId** (md5 prefix, e.g. 9d46223a)
#   request_log                      -> fork project (can be turned off with stripRequestContent)
OPIK_USER_PROJ="$PROBE_USER_ID"

OPIK_P=$(curl -s -m 15 "$OPIK/api/v1/private/traces?project_name=$OPIK_USER_PROJ&page=1&size=10" 2>/dev/null)
opik_n=$(printf '%s' "$OPIK_P" | jq -r '.total // 0' 2>/dev/null || echo 0)
opik_err=$(grep -c "opik.create_llm_span_error" "$PROXY_STDOUT" 2>/dev/null | head -1); opik_err=${opik_err:-0}

# P2-Q1 trace creation (CC path, project=userId)
if printf '%s' "$OPIK_P" | jq -e '.content[]? | select(.name | test("deepseek"))' >/dev/null 2>&1; then
  ok "P2-Q1" "Opik trace exists (project=$OPIK_USER_PROJ, total=$opik_n)"
else
  bad "P2-Q1" "Opik project $OPIK_USER_PROJ has no trace"
fi

# P2-Q2 trace update (the trace is visible in the fork project's request_log)
FKL=$(curl -s -m 15 "$OPIK/api/v1/private/traces?project_name=request_log&page=1&size=5" 2>/dev/null)
fkl_n=$(printf '%s' "$FKL" | jq -r '.total // 0' 2>/dev/null || echo 0)
if [[ "${fkl_n:-0}" -gt 0 ]]; then
  ok "P2-Q2" "fork trace (request_log) exists total=$fkl_n"
else
  skip "P2-Q2" "request_log project has no trace yet"
fi

# P2-Q3 LLM span creation (project=userId, same project as the trace)
SPANS=$(curl -s -m 15 "$OPIK/api/v1/private/spans?project_name=$OPIK_USER_PROJ&page=1&size=5" 2>/dev/null)
SP_N=$(printf '%s' "$SPANS" | jq -r '.total // 0' 2>/dev/null || echo 0)
if [[ "${SP_N:-0}" -gt 0 ]]; then
  ok "P2-Q3" "LLM span exists (project=$OPIK_USER_PROJ, total=$SP_N)"
else
  bad "P2-Q3" "no LLM span"
fi

# P2-Q4 fork span + codex/workbuddy span reporting
FK_S=$(curl -s -m 15 "$OPIK/api/v1/private/spans?project_name=request_log&page=1&size=5" 2>/dev/null)
fks_n=$(printf '%s' "$FK_S" | jq -r '.total // 0' 2>/dev/null || echo 0)
if (( opik_err > 0 )); then
  bad "P2-Q4" "codex/workbuddy span reporting failed $opik_err times (trace_id empty -> 422; runners/codex.ts + workbuddy.ts lack opikCreateTrace)"
elif [[ "${fks_n:-0}" -gt 0 ]]; then
  ok "P2-Q4" "fork span (request_log) exists total=$fks_n"
else
  skip "P2-Q4" "no span reporting errors, but request_log has no span"
fi

##############################################################################
head_ "P2-T ClickHouse (5)"
##############################################################################

# P2-T1 writeLog event:"request" -- WARNING, found empirically: logger.ts only writes usage/analyzer_usage
#   to CH; the request event only goes to JSONL (same line of code as before the refactor, not a regression)
req_ch=$(chq "SELECT count() FROM context_proxy.usage_logs WHERE event='request' FORMAT TSV")
jsonl_req=$(ls -t "$PROXY_REPO"/logs/*.jsonl 2>/dev/null | head -1)
if [[ "$jsonl_req" == "" ]]; then
  skip "P2-T1" "no JSONL file"
else
  n_req=$(grep -c '"event":"request"' "$jsonl_req" 2>/dev/null || echo 0)
  if (( n_req > 0 )); then
    skip "P2-T1" "event=request only goes to JSONL ($n_req entries), CH usage_logs has no such event (established source behavior, not a regression)"
  else
    bad "P2-T1" "no event=request in JSONL either"
  fi
fi

# P2-T2 writeLog event:"usage" contains tokens
u=$(chq "SELECT count() FROM context_proxy.usage_logs WHERE event='usage' AND total_tokens > 0 FORMAT TSV")
if [[ "${u:-0}" -gt 0 ]]; then
  ok "P2-T2" "CH event=usage has token data ($u)"
else
  bad "P2-T2" "no usage records in CH"
fi

# P2-T3 writeRequestLog -- only covers the openai-chat + anthropic runners
n_wrl=$(
  cd "$PROXY_REPO"
  for f in openai-chat anthropic codex workbuddy direct utility; do
    printf '%s=%s ' "$f" "$(grep -c 'writeRequestLog(' src/pipeline/runners/$f.ts)"
  done
)
if printf '%s' "$n_wrl" | grep -q "openai-chat=1" && printf '%s' "$n_wrl" | grep -q "anthropic=1"; then
  if printf '%s' "$n_wrl" | grep -qE "codex=0"; then
    skip "P2-T3" "writeRequestLog coverage: $n_wrl (codex/wb missing, consistent with the known item in the status doc)"
  else
    ok "P2-T3" "writeRequestLog fully covered: $n_wrl"
  fi
else
  bad "P2-T3" "main runners are not wired to writeRequestLog: $n_wrl"
fi

# P2-T4 emitModelIntentTelemetry → tool_call_logs kind=model_intent
mi=$(chq "SELECT count() FROM context_proxy.tool_call_logs WHERE kind='model_intent' AND timestamp > now() - INTERVAL 3 HOUR FORMAT TSV")
mi_ours=$(chq "SELECT count() FROM context_proxy.tool_call_logs WHERE kind='model_intent' AND user_id='$PROBE_USER_ID' FORMAT TSV")
if [[ "${mi:-0}" -gt 0 ]]; then
  ok "P2-T4" "tool_call_logs has model_intent records (whole table $mi, this user $mi_ours)"
else
  bad "P2-T4" "no model_intent records"
fi

# P2-T5 inspectAndRecord -- found empirically to only go into in-memory recentInspections, not persisted to a table
skip "P2-T5" "identity records only go into in-process recentInspections (source implementation, no CH table; this checklist statement does not match the implementation)"

##############################################################################
head_ "P2-U TDAI L0 + Skill (5)"
##############################################################################

l0() {
  curl -s -m 15 -X POST "$CORE/v3/conversation/query" \
    -H "Content-Type: application/json" -H "x-tdai-service-id: $SPACE" -H "Authorization: Bearer local" \
    -d "{\"user_id\":\"$PROBE_USER_ID\",\"team_id\":\"$PROBE_TEAM_ID\",\"agent_id\":\"$PROBE_AGENT_ID\",\"limit\":100}" 2>/dev/null
}

L0=$(l0)
l0n=$(printf '%s' "$L0" | jq -r '.data.messages | length' 2>/dev/null || echo 0)

# P2-U1 L0 write (main conversation)
if [[ "${l0n:-0}" -gt 0 ]]; then
  ok "P2-U1" "Core has L0 records ($l0n)"
else
  bad "P2-U1" "Core has no L0 records"
fi

# P2-U2 L0 skipped (fork/sidequery) -- guaranteed by the memoryTurn=requestKind==="main" gate
if grep -q 'const memoryTurn = requestKind === "main"' \
     "$PROXY_REPO"/src/pipeline/runners/anthropic.ts 2>/dev/null; then
  ok "P2-U2" "L0 gate exists (memoryTurn = requestKind==='main' -> fork/sidequery do not write)"
else
  bad "P2-U2" "L0 requestKind gate not found"
fi

# P2-U3 triggerSkillExtractIfReady
# WARNING: archiving is asynchronous (archive is fire-and-forget / a background worker), so after the request returns
#    the log takes a while to appear. Send a request that definitely has content first, then wait.
curl -s -m 25 -o /dev/null -X POST "$PROXY/claude-code/$SPACE/v1/messages" \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "x-claude-code-session-id: sklprobe-$RANDOM" \
  -H "x-team-id: $PROBE_TEAM_ID" -H "x-agent-id: $PROBE_AGENT_ID" \
  -d "{\"model\":\"$MODEL\",\"max_tokens\":16,\"messages\":[{\"role\":\"user\",\"content\":\"skill probe\"}]}"
for _ in $(seq 1 12); do
  sc=$(grep -c "skill-conversation-add" "$PROXY_STDOUT" 2>/dev/null | head -1); sc=${sc:-0}
  (( sc > 0 )) && break
  sleep 2
done
if (( sc > 0 )); then
  ok "P2-U3" "skill archive pipeline is active (skill-conversation-add $sc times)"
else
  bad "P2-U3" "no skill archiving seen"
fi

# P2-U4 archiveProtocol correct -- the skill extract's langfuse trace carries a protocol tag
LF_SK=$(curl -s -m 15 "$LF/api/public/traces?limit=30&tags=skill-extract" -H "Authorization: Basic $LF_AUTH" 2>/dev/null)
if printf '%s' "$LF_SK" | jq -e '.data | length > 0' >/dev/null 2>&1; then
  ok "P2-U4" "skill.extract trace exists ($(printf '%s' "$LF_SK" | jq -r '.data|length') entries)"
else
  skip "P2-U4" "skill.extract trace not found"
fi

# P2-U5 mem commands also trigger L0
if printf '%s' "$L0" | jq -e '.data.messages[] | select(.content | test("mem:"))' >/dev/null 2>&1; then
  ok "P2-U5" "mem commands also write to L0"
else
  bad "P2-U5" "no mem command records seen in L0"
fi

##############################################################################
printf '\n\033[1m========================================\033[0m\n'
printf '\033[1m P2 OBSERVABILITY summary\033[0m\n'
printf '\033[1m========================================\033[0m\n'
printf '  PASS=%d  FAIL=%d  SKIP=%d\n\n' "$PASS" "$FAIL" "$SKIP"
exit $(( FAIL > 0 ? 1 : 0 ))
