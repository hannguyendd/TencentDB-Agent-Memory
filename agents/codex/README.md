# Codex

> agentSource: `codex` | Protocol: OpenAI Responses API | Handler: `codexHandler.ts` (standalone)
>
> To import local history into Memory Hub, see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

Codex is configured through the **config file** `~/.codex/config.toml`:

```toml
# ~/.codex/config.toml
model_provider = "team-proxy"
model = "claude-opus-4.7"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.team-proxy]
name       = "TDAI team-proxy"
wire_api   = "responses"
base_url   = "http://127.0.0.1:8096/codex/default"
experimental_bearer_token = "<the business user's sk-mem-... user_key>"

request_max_retries    = 2
stream_max_retries     = 3
stream_idle_timeout_ms = 120000
```

Field notes:
- `wire_api = "responses"` — **required**; Codex uses the OpenAI Responses API protocol
- `base_url` — Proxy address + `/codex/<spaceId>`; `default` is the memory instance ID
- `experimental_bearer_token` — the business user's `user_key` (obtained from the panel)
- `disable_response_storage = true` — disables local caching so every turn goes through Proxy injection
- `stream_idle_timeout_ms = 120000` — prevents a timeout while session-init waits for user action

> ⚠️ **Switch to Plan mode before the first conversation** (`Shift+Tab`). Codex's default Agent mode executes tool calls automatically and skips the user selection, so session-init never completes. After choosing Team→Agent→Task, switch back to Agent mode.

Request paths:
- `POST /codex/:spaceId/v1/responses`
- `POST /codex/:spaceId/responses` (without the v1 prefix, also accepted)

Auxiliary paths:
- `/codex/:spaceId/responses/compact` — compact request
- `/codex/:spaceId/memories/trace_summarize` — trace summarization
- `/codex/:spaceId/realtime/calls` — realtime calls

---

## 2. Session ID

| Priority | Source |
|----------|--------|
| 1 | `session-id` header |
| 2 | `body.client_metadata.session_id` |

Codex CLI generates the session_id automatically and writes it to both the header and the body, so no manual configuration is needed.

---

## 3. Session Init (session initialization / Form)

### 3.1 Mechanism

Codex uses a **`request_user_input`** function_call to start an interactive Form:

- Tool name: `request_user_input`
- ID prefix: `fc_codex_session_init_` (⚠️ the `fc_` prefix is required; the OpenAI Responses spec enforces it)
- Call ID prefix: `call_codex_session_init_`
- Protocol: OpenAI Responses API SSE (`response.created` / `response.output_item.*` / `response.completed` events)

### 3.2 State machine

Reuses the CB state machine, but tagged with `agentSource="codex"`, `protocol="responses"`:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

Codex uses a dedicated `computeCodexPagination`. Its rules are similar to CC (limited number of options), but the implementation is separate.

### 3.4 ⚠️ Default Mode Gate (key difference)

Codex has two run modes:
- **Suggest mode** — the `request_user_input` tool is available → the form flow works normally
- **Default mode** — the client blocks `request_user_input` calls

**Default mode detection**: after the proxy sends the form, the `function_call_output.output` returned by the client contains:

```
"request_user_input is unavailable in Default mode"
```

Once the proxy detects this gate string, it **permanently skips** session-init and passes all subsequent requests straight through.

### 3.5 Skipping Session Init

Three ways:
1. The Default mode gate triggers automatically → skipped permanently
2. The user types "跳过" / "skip" manually
3. Choose "No" at asset_confirm

---

## 4. Request Classification

Codex uses **three signals** to identify auxiliary requests:

| Signal | What is checked |
|--------|-----------------|
| Path suffix | `/compact`, `/memories/trace_summarize`, `/realtime/calls` |
| Header | `x-openai-memgen-request: true` |
| Body | `body.client_metadata.thread_source` ≠ `"main"` |

Any one hit → classified as auxiliary → injection/archiving is skipped.

---

## 5. User Text Extraction

Extracted from the `body.input[]` array:
1. Find the last item with `type: "message"` and `role: "user"`
2. Extract the text of all `input_text` blocks from its `content[]`
3. Concatenate them into the final user text

⚠️ Codex's body structure is entirely different from Chat Completions (`input[]` instead of `messages[]`).

---

## 6. Injection Profile

Uses the codex-specific injection builder `buildCodexInjectionBlock`:

```
Injected into the instructions field (not messages/input)
```

Codex's injection point is `body.instructions` (the equivalent of the system prompt in the Responses API).

---

## 7. Special Behavior

- **Standalone handler**: `codexHandler.ts`, not shared with CB/CC
- **fc_ prefix enforced**: the OpenAI Responses API requires function_call ids to start with `fc_`; otherwise the client gets a 400 on replay
- **Marker routing**: `/codex/:spaceId/cost-guard/responses` and `/codex/:spaceId/analyse/responses` support cost-guard/analyse traffic splitting
- **Archive hook**: on 2026-08-11 codex gained `skill/conversation/add` + TDAI L0 writes (previously data was silently dropped)

---

## 8. Archive Triggers

- Conversations over the threshold are archived automatically via `skill/conversation/add` (through the responses branch of `normalize-conversation`)
- `skill/conversation/force-archive` is supported
- Codex archiving must go through `normalizeCodexConversation` to convert to the unified format

---

## 9. Environment Variables

```env
PROXY_PORT=8096
# Codex upstream (usually tokenhub or copilot.tencent.com)
# Routed dynamically by resolveForwardTarget
```

The local codex upstream uses `https://copilot.tencent.com` (without /v1 or /v2).  
Available models: `gpt-5.3-codex` / `gpt-5.4` / `gpt-5.5` / `gpt-5.6-*` / `deepseek-r1`; `claude-*` is hard-rejected.

---

## 10. FAQ

**Q: Is there no memory injection at all in Codex Default mode?**  
A: Correct. Once the Default mode gate triggers, the proxy passes traffic through without any injection. This follows from the codex client's design: Default mode optimizes for minimal latency.

**Q: What is the fc_ prefix issue?**  
A: The OpenAI Responses API validates the function_call id field with a regex that requires it to start with `fc_`. The proxy uses the `fc_codex_session_init_` prefix when generating the form, and call_id keeps the `call_` prefix. Before the fix, the codex client's 5th replayed request always returned 400.

**Q: What is Codex's /compact request?**  
A: Similar to CC's conversation compaction. It is an auxiliary request triggered automatically by the client and needs no injection/archiving.

**Q: How does Codex reuse code from CB?**  
A: Codex has its own `codexHandler.ts`, but the session-init state machine is built on CB's implementation (called with different agentSource + protocol parameters).

---

## 11. Differences from Claude Code / CodeBuddy

| Dimension | Claude Code | CodeBuddy | Codex |
|-----------|-------------|-----------|-------|
| Protocol | Anthropic Messages | OpenAI Chat Completions | **OpenAI Responses** |
| Config file | Environment variables | `~/.codebuddy/models.json` | `~/.codex/config.toml` |
| URL prefix | `/claude-code/<spaceId>` | `/codebuddy/<spaceId>` | `/codex/<spaceId>` |
| Key passing | env `ANTHROPIC_AUTH_TOKEN` | JSON `apiKey` | TOML `experimental_bearer_token` |
| Session init | Form pops up automatically | Form pops up automatically | **Must switch to Plan mode manually the first time** |
