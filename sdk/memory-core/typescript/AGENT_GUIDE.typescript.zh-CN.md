# Agent Integration Guide (TypeScript)

This guide explains how to wire `@tencentdb-agent-memory/memory-sdk-ts` into an AI Agent. New integrations should use the v3 strict-isolation client (`@tencentdb-agent-memory/memory-sdk-ts/v3`); the v2 compatibility client is still exported from the package root. For a quick SDK API reference see [`README.md`](./README.md); this guide covers **how to assemble them into a long-term memory system**.

---

## Four things to do when integrating

```
User input  →  ① Recall (inject into prompt) → LLM → ② Capture (write L0)
                            ↑
                  ③ Tools: let the LLM search again on its own
                            ↑
                  ④ Error degradation: failures must not break the main flow
```

---

## 0. Initialization

```typescript
import { MemoryClient } from "@tencentdb-agent-memory/memory-sdk-ts/v3";

const client = new MemoryClient({
  endpoint: "https://your-memory-gateway",
  apiKey: process.env.MEMORY_API_KEY!,
  serviceId: "your-instance-id",
  teamId: "team-xxx",
  agentId: "agt-xxx",
  userId: "usr-xxx",
  sessionId: "session-xxx", // optional; when omitted, L0/L1 can aggregate across sessions
});
```

Note: **you must pass a config object**, not a bare transport (`new MemoryClient(transport, isolation)` is only for unit-test mocks).

`serviceId` determines memory instance isolation; `teamId/agentId/userId/sessionId` determine v3 data-plane isolation. To recall at the agent level across sessions, use `client.withIsolation({ sessionId: null })`.

---

## 1. Recall

Before sending the user message to the LLM, fetch three kinds of memory in parallel and assemble them into the system prompt.

```typescript
async function recall(client: MemoryClient, userQuery: string) {
  const [l1, persona, scenes] = await Promise.allSettled([
    client.searchAtomic({ query: userQuery, limit: 5 }),
    client.readCore(),                              // L3 user persona
    client.listScenarios({}),                       // L2 scene index
  ]);

  const l1Items = l1.status === "fulfilled" ? l1.value.items : [];
  const personaText = persona.status === "fulfilled" ? persona.value.content : null;
  const sceneList = scenes.status === "fulfilled" ? scenes.value.entries : [];

  return formatPrompt(l1Items, personaText, sceneList);
}
```

`Promise.allSettled` is the key: if any one path times out or fails, the other two results are still used and the main conversation is unaffected.

### Two blocks for assembling the prompt

- **prependContext (dynamic)**: L1 recall results, which change every turn; placed before the user message.
- **appendSystemContext (stable)**: Persona + Scene index + tool usage guide; placed at the end of the system prompt to hit the KV cache. _(TBD: placing it at the end of the system prompt can still cause KV cache misses; needs further discussion.)_

```typescript
function formatPrompt(l1, persona, scenes) {
  const prepend = l1.length > 0
    ? `<relevant-memories>\n${l1.map(m => `- [${m.type}] ${m.content}`).join("\n")}\n</relevant-memories>`
    : undefined;

  const parts: string[] = [];
  if (persona) parts.push(`<user-persona>\n${persona}\n</user-persona>`);
  if (scenes.length > 0) {
    parts.push("## Scene Navigation\n*The following scenes can be read in detail with tdai_read_file*");
    parts.push(scenes.map(s => `- \`${s.path}\``).join("\n"));
  }
  parts.push(MEMORY_TOOLS_GUIDE);  // See below

  return { prepend, append: parts.join("\n\n") };
}
```

> Implementation note: in the `before_prompt_build` hook, **cache the original user text** (the clean version, without injected recall); the capture phase needs it later -- see Section 2.

---

## 2. Capture

After an agent turn finishes (the `agent_end` hook), clean the new user/assistant messages from that turn and write them back to L0.

```typescript
async function capture(client: MemoryClient, ctx: {
  sessionKey: string;
  rawMessages: any[];                  // Full message history provided by the framework
  originalUserText: string;            // Clean user text cached during recall
  originalUserMessageCount: number;    // Message count cached during recall
}) {
  // ① Positional slice: keep only the messages added in this turn
  const newMessages = ctx.rawMessages.slice(ctx.originalUserMessageCount);

  // ② Extract user/assistant, dropping tool calls / system / multimodal noise
  const extracted = extractUserAssistant(newMessages);

  // ③ Swap the recall-polluted user message back to the original
  for (const m of extracted) {
    if (m.role === "user" && m.timestamp === newMessages[0]?.timestamp) {
      m.content = ctx.originalUserText;
      break;
    }
  }

  // ④ Text cleanup: strip image base64, strip code blocks, filter too-short / symbol-only content
  const cleaned = extracted
    .map(m => ({ ...m, content: sanitize(m.content) }))
    .filter(m => m.content.trim().length > 5);

  if (cleaned.length === 0) return;

  // ⑤ Submit
  await client.addConversation({
    session_id: ctx.sessionKey,
    messages: cleaned.map(m => ({
      role: m.role,
      content: m.content,
      timestamp: new Date(m.timestamp).toISOString(),
    })),
  });
}
```

### Why replace the "polluted user message"

During recall, a `<relevant-memories>...</relevant-memories>` block is prepended to the user message. If it is written to L0 without restoring the original text, the next recall will search/embed based on this polluted text, forming a **feedback loop** that makes memory increasingly messy.

### Why use a positional slice

`agent_end` hands you the **full history**, not just this turn's additions. Sending it all would write historical messages again. Record the message count N at `before_prompt_build`; at `agent_end`, `messages.slice(N)` is what this turn added.

---

## 3. Exposing tools

Memory injected via the prompt alone is limited. Register three more tools so the LLM can search on its own:

| Tool | When to use | Implementation |
|---|---|---|
| `tdai_memory_search` | Find structured preferences/facts | `client.searchAtomic({ query, limit })` |
| `tdai_conversation_search` | Find raw conversation snippets | `client.searchConversation({ query, limit })` |
| `tdai_read_file` | Read full scene text / core memory | In v3 use `client.readScenario({ path })` / `client.readCore()`; reading raw COS artifacts still uses v2 `client.readFile(path)` |

State clearly in the system prompt when to call them, and add a call limit:

```
## Memory tools
- tdai_memory_search: search structured memory (user preferences, rules, historical events)
- tdai_conversation_search: search raw conversation text
- tdai_read_file: read a scene file (use the paths listed in Scene Navigation)

⚠️ memory_search + conversation_search may be called at most 3 times in total per turn.
```

Without a limit, the LLM will search aimlessly over and over.

---

## 4. Error degradation

A memory service outage **must not break the main conversation**. Three principles:

1. **Recall** uses `Promise.allSettled`, so one failing path does not affect the others.
2. **Capture** is wrapped in try/catch; on failure just log:
   ```typescript
   try { await capture(...); }
   catch (e) { logger.warn(`capture failed: ${e.message}`); }
   ```
3. **Tools** return an error message string instead of throwing, so the LLM sees "memory unavailable" and keeps chatting.

---

## 5. Error handling

A non-zero code throws `TDAMError`:

```typescript
import { TDAMError } from "@tencentdb-agent-memory/memory-sdk-ts";

try {
  await client.readFile("scene_blocks/x.md");
} catch (e) {
  if (e instanceof TDAMError) {
    if (e.code === 404) {
      // File does not exist; normal case
    } else {
      logger.warn(`memory error code=${e.code} request_id=${e.requestId}`);
    }
  }
}
```

`requestId` is also logged on the server side; just give it to the backend when troubleshooting.

---

## 6. Performance tips

- **Total recall budget < 200ms**: run the three paths in parallel, use the fastest available results, and drop any that time out.
- **Keep injected prompt size small**: L1 <= 5 items, list only the path (not the content) in the Scene list, and one Persona is enough. Let the LLM pull details with tools when it needs more.
- **Session granularity**: `sessionKey` is the partition key of L0 conversations; for long-running conversations use a stable id (user id + conversation id) and do not change it every turn.

---

## 7. Management plane: Knowledge / metadata

Everything above is about `MemoryClient` (data plane: reading and writing memory). If you also need to **manage** the metadata of Knowledge sources (wiki / code-graph), or manage user/team/agent/task/asset, use `MetadataClient`:

```typescript
import { MetadataClient } from "@tencentdb-agent-memory/memory-sdk-ts";

const meta = new MetadataClient({
  endpoint: "http://127.0.0.1:8420",
  apiKey: process.env.MEMORY_API_KEY,
  serviceId: "your-instance-id",
});

// Register / list / rename / delete Knowledge entities (management-plane CRUD, see README.md)
await meta.createKnowledge({ knowledge_id: "wiki-1", type: "wiki", service_url: "http://ks:8421/v3", name: "Wiki", team_id: "team-1" });
await meta.listKnowledge({ team_id: "team-1", type: "wiki" });
```

Note: `MetadataClient` only handles metadata CRUD; actually searching wiki content, reading pages, or syncing repositories requires calling the Knowledge Service data plane (`:8421`, pointed to by `service_url`). That is a separate set of endpoints and is outside the scope of this SDK.
