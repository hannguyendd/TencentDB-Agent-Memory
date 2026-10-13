#!/usr/bin/env bash
# task-e2e.sh -- HTTP endpoint smoke test for the one-step mem:create-task / mem:update-task
#
# Prerequisite: an initialized session with no task_id bound (obtainable via scripts/qa/codex-init.sh)
# Usage:
#   BASE=http://127.0.0.1:8096 USER_KEY=sk-mem-xxx ./task-e2e.sh <session_id>
#
# Coverage:
#   C1  unbound + locked_title  -> persisted successfully
#   C3  already bound + create again -> 409 alreadyBound
#   U3  bound + directDesc    -> persisted successfully
#   U1  unbound + update         -> 404 no task bound

set -uo pipefail

BASE="${BASE:?BASE required, e.g. BASE=http://127.0.0.1:8096}"
USER_KEY="${USER_KEY:?USER_KEY required (sk-mem-*)}"
SPACE="${SPACE:-default}"
SID="${1:?session_id required as first arg (must be initialized & not bound to task)}"
AGENT_SOURCE="${AGENT_SOURCE:-claude-code}"

step() { echo -e "\n===== $* =====" >&2; }

recent_messages_json='[{"role":"user","content":"I'm developing the one-step create-task"},{"role":"assistant","content":"OK, I've noted it"}]'

# ── C1: create-task with locked_title ────────────────────────────────────
step "C1: create-task with locked_title=\"My smoke task\""
RESP_C1=$(curl -sS -X POST "$BASE/v3/session/create-task" \
  -H "authorization: Bearer $USER_KEY" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{
  "session_key": "$SID",
  "agent_source": "$AGENT_SOURCE",
  "space_id": "$SPACE",
  "locked_title": "My smoke task",
  "recent_messages": $recent_messages_json
}
EOF
)")
echo "$RESP_C1" | head -c 500
TASK_ID=$(echo "$RESP_C1" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("data",{}).get("task_id",""))' 2>/dev/null)
[[ -z "$TASK_ID" ]] && { echo -e "\nFAIL C1: no task_id in response"; exit 1; }
echo -e "\n✅ C1 pass, task_id=$TASK_ID"

# ── C3: create again -> should 409 ────────────────────────────────────────────
step "C3: create-task again → expect 409 alreadyBound"
CODE_C3=$(curl -sS -o /tmp/c3.json -w "%{http_code}" -X POST "$BASE/v3/session/create-task" \
  -H "authorization: Bearer $USER_KEY" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{"session_key":"$SID","agent_source":"$AGENT_SOURCE","space_id":"$SPACE","locked_title":"Duplicate","recent_messages":$recent_messages_json}
EOF
)")
cat /tmp/c3.json | head -c 300
if [[ "$CODE_C3" != "409" ]]; then echo -e "\nFAIL C3: expected 409 got $CODE_C3"; exit 1; fi
echo -e "\n✅ C3 pass (409)"

# ── U3: update-task with direct_description ────────────────────────────
step "U3: update-task with direct_description"
RESP_U3=$(curl -sS -X POST "$BASE/v3/session/update-task" \
  -H "authorization: Bearer $USER_KEY" \
  -H 'content-type: application/json' \
  -d "$(cat <<EOF
{
  "session_key": "$SID",
  "agent_source": "$AGENT_SOURCE",
  "space_id": "$SPACE",
  "direct_description": "Smoke script U3 addition: one-step persistence",
  "recent_messages": $recent_messages_json
}
EOF
)")
echo "$RESP_U3" | head -c 500
CODE_U3=$(echo "$RESP_U3" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("code",-1))')
if [[ "$CODE_U3" != "0" ]]; then echo -e "\nFAIL U3: code=$CODE_U3"; exit 1; fi
echo -e "\n✅ U3 pass"

echo -e "\n─────────────────────────────────────────────"
echo "All smoke tests passed ✅ (task_id=$TASK_ID)"
echo "The U1 scenario needs a new session; run again and call update-task directly on a different SID to observe the 404"
