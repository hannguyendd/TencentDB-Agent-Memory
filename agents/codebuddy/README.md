# CodeBuddy (CB)

> agentSource: `codebuddy` | Protocol: OpenAI Chat Completions / Anthropic Messages | Handler: `handler.ts` (shared)
>
> To import local history into Memory Hub, see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

CB configures custom models through the **config file** `~/.codebuddy/models.json`:

```json
{
  "models": [
    {
      "id": "claude-sonnet-4-20250514",
      "name": "proxy-memory-agent",
      "vendor": "claude",
      "apiKey": "<the business user's sk-mem-... user_key>",
      "maxInputTokens": 200000,
      "url": "http://127.0.0.1:8096/codebuddy/default",
      "supportsToolCall": true,
      "supportsImages": true
    }
  ]
}
```

Field notes:
- `id` — a model ID supported by the Proxy upstream (e.g. `claude-sonnet-4-20250514`)
- `name` — the name shown in the CodeBuddy dialog; customizable
- `vendor` — for UI display only (e.g. `claude`, `openai`); does not affect actual requests
- `apiKey` — the business user's `user_key` (obtained from the panel; same as CC's `ANTHROPIC_AUTH_TOKEN`)
- `url` — Proxy address + `/codebuddy/<spaceId>`; `default` is the memory instance ID

After configuring, select this model in the CB dialog.

### ⚠️ Version restrictions

> CodeBuddy **4.10.2 ~ 4.10.4** do not carry a sessionId, so Session Init cannot complete.  
> **Use ≥ 4.10.5 or ≤ 4.10.1**.

Request paths:
- OpenAI: `POST /codebuddy/:spaceId/v1/chat/completions`
- Anthropic: `POST /codebuddy/:spaceId/v1/messages`

---

## 2. Session ID

| Priority | Header |
|----------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |
| 3 | `x-cb-session-id` |
| 4 | `x-codebuddy-session-id` |

The CB IDE plugin generates and sends `x-conversation-id` automatically.

---

## 3. Session Init (session initialization / Form)

### 3.1 Mechanism

CB uses an **`ask_followup_question`** function_call to start an interactive Form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_session_init_` (OpenAI) / `toolu_session_init_` (Anthropic)
- Protocol: OpenAI SSE tool_calls chunks or Anthropic SSE

### 3.2 State machine

```
asset_confirm → team_select → agent_task_select → initialized
```

4-step flow:
1. **asset_confirm** — confirm whether to inject assets ("Use memory/skills?")
2. **team_select** — choose a team
3. **agent_task_select** — choose Agent + Task together
4. **initialized** — inject assets and enter normal conversation

### 3.3 Pagination

CB's `ask_followup_question` option list has **no limit on the number of options**, so no pagination is needed.  
All options are shown at once.

### 3.4 Plan Mode / Default Mode

CB has **no** Default Mode gate. The CB client always has the `ask_followup_question` tool available, so the form can always be sent.

### 3.5 Skipping Session Init

- Choose "No" at the `asset_confirm` step → all subsequent steps are skipped and requests pass straight through
- Type "跳过" / "skip" at any step → skipped once SKIP_RE matches

---

## 4. Request Classification

CB's request classification is simple:

| Type | Description |
|------|-------------|
| **main** | All requests are main by default |

CB has **no** auxiliary request concepts such as fork / sidequery / compact. Every request goes through the full pipeline.

---

## 5. User Text Extraction

In CB the message body `message.content` is always a **plain string** (not a content block array).

Extraction logic:
1. Look for a `<user_query>...</user_query>` XML wrapper in the string
2. If found → extract the inner text
3. If not found → use the entire string as the user text
4. Strip CB's pseudo-XML tags (`<agent_context>`, `<code_context>`, etc.)

---

## 6. Injection Profile

System prompt injection with an **XML structure**:

```xml
<agent_skills>
  <available_skills>...</available_skills>
</agent_skills>
<content_policy>...</content_policy>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection points:
- OpenAI: `messages[0].content` (appended inside the system message string)
- Anthropic: the `system` field

---

## 7. Special Behavior

- **Distinct header set**: `x-agent-intent`, `x-conversation-message-id`, `x-conversation-request-id`
- **Assistant placeholder**: CB assistant messages may be a `"-"` placeholder (empty-reply marker)
- **Shared handler**: dsh also reuses this handler (`handleChatCompletions`)
- **Dual-protocol support**: the same CB version may use either the OpenAI or Anthropic protocol; the handler adapts automatically

---

## 8. Archive Triggers

- Conversations over the threshold automatically trigger `skill/conversation/add`
- `skill/conversation/force-archive` is supported
- Archived data is written to L0

---

## 9. Environment Variables

There are no CB-specific variables. Use the global proxy configuration:

```env
PROXY_PORT=8096
FORWARD_URL=https://api.openai.com   # CB OpenAI upstream
# or FORWARD_URL=https://api.anthropic.com  # CB Anthropic upstream
```

The actual upstream is decided dynamically by `resolveForwardTarget` (tokenhub / direct provider).

---

## 10. FAQ

**Q: What are the main differences between CB and CC?**  
A: Different protocols (OpenAI vs Anthropic), different content structure (string vs content-block array), no auxiliary request classification, and no option pagination.

**Q: Who adds CB's `<user_query>` wrapper?**  
A: The CB IDE plugin client wraps the original user text before sending; the proxy strips it during extraction.

**Q: How does CB differ from CC when CB uses the Anthropic protocol?**  
A: The form tool name differs (`ask_followup_question` vs `AskUserQuestion`), content is still a string, and injection uses XML rather than Markdown. The agentSource marker also differs.
