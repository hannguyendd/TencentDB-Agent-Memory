# Claude Code (CC)

> agentSource: `claude-code` | Protocol: Anthropic Messages API | Handler: `anthropicHandler.ts`
>
> To import local history into Memory Hub, see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

### Option 1: Environment variables

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8096/claude-code/default
export ANTHROPIC_AUTH_TOKEN="<the business user's sk-mem-... user_key>"
claude --model <upstream model configured in PROXY_UPSTREAM_MODEL>
```

### Option 2: Config file `~/.claude/settings.json` (recommended, persistent)

Edit `~/.claude/settings.json` and add the following to the `env` field:

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "<the business user's sk-mem-... user_key>",
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8096/claude-code/default",
    "ANTHROPIC_MODEL": "claude-opus-4.7"
  }
}
```

After configuring, just run `claude`. CC loads environment variables from the `env` field of `settings.json` at startup.

### Field notes

- `ANTHROPIC_BASE_URL`: points CC's API at the proxy instead of anthropic.com; `default` in the path is the memory instance ID (`x-tdai-service-id`), which is always `default` in local deployments
- `ANTHROPIC_AUTH_TOKEN`: the **business user's** user_key (obtained from the panel's "API Key" page; using the admin key directly is not recommended)
- `ANTHROPIC_MODEL`: the upstream model name (can also be given with the `--model` command-line flag)

The Proxy runs these steps in order: `auth` (validate user_key) → `sessionInit` (team/agent/task selection form) → `injection` (inject L2/L3 memory, skills and knowledge into the system prompt) → forward to the upstream LLM.

Requests from the client hit `POST /claude-code/:spaceId/v1/messages`.

---

## 2. Session ID

| Priority | Header |
|----------|--------|
| 1 | `x-claude-code-session-id` |
| 2 | `x-session-id` |
| 3 | `x-conversation-id` |

CC generates a session ID automatically for each new session and sends it with requests, so no manual configuration is needed.

---

## 3. Session Init (session initialization / Form)

### 3.1 Mechanism

CC uses **Anthropic's native `tool_use`** to start an interactive Form:

- Tool name: `AskUserQuestion`
- Block ID prefix: `toolu_cc_session_init_`
- Protocol: Anthropic SSE (`content_block_start` / `content_block_delta` / `content_block_stop` events)

### 3.2 State machine

```
team_select → agent_select → task_select → initialized
```

4-step flow:
1. **team_select** — choose a team
2. **agent_select** — choose an Agent
3. **task_select** — choose a Task (includes an isDefault virtual item that can be skipped)
4. **initialized** — inject assets and enter normal conversation

### 3.3 Pagination

CC's `AskUserQuestion` tool has a hard limit of **2 to 4 options** (an Anthropic protocol constraint).  
When there are more than 3 options, pagination is used:

- Each page shows 3 real options + 1 "More →" page-turn item
- Choosing "More →" returns the next page
- The last page has no page-turn item

### 3.4 Plan Mode / Default Mode

CC has **no** Default Mode gate concept. The CC client always supports tool_use, so the form can always be sent.

### 3.5 Skipping Session Init

At any step the user can type "跳过" / "skip" (or choose Other and type skip) to skip that step (matched by the `SKIP_RE` regex).  
After skipping, the proxy passes requests through without injecting assets.

---

## 4. Request Classification

CC distinguishes many request types:

| Type | Detection | Handling |
|------|-----------|----------|
| **main** | default | Full pipeline (injection + archiving + telemetry) |
| **fork** | `cache_control` marker position analysis | Full pipeline (subagents share the session_id) |
| **sidequery** | `cache_control` marker + specific pattern | Lightweight handling |
| **compact** | path suffix `/compact` | Auxiliary request, injection skipped |
| **title-gen** | path suffix + body features | Auxiliary request, injection skipped |

CC's `cache_control` marker is the key criterion for main vs. auxiliary requests.

---

## 5. User Text Extraction

Extracted from the last `role: "user"` message in `body.messages`:
- Take the last `type: "text"` content block
- **Skip** blocks that start with `<system-reminder>` (these are system-injected, not user text)

---

## 6. Injection Profile

System prompt injection with a **Markdown structure**:

```markdown
## Skills
<available_skills>...</available_skills>

## Memory
<user_memory>...</user_memory>

# Harness
<session_context>...</session_context>
```

The injection point is the `body.system` field (in the Anthropic protocol, system is separate from messages).

---

## 7. Special Behavior

- **resetEpoch**: supports the `mem:session-reset` command, with a cross-node stale check
- **Vertex AI relay**: supports `x-vertex-ai-session-id` passthrough
- **Fork/Subagent**: when CC's `task` command starts a subagent the session_id does not change, and the proxy accumulates the subagent and the main agent into the same archive
- **mem commands**: fully supports `mem:sync` / `mem:create-skill` / `mem:session-reset`, etc.

---

## 8. Archive Triggers

- When a conversation exceeds the threshold (token count / turns), `skill/conversation/add` is triggered automatically
- `skill/conversation/force-archive` is supported for manual archiving
- Archived data is written to L0 (TDAI write)

---

## 9. Environment Variables

There are no CC-specific variables. Use the global proxy configuration:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.anthropic.com   # CC's upstream
```

---

## 10. FAQ

**Q: Can CC get stuck because the form has too many options?**  
A: No. Pagination guarantees at most 4 options at a time, though with many options the user has to page through several times.

**Q: Will CC subagent requests repeat session-init?**  
A: No. Subagents reuse the main agent's session_id, and the proxy skips the form once it sees the session is already initialized.

**Q: Do CC's auxiliary requests (title-gen / compact) go through injection?**  
A: No. The proxy recognizes auxiliary requests and passes them through without injection/archiving.
