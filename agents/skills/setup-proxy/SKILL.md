---
name: setup-proxy
description: Interactively guide the user through connecting an AI Agent to Memory Proxy (probe step by step, verify step by step)
triggers:
  - configure proxy
  - configure agent
  - setup proxy
  - connect proxy
  - connect memory
---

# Setup Proxy — Agent Connection Setup Wizard

You are helping the user connect an AI Agent client (Claude Code / CodeBuddy / Codex / WorkBuddy / dsh / Hermes / OpenClaw) to Memory Proxy.

## Background

Memory Proxy is an LLM request proxy that injects team memory/skills/knowledge before forwarding requests to the upstream LLM. Each agent client has a different config file format and protocol:

| Agent | Config file | Protocol | Special requirements |
|-------|----------|------|----------|
| claude-code | `~/.claude/settings.json` | Anthropic Messages | Write 5 model variables in the env field |
| codebuddy | `~/.codebuddy/models.json` | OpenAI Chat | Append an entry to the models array |
| codex | `~/.codex/config.toml` | OpenAI Responses | TOML format, must set `wire_api = "responses"` |
| workbuddy | `~/.workbuddy/models.json` | OpenAI Chat / Responses | Top-level array |
| dsh | `~/.dsh/settings.yaml` + `~/.dsh/.credentials.yaml` | OpenAI Chat (no /v1) | Two files + chmod 700/600 |
| hermes | `~/.hermes/config.yaml` | OpenAI Chat | Requires header preselection (x-team-id/agent-id/task-id) |
| openclaw | `~/.openclaw/openclaw.json` | OpenAI Chat | Requires header preselection + allowPrivateNetwork |

## Script location

Config-writing script: `agents/skills/setup-proxy/setup-proxy.sh` (relative to the repo root)

## Execution flow

**Follow the order below strictly; each step must pass verification before moving on to the next.**

### Step 1: Scan existing config

First check whether the user already has a proxy config, to avoid re-entering it:

```bash
# Check Claude Code
cat ~/.claude/settings.json 2>/dev/null | jq -r '.env.ANTHROPIC_BASE_URL // empty'

# Check CodeBuddy
cat ~/.codebuddy/models.json 2>/dev/null | jq -r '.models[]? | select(.url | contains("/codebuddy/")) | .url' 2>/dev/null | head -1

# Check other agents similarly...
```

If a URL containing a proxy path is found (containing fragments such as `/claude-code/`, `/codebuddy/`, `/codex/`), **extract and display**:
- Proxy address (the part of the URL before `/<agent>/`)
- Instance ID (the segment after `/<agent>/` in the URL)
- User Key (the value of the corresponding field, masked, showing the first and last 4 characters)
- Model ID

Ask the user: "An existing config was detected. Reuse it?"
- Yes -> skip to Step 3
- No -> continue to Step 2 for manual input

### Step 2: Collect basic information

Ask the user for, in order:
1. **Proxy address** (including protocol + port, e.g. `http://127.0.0.1:8096`)
2. **Instance ID** (default `default`; usually no need to change for local deployments)
3. **User Key** (obtained from the panel API Key page; any format)

Confirm after each item is obtained; do not ask all three at once.

### Step 3: Choose an Agent

Show the 7 available agents and let the user choose **one**:
1. Claude Code
2. CodeBuddy
3. Codex
4. WorkBuddy
5. dsh (DeepSeek Harness)
6. Hermes
7. OpenClaw

### Step 4: Enter the model ID

Tell the user:
- This model ID must be one supported by the Proxy upstream
- Give common examples: `claude-sonnet-4-20250514`, `claude-opus-4.7`, `gpt-5.5`, `deepseek-r1`

### Step 5: Health probe (key verification step)

**Based on the selected agent's protocol**, construct the corresponding curl probe request:

```bash
# Claude Code → Anthropic Messages
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/claude-code/${INSTANCE_ID}/v1/messages" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# CodeBuddy / Hermes / OpenClaw → OpenAI Chat
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/${AGENT}/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# dsh → OpenAI Chat but without /v1
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/dsh/${INSTANCE_ID}/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'

# Codex → Responses API
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/codex/${INSTANCE_ID}/v1/responses" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","input":[{"type":"message","role":"user","content":[{"type":"input_text","text":"ping"}]}],"stream":false}'

# WorkBuddy → OpenAI Chat (more generic)
curl -s -w "\n%{http_code}" -X POST "${PROXY_HOST}/workbuddy/${INSTANCE_ID}/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${USER_KEY}" \
  -d '{"model":"'${MODEL_ID}'","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}'
```

**Interpreting the result**:
- HTTP connection failure (000) → tell the user the proxy is unreachable, have them check address/port/service status, **do not continue**
- 2xx → fully normal, continue
- 4xx → proxy reachable (possibly a form returned by session-init or an auth issue), **show the response body to the user for reference**, continue
- 5xx → problem with the proxy, **show the full error response**, ask the user whether to continue

### Step 6: Header preselection (Hermes / OpenClaw only)

If hermes or openclaw was chosen, extra header preselection info must be collected. These agents do not support interactive forms, so the team/agent/task IDs must be prefilled in the config.

**Preferred approach: fetch the lists via the panel API and let the user choose**

Ask the user whether to provide the panel backend address (default `http://127.0.0.1:8125`). If provided:

```bash
# 1. Get user_id via auth/verify first
curl -s -X POST "${PANEL_URL}/api/v1/meta/auth/verify" \
  -H "Content-Type: application/json" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Extract from .data.user.user_id

# 2. Fetch the Team list
curl -s -X POST "${PANEL_URL}/api/v1/meta/team/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"user_key":"'${USER_KEY}'"}'
# Show from .data.items for the user to choose

# 3. Fetch the Agent list (filtered by owner_user_id)
curl -s -X POST "${PANEL_URL}/api/v1/meta/agent/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'","owner_user_id":"'${USER_ID}'"}'
# Show from .data.items for the user to choose

# 4. Fetch the Task list
curl -s -X POST "${PANEL_URL}/api/v1/meta/task/list" \
  -H "Content-Type: application/json" \
  -H "x-tdai-user-key: ${USER_KEY}" \
  -H "x-tdai-service-id: ${INSTANCE_ID}" \
  -d '{"team_id":"'${TEAM_ID}'","user_key":"'${USER_KEY}'"}'
# The first option is always "Do not link a task this time (no-task)"
```

If the panel is unreachable or the user doesn't want to provide it, have the user fill in team_id / agent_id / task_id manually.

You also need an **x-conversation-id** (can be auto-generated, e.g. `conv-20260820-xxxx`).

### Step 7: Confirm the config file path

Tell the user the default path (see the table above) and ask whether to use it. If not, have the user fill it in.

### Step 8: Call the script to write the config

After all information is collected and verified, **call the script in non-interactive mode** to write the config:

```bash
bash agents/skills/setup-proxy/setup-proxy.sh --non-interactive \
  --proxy-host "${PROXY_HOST}" \
  --instance-id "${INSTANCE_ID}" \
  --user-key "${USER_KEY}" \
  --agent "${CHOSEN_AGENT}" \
  --model "${MODEL_ID}" \
  --config-path "${CONFIG_PATH}"
```

If Hermes/OpenClaw, append:
```bash
  --team-id "${TEAM_ID}" \
  --agent-id "${AGENT_ID}" \
  --task-id "${TASK_ID}" \
  --conv-id "${CONVERSATION_ID}"
```

**Check the script exit code**: 0 = success, non-zero = failure (show the output to the user).

### Step 9: Verify the written result

After writing, read the config file to confirm the content is correct:
```bash
cat <config_path>
```

Show the key fields to the user for confirmation.

### Step 9.5: Remind the user to switch models

**Writing the config does not mean it takes effect**; the user must be reminded to switch to the Proxy model in the client for requests to go through the Proxy chain:

| Agent | How to switch |
|-------|----------|
| Claude Code | No action needed; the env in `settings.json` is loaded automatically at startup |
| CodeBuddy | Switch the model in the chat box to **proxy-memory-agent** (the configured model ID) |
| Codex | No action needed; `config.toml` already specifies the model |
| WorkBuddy | Switch to the corresponding model in the custom model list in the model selector |
| dsh | No action needed; `settings.yaml` already specifies the model |
| Hermes / OpenClaw | Make sure the client's selected provider/model points to the Proxy config |

**Be sure to tell the user**: if the model isn't switched, requests won't go through the Proxy, and memory/skill injection won't take effect.

### Step 10: Asset import (optional)

After configuration is complete, ask the user whether to import this Agent's local assets (skills + conversation history) into team memory.

If the user chooses to import:
- Panel URL, Team ID, Agent ID are needed
- If team/agent was already chosen in Step 6, recommend reusing
- Otherwise ask the user to provide them

Then call:
```bash
PANEL_URL="${PANEL_URL}" TDAI_SERVICE_ID="${INSTANCE_ID}" TDAI_USER_KEY="${USER_KEY}" \
  tsx agents/asset-import.ts --source "${CHOSEN_AGENT}" --team-id "${TEAM_ID}" --agent-id "${AGENT_ID}"
```

If `tsx` is not available, tell the user to run the command manually.

## Error handling principles

1. **Connection failure**: clearly tell the user which step failed, and give troubleshooting suggestions (check service status, port, network)
2. **4xx response**: proxy reachable but a business error; show the full response body and help the user decide whether it's a wrong key, an unsupported model, or something else
3. **File permissions**: before writing, check that the directory exists/is writable; dsh needs chmod
4. **Don't guess**: if information is insufficient or state is unclear, ask the user rather than assume

## Notes

- Configure only one agent at a time; after finishing, tell the user they can rerun to configure other agents
- The script automatically backs up the original config file as `.bak.<timestamp>`
- All CC model environment variables (HAIKU/SONNET/OPUS/SUBAGENT) are set uniformly to the user's chosen model
- Codex must switch to Plan mode (Shift+Tab) before the first conversation; this is a client limitation
- dsh URLs do not include `/v1`, which is hardcoded in the client
- Hermes/OpenClaw x-conversation-id must be changed manually for each new conversation
