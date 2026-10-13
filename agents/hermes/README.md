# Hermes

> agentSource: `hermes` | Protocol: OpenAI Chat Completions | Session Init: header preselection (no interactive Form)
>
> To import local history into Memory Hub, see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

Hermes is configured through the **config file** `~/.hermes/config.yaml`:

```yaml
model:
  default: gpt-5.5
  provider: custom
  base_url: http://<proxy-host>:8096/hermes/<spaceId>
  api_key: <the business user's sk-mem-... user_key>
  default_headers:
    x-team-id: <team_id obtained from the panel>
    x-agent-id: <agent_id obtained from the panel>
    x-task-id: <task_id obtained from the panel>
    x-conversation-id: <custom conversation identifier>
```

Field notes:
- `base_url` — Proxy address + `/hermes/<spaceId>`; `default` is the memory instance ID
- `api_key` — the business user's `user_key` (obtained from the panel)
- `x-team-id` / `x-agent-id` / `x-task-id` — obtained from the corresponding panel pages
- `x-conversation-id` — a user-defined conversation identifier (see the known limitations in §6 below)

Request path: `POST /hermes/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|--------|--------|
| Only | `x-conversation-id` (statically set by the user in the config file) |

⚠️ Hermes does not manage session IDs automatically; the user must change `x-conversation-id` manually for each new conversation.

---

## 3. Session Init (session initialization)

### ⚠️ Key difference: header preselection only, no interactive Form

Hermes **does not support interactive forms** (the client cannot respond to the function_call returned by the proxy).  
Session registration relies entirely on the headers carried in the request:

| Header | Description | Required |
|--------|-------------|----------|
| `x-team-id` | Team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅ (current version) |
| `x-conversation-id` | Conversation identifier | ✅ |

**Handling logic**:
- All four headers present and valid → register the session directly and inject assets
- Any one missing → session bypass (passthrough, no injection)

### No Plan Mode / Default Mode

Hermes has no Plan/Default mode concept. Either the headers are complete and the full pipeline runs, or it bypasses.

---

## 4. Request Classification

All requests are **main**. Hermes has no auxiliary request concept.

---

## 5. Injection Profile

Same as CB: an XML structure injected into `messages[0].content` (the system message).

---

## 6. Known Limitations

### `x-task-id` is currently required

The proxy's header preselection mechanism needs all three IDs to complete session registration. Without `x-task-id` the proxy tries to show a form, but Hermes cannot respond → session bypass → memory injection does not take effect.

**Impact**:
- The user must create a Task in the panel beforehand and obtain its task_id
- Switching tasks requires editing the config file by hand

### `x-conversation-id` must be managed manually

- All requests with the same conversation ID share one session
- It must be changed manually for each new conversation (otherwise the previous session state is reused)
- In some clients, requests following a tool call may not carry the extra headers → injection is skipped for those turns

---

## 7. FAQ

**Q: Memory injection is not working?**  
A: Check that all four `extra_headers` values are filled in and correct. Any missing or wrong value causes a session bypass.

**Q: How do I get team_id / agent_id / task_id?**  
A: Log in to the panel → open the relevant page → the details show the ID field. Or query with the panel APIs `team/list`, `agent/list`, `task/list`.

**Q: What if I don't want to bind a Task?**  
A: Currently required. You can set `sessionInit.defaultTaskId: "no-task"` in the proxy `config.yaml` and use that fixed value.
