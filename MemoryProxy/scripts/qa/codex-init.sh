#!/usr/bin/env bash
# codex-init.sh —— use curl to walk through the Codex 5-step session-init form,
# producing an initialized session. Usage:
#   ./codex-init.sh                       # run the full flow, SID auto-generated
#   ./codex-init.sh --sid <uuid>          # specify the SID
#   ./codex-init.sh --bypass              # only walk asset_confirm and choose "No" -> bypassed session
#   ./codex-init.sh --team memory --agent "开发大师" --task "接入e2e联合评测"
# The resulting SID is printed on the last line and also written to /tmp/codex-qa-sid.env

set -uo pipefail
# Note: no set -e, because the awk exit inside send_form_answer makes curl receive SIGPIPE and return 141

BASE="${BASE:?BASE required, e.g. BASE=http://127.0.0.1:8096}"
USER_KEY="${USER_KEY:?USER_KEY required (sk-mem-* / ck_* from MemoryPanel)}"
SPACE="${SPACE:-default}"
SID=""
TEAM="memory"          # by default pick the first team
AGENT="开发大师"        # by default pick an agent (name is data on the server; keep as is)
TASK=""                # if empty, pick the first task that is not "More"
MODE="full"            # full | bypass

# argument parsing
while (( "$#" )); do
  case "$1" in
    --sid)    SID="$2"; shift 2;;
    --team)   TEAM="$2"; shift 2;;
    --agent)  AGENT="$2"; shift 2;;
    --task)   TASK="$2"; shift 2;;
    --bypass) MODE="bypass"; shift;;
    --space)  SPACE="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done

[[ -z "$SID" ]] && SID="$(cat /proc/sys/kernel/random/uuid)"

echo "SID=$SID  MODE=$MODE  SPACE=$SPACE" >&2

# Generic helper: send one turn, capture call_id, print an event.name summary
call_id_of() {
  grep -oP 'call_codex_session_init_\d+' | head -1
}

send_first_turn() {
    # ⚠️ input[i] must carry type:"message", otherwise codexAdapter.extractUserText
    # (agent-adapters/codex.ts:88) returns null and mem: commands can never be intercepted.
  curl -sS -N -X POST "$BASE/codex/$SPACE/responses" \
    -H "authorization: Bearer $USER_KEY" \
    -H "session-id: $SID" \
    -H 'content-type: application/json' --max-time 15 \
    -d '{"model":"deepseek-v4-pro","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"hi"}]}],"stream":true}'
}

send_form_answer() {
  local call_id="$1" answer="$2"
    # Early exit: stop as soon as response.completed is read (curl exits via SIGPIPE, which does not affect the returned content)
  set +e
  curl -sS -N -X POST "$BASE/codex/$SPACE/responses" \
    -H "authorization: Bearer $USER_KEY" \
    -H "session-id: $SID" \
    -H 'content-type: application/json' --max-time 60 \
    -d "$(jq -cn --arg cid "$call_id" --arg ans "$answer" \
      '{model:"deepseek-v4-pro",input:[{type:"function_call_output",call_id:$cid,output:$ans}],stream:true}')" \
    2>/dev/null | awk '/response.completed/ {print; exit} {print}'
  set -e
}

# Get the label list of the form's first question from the response
# In arguments the labels are \"escaped\", so extract them with python
extract_options() {
  python3 -c '
import sys, json, re
data = sys.stdin.read()
labels = re.findall(r"\\\"label\\\":\\\"([^\\\\\"]+)\\\"", data)
seen = set()
for l in labels:
    if l not in seen:
        seen.add(l); print(l)
'
}

extract_stage() {
  python3 -c '
import sys, re
data = sys.stdin.read()
m = re.search(r"\\\"id\\\":\\\"(asset_confirm|team|agent_task|agent_select|task_select|team_select)\\\"", data)
print(m.group(1) if m else "")
'
}

# ── Step 1: asset_confirm ──────────────────────────────────────────────
echo "=== step1: asset_confirm ===" >&2
R1="$(send_first_turn)"
CID1="$(echo "$R1" | call_id_of)"
[[ -z "$CID1" ]] && { echo "ERR: no call_id from step1"; echo "$R1" | head -c 2000; exit 1; }
echo "  call_id=$CID1  stage=$(echo "$R1" | extract_stage)" >&2

if [[ "$MODE" == "bypass" ]]; then
    R2="$(send_form_answer "$CID1" "否，本次不关联")"  # option label: "No, do not link this time"
  echo "  BYPASSED" >&2
  echo "$SID"
  echo "SID=$SID BYPASSED=1" > /tmp/codex-qa-sid.env
  exit 0
fi

R2="$(send_form_answer "$CID1" "是，关联团队资产")"  # option label: "Yes, link team assets"
CID2="$(echo "$R2" | call_id_of)"
STAGE2="$(echo "$R2" | extract_stage)"
echo "  step2 stage=$STAGE2 call_id=$CID2" >&2
if [[ -z "$CID2" ]]; then
  echo "ERR: no call_id from step2 (asset_confirm=yes)"
  echo "$R2" | head -c 2000; exit 1
fi

# ── Step 2: team ──────────────────────────────────────────────
# team options look like "memory (uyb7sion)"; match the label containing $TEAM
TEAM_OPTS="$(echo "$R2" | extract_options)"
TEAM_LABEL="$(echo "$TEAM_OPTS" | grep -F "$TEAM" | head -1)"
[[ -z "$TEAM_LABEL" ]] && { echo "ERR: team '$TEAM' not in options: $TEAM_OPTS"; exit 1; }
echo "  picking team: $TEAM_LABEL" >&2

R3="$(send_form_answer "$CID2" "$TEAM_LABEL")"
CID3="$(echo "$R3" | call_id_of)"
STAGE3="$(echo "$R3" | extract_stage)"
echo "  step3 stage=$STAGE3 call_id=$CID3" >&2

# ── Step 3: agent (stage may be the merged agent_task page or agent_select) ─────
AGENT_OPTS="$(echo "$R3" | extract_options)"
AGENT_LABEL="$(echo "$AGENT_OPTS" | grep -F "$AGENT" | head -1)"
if [[ -z "$AGENT_LABEL" ]]; then
    # fallback: take the first option that is not "更多" ("More")
    AGENT_LABEL="$(echo "$AGENT_OPTS" | grep -v -F "更多..." | head -1)"
fi
echo "  picking agent: $AGENT_LABEL" >&2

R4="$(send_form_answer "$CID3" "$AGENT_LABEL")"
CID4="$(echo "$R4" | call_id_of)"
STAGE4="$(echo "$R4" | extract_stage)"
echo "  step4 stage=$STAGE4 call_id=$CID4" >&2

# ── Step 4+: task select (may page a few times) ──────────────────────────────
# Loop exit = CID4 empty (form finished) or stage is not task-related
while [[ -n "$CID4" ]] && [[ "$STAGE4" == "task_select" || "$STAGE4" == "agent_task" ]]; do
  TASK_OPTS="$(echo "$R4" | extract_options)"
    # If TASK was not specified, pick the first one that is not "更多..." ("More...")
  if [[ -n "$TASK" ]]; then
    PICK="$(echo "$TASK_OPTS" | grep -F "$TASK" | head -1)"
  else
        PICK="$(echo "$TASK_OPTS" | grep -v -F "更多..." | head -1)"
  fi
  if [[ -z "$PICK" ]]; then
        # no match, turn the page
    if echo "$TASK_OPTS" | grep -qF "更多..."; then
      PICK="$(echo "$TASK_OPTS" | grep -F "更多..." | head -1)"
      echo "  paginate: $PICK" >&2
    else
      echo "ERR: task '$TASK' not found, no more pages"
      exit 1
    fi
  fi
  echo "  picking task: $PICK" >&2
  R4="$(send_form_answer "$CID4" "$PICK")"
  CID4="$(echo "$R4" | call_id_of)"
  STAGE4="$(echo "$R4" | extract_stage)"
  echo "  next stage=$STAGE4 call_id=$CID4" >&2
done

# By here the session should be initialized -- R4 should be a normal LLM reply (response.output_text)
if echo "$R4" | grep -q 'response.completed' && ! echo "$R4" | grep -q 'call_codex_session_init_'; then
  echo "  INITIALIZED ✓" >&2
else
  echo "  WARN: unexpected final response shape" >&2
  echo "$R4" | tail -c 500 >&2
fi

echo "$SID"
echo "SID=$SID BYPASSED=0" > /tmp/codex-qa-sid.env
