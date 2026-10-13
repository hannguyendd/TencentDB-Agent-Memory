# OpenCode

> agentSource: `opencode` | Protocol: OpenAI Chat Completions | Handler: `handler.ts` (shared with CB / dsh)

---

## 1. Client connection config

OpenCode is an open-source AI coding CLI [from SST](https://github.com/sst/opencode); it connects to the Proxy by configuring a custom provider in
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxy-memory": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Proxy Memory (OpenCode)",
      "options": {
        "baseURL": "http://127.0.0.1:8096/opencode/default/v1",
        "apiKey": "<business user's sk-mem-... user_key>"
      },
      "models": {
        "claude-opus-4.7-1m": {
          "name": "claude-opus-4.7-1m"
        }
      }
    }
  }
}
```

Field notes:
- `baseURL` — Proxy address + `/opencode/<spaceId>/v1`; `default` is the memory instance ID (spaceId)
- `apiKey` — the business user's `user_key` (copy it from the MemoryPanel panel → OpenCode card)
- `models.<id>.name` — a model ID supported by the Proxy upstream (e.g. `claude-opus-4.7-1m`)
- OpenCode uses the `@ai-sdk/openai-compatible` provider and speaks the **OpenAI Chat Completions** protocol

After starting OpenCode, pick a model under `proxy-memory` in the `/model` selector.

Request paths:
- Main path: `POST /opencode/:spaceId/v1/chat/completions`
- Bare-tail variant: `POST /opencode/:spaceId/chat/completions` (when `baseURL` has no `/v1`)

---

## 2. Session ID

| Priority | Header |
|--------|--------|
| 1 | `x-conversation-id` |
| 2 | `x-session-id` |

The OpenCode client itself **does not carry** a session ID header; the proxy automatically generates
a stable sessionId for each request (based on the request context), which is behaviorally equivalent to "each session is independent".

If `x-conversation-id` is added through a wrapper / proxy layer, the proxy uses it first.

---

## 3. Session Init (session initialization / Form)

### 3.1 Mechanism

OpenCode reuses CB's **`ask_followup_question`** function_call mechanism to launch an interactive Form:

- Tool name: `ask_followup_question`
- Call ID prefix: `call_oc_session_init_` (the handler uses a separate prefix for opencode, distinguishing it from CB `call_session_init_` / dsh `call_dsh_session_init_`)
- Protocol: OpenAI SSE tool_calls chunks

### 3.2 State machine

Reuses the CB state machine:

```
asset_confirm → team_select → agent_task_select → initialized
```

### 3.3 Pagination

No quantity limit; all options are shown at once.

### 3.4 Skipping Session Init

- Choose "No" at `asset_confirm` → pass through directly
- Enter "跳过" / "skip" at any step → skip

---

## 4. Marker routing (⚠️ key point)

OpenCode supports appending a **marker** via a URL segment to trigger cost-guard routing or analyse request classification,
with usage fully aligned with CB / Codex:

| Marker | Path | Purpose |
|--------|------|------|
| (none) | `/opencode/<spaceId>/v1/chat/completions` | Default generic pipeline |
| **cost-guard** | `/opencode/<spaceId>/cost-guard/v1/chat/completions` | Force the cost-guard tier |
| **analyse** | `/opencode/<spaceId>/analyse/v1/chat/completions` | Request classification marked as analyse |

Bare-tail variant (when `baseURL` does not contain `/v1`):
- `/opencode/<spaceId>/cost-guard/chat/completions`
- `/opencode/<spaceId>/analyse/chat/completions`

### 4.1 Marker gating

Both marker routes are gated by the config `assetReflection.markerOptIn`:
- `markerOptIn: true` → matched and effective
- `markerOptIn: false` → returns `404 {"error":"cost_guard_marker_disabled"}` / similar

See `MemoryProxy/z_config/config.yaml` → `assetReflection.markerOptIn`.

### 4.2 How the client uses it

Switch directly in the `baseURL` of opencode.json:

```jsonc
// Default tier
"baseURL": "http://127.0.0.1:8096/opencode/default/v1"

// Force cost-guard
"baseURL": "http://127.0.0.1:8096/opencode/default/cost-guard/v1"

// analyse classification (for background-pipeline recognition)
"baseURL": "http://127.0.0.1:8096/opencode/default/analyse/v1"
```

---

## 5. Request classification

OpenCode's request classification is simple:

| Type | Description |
|------|------|
| **main** | All requests are main by default |
| **analyse** | Marked as analyse when the URL carries the `/analyse/` marker (for recognition by the report layer) |

OpenCode has **no** auxiliary-request concepts such as fork / sidequery / compact.

---

## 6. User text extraction

OpenCode's message body `message.content` is a **plain string** (not a content block array, and not
wrapped in XML):

- Does not use the `<user_query>` wrapper (unlike CB)
- Does not use a content block array (unlike CC)
- Directly takes the content string of the last user message

Image input is passed through via the `image_url` content-part (the client base64-encodes it and the proxy forwards it directly
to the upstream); the proxy does no special handling.

---

## 7. Injection Profile

OpenCode shares CB's handler path (both are OpenAI Chat Completions), and the injection method is the same:

```xml
<agent_skills>...</agent_skills>
<user_memory>...</user_memory>
<session_context>...</session_context>
```

Injection point: `messages[0].content` (appended inside the system message string).

---

## 8. Special behavior

- **Shared Handler**: OpenCode reuses CB's `handleChatCompletions` (the same path as dsh)
- **agentSource differentiation**: the `/opencode/` segment at the routing layer → `agentSource=opencode`
- **No separate header fingerprint**: the OpenCode CLI sends no custom headers; the proxy relies on the URL segment + user-agent to identify it
- **Marker routing**: two URL markers, `/cost-guard/` and `/analyse/`; see section 4

---

## 9. Archive trigger

- Shares the archive mechanism with CB / dsh
- Automatically runs `skill/conversation/add` when the conversation exceeds the threshold
- Supports `skill/conversation/force-archive`
- Archived data is written to L0

---

## 10. Environment variables

No OpenCode-specific variables. The upstream route is determined dynamically by `resolveForwardTarget`
(usually pointing to tokenhub or a direct provider).

---

## 11. FAQ

**Q: OpenCode shares the handler with CB / dsh; how are they distinguished?**  
A: At the routing layer by the `/:agent/` segment. After entering the handler, `agentSource=opencode` triggers
OpenCode-specific behavior (marker routing, self-generated session ID, etc.).

**Q: Must `baseURL` in opencode.json include `/v1`?**  
A: Recommended (the main path); the proxy also accepts the bare-tail variant (without `/v1`). Both are supported.

**Q: What if the marker route returns 404?**  
A: Check whether `assetReflection.markerOptIn` in `MemoryProxy/z_config/config.yaml` is
`true`. After changing it, run `./scripts/proxy.sh restart` to reload.

**Q: Does the OpenCode CLI itself support the `@image:path` syntax?**  
A: That is a capability on the OpenCode client side, unrelated to the proxy. After the client reads the file, converts it to base64, and puts it in an `image_url`
content-part, the proxy transparently passes it through to the upstream.

**Q: Can local history sessions / skills be imported into Memory Hub?**  
A: The OpenCode client does not write local skill / session files (unlike CB / dsh), so there is currently no
`asset-import.md`. To import historical conversations, import manually through the Panel or use the `mem:sync` command.

---

## 12. Differences from CB / dsh

| Dimension | CodeBuddy | dsh | **OpenCode** |
|---|---|---|---|
| Protocol | OpenAI Chat Completions | OpenAI Chat Completions | **OpenAI Chat Completions** |
| Config file | `~/.codebuddy/models.json` | `~/.dsh/settings.yaml` + `.credentials.yaml` | **`~/.config/opencode/opencode.json`** |
| URL prefix | `/codebuddy/<spaceId>` | `/dsh/<spaceId>` (no `/v1`) | **`/opencode/<spaceId>`** |
| Provider library | Built-in | Built-in | **`@ai-sdk/openai-compatible`** |
| Key passing | JSON `apiKey` | `.credentials.yaml` env var | **JSON `provider.*.options.apiKey`** |
| Form tool | `ask_followup_question` | `ask_user_question` | **`ask_followup_question`** (same as CB) |
| Session ID | client sends `x-conversation-id` | client sends `x-deepseek-harness-session-id` | **self-generated by proxy** |
| Marker routing | None | None | **`/cost-guard/` `/analyse/`** |
| Local asset import | Yes (`asset-import.md`) | Yes (`asset-import.md`) | **No** (the client does not write files) |

---

## 13. Current status

- ✅ Code implementation complete (handler reuses the CB path)
- ✅ Marker routes (cost-guard / analyse) unit tests 6/6 pass
- ✅ End-to-end curl verification passed (3 real upstream streaming responses)
- ✅ Panel now shows the OpenCode card
