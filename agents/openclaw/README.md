# OpenClaw

> agentSource: `openclaw` | Protocol: OpenAI Chat Completions | Session Init: header preselection (no interactive Form)
>
> To import local history into Memory Hub, see the [Asset Import Guide](./asset-import.md).

---

## 1. Client Configuration

OpenClaw is configured in the `models.providers` section of the **config file** `~/.openclaw/openclaw.json`:

```jsonc
{
  "models": {
    "mode": "merge",
    "providers": {
      "memory-proxy": {
        "baseUrl": "http://<proxy-host>:8096/openclaw/<spaceId>",
        "apiKey": "<the business user's sk-mem-... user_key>",
        "api": "openai-completions",
        "headers": {
          "x-team-id": "<team_id obtained from the panel>",
          "x-agent-id": "<agent_id obtained from the panel>",
          "x-task-id": "<task_id obtained from the panel>",
          "x-conversation-id": "<custom conversation identifier>"
        },
        "request": {
          "allowPrivateNetwork": true
        },
        "models": [
          {
            "id": "gpt-5.5",
            "name": "GPT-5.5",
            "reasoning": false,
            "input": ["text"],
            "contextWindow": 128000,
            "maxTokens": 32000,
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
          }
        ]
      }
    }
  }
}
```

Field notes:
- `baseUrl` — Proxy address + `/openclaw/<spaceId>`; `default` is the memory instance ID
- `apiKey` — the business user's `user_key` (obtained from the panel)
- `api` — must be `"openai-completions"`
- `headers` — must include `x-team-id`, `x-agent-id`, `x-task-id`, `x-conversation-id`
- `models[].id` — must match a model ID configured in the Proxy upstream
- `allowPrivateNetwork: true` — allows access to private-network addresses

Request path: `POST /openclaw/:spaceId/v1/chat/completions`

---

## 2. Session ID

| Source | Header |
|--------|--------|
| Only | `x-conversation-id` (statically set by the user in the config file) |

Like Hermes, OpenClaw does not manage session IDs automatically; change them manually.

---

## 3. Session Init (session initialization)

### ⚠️ Key difference: header preselection only, no interactive Form

OpenClaw is identical to Hermes: it **does not support interactive forms**, and Session registration relies on headers:

| Header | Description | Required |
|--------|-------------|----------|
| `x-team-id` | Team ID | ✅ |
| `x-agent-id` | Agent ID | ✅ |
| `x-task-id` | Task ID | ✅ (current version) |
| `x-conversation-id` | Conversation identifier | ✅ |

**Handling logic**:
- All four headers present and valid → register the session directly and inject assets
- Any one missing → session bypass (passthrough, no injection)

---

## 4. Request Classification

All requests are **main**. OpenClaw has no auxiliary request concept.

---

## 5. Injection Profile

Same as CB: an XML structure injected into `messages[0].content` (the system message).

---

## 6. Known Limitations

Identical to Hermes:

### `x-task-id` is currently required

When missing, the session bypasses and memory injection does not take effect.  
Workaround: set `sessionInit.defaultTaskId: "no-task"` in the proxy and use that fixed value.

### `x-conversation-id` must be managed manually

- The same ID shares one session; change the value manually for a new conversation
- In some turns following a tool call, headers may not be carried → injection is skipped for those turns

---

## 7. FAQ

**Q: How does it differ from Hermes?**  
A: From the proxy's point of view the behavior is identical (header preselection + OpenAI Chat). The only differences are the client config file format (YAML vs JSON) and the agentSource marker.

**Q: Is it OK to set cost to 0 in models?**  
A: Yes. OpenClaw uses cost for client-side budget calculation; when going through the proxy, actual billing happens upstream, so 0 on the client side does not affect functionality.

**Q: What is `allowPrivateNetwork: true`?**  
A: OpenClaw blocks requests to private-network addresses by default (a security policy). This setting is required to reach a proxy on `127.0.0.1` or an internal IP.
