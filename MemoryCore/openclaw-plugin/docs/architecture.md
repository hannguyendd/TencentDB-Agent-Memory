# TencentDB Agent Memory Client -- OpenClaw Memory Plugin (Client Integration Edition)

> Created: 2026-05-17 | Status: In development
> Plugin ID: `memory-tencentdb-client`
> Display name: Memory TencentDB (Client)

## 1. Background

After the service-oriented refactoring, all four layers of memory data (L0 conversations / L1 atomic / L2 scenes / L3 persona) are hosted on the remote Gateway:
- **Data storage**: TCVDB (vectors) + COS (files) + Redis (state)
- **Pipeline**: the Gateway Worker automatically completes L1->L2->L3 extraction
- **API**: 15 v2 REST endpoints cover all CRUD + Search

**The original plugin (memory-tencentdb)** is a "full-stack" architecture: local SQLite/VDB + local Pipeline + local Embedding + OpenClaw Hooks + CLI, ~15,000 lines.

**The new plugin (memory-tencentdb-client)** is a pure client: it only registers OpenClaw hooks + tools, and delegates all data operations to the remote Gateway through `@tencentdb-agent-memory/memory-sdk-ts-v2`.

## 2. Three-Layer Architecture

```
┌───────────────────────────────────────────────────────┐
│  OpenClaw Plugin (memory-tencentdb-client)            │  Framework adaptation layer
│  hooks (recall/capture) + tools + prompt injection     │  Depends only on the SDK, never touches HTTP/storage
│  └─ import { MemoryClient, MemoryFileReader } from SDK│
├───────────────────────────────────────────────────────┤
│  @tencentdb-agent-memory/memory-sdk-ts-v2 (standalone package)                 │  Generic SDK layer
│  MemoryClient (14 APIs) + MemoryFileReader (STS direct read)   │  Zero framework dependencies, pure fetch
│  Dify / AutoGen / LangChain can use this in the future │
├───────────────────────────────────────────────────────┤
│  Gateway v2 API                                        │  Remote service
│  VDB + COS + Redis + Pipeline Worker                   │
└───────────────────────────────────────────────────────┘
```

## 3. Plugin Responsibilities (framework adaptation layer only)

| Feature | Hook/Tool | Implementation |
|------|-----------|------|
| **Conversation capture** | `agent_end` hook | SDK `client.addConversation()` |
| **Memory recall** | `before_prompt_build` hook | In parallel: `client.searchAtomic()` + `client.readCore()` + `client.listScenarios()` |
| **Tag cleanup** | `before_message_write` hook | Strip `<relevant-memories>` tags |
| **L1 search** | `tdai_memory_search` tool | SDK `client.searchAtomic()` |
| **L0 search** | `tdai_conversation_search` tool | SDK `client.searchConversation()` |
| **File reading** | `tdai_read_file` tool | SDK `MemoryFileReader.read()` (STS direct read of object storage) |
| **Prompt injection** | inside recall | Formatting: Persona + L1 memories + Scene Navigation + tool guide |

### What it does not do

- ❌ Does not start VectorStore / SQLite / TCVDB
- ❌ Does not start EmbeddingService
- ❌ Does not start Pipeline / Timer / Worker
- ❌ Does not do L1/L2/L3 extraction
- ❌ Does not manage the COS storage backend
- ❌ Does not manage Redis state
- ❌ Does not do local Checkpoint

## 4. Configuration

```jsonc
{
  // Gateway connection
  "gateway.url": "http://127.0.0.1:8420",
  "gateway.apiKey": "",
  "gateway.instanceId": "default",

  // Recall
  "recall.maxResults": 5,
  "recall.includePersona": true,
  "recall.includeSceneNav": true,

  // Capture
  "capture.enabled": true
}
```

## 5. File Structure

```
memory-tencentdb-client/
├── openclaw.plugin.json       # Plugin manifest
├── package.json               # deps: { "@tencentdb-agent-memory/memory-sdk-ts-v2": "1.0.0-beta.2" }
├── index.ts                   # Entry: initialize SDK + register hooks/tools
├── src/
│   ├── hooks/
│   │   ├── recall.ts          # before_prompt_build → SDK recall → prompt injection
│   │   └── capture.ts         # agent_end → SDK addConversation
│   ├── tools/
│   │   ├── memory-search.ts   # tdai_memory_search → SDK searchAtomic
│   │   ├── conversation-search.ts  # → SDK searchConversation
│   │   └── read-cos.ts        # tdai_read_file → SDK MemoryFileReader.read
│   └── format.ts              # Recall result formatting + tool guide injection
├── tests/
│   └── sdk-cos.ts             # Manual test for SDK COS direct read
├── .gitignore
└── README.md
```

## 6. SDK Dependency Strategy

```jsonc
"dependencies": {
  "@tencentdb-agent-memory/memory-sdk-ts-v2": "1.0.0-beta.2"
}
```

The SDK has been published to the npm registry: [`@tencentdb-agent-memory/memory-sdk-ts-v2@1.0.0-beta.2`](https://www.npmjs.com/package/@tencentdb-agent-memory/memory-sdk-ts-v2/v/1.0.0-beta.2), pulled automatically by `npm install`; vendor / local `file:` / tgz are no longer used.
The SDK stays a standalone package, not bound to any framework, and will be reused for a future Dify plugin, a Python version, etc.

## 7. read_cos Tool Design

### COS Direct Read (STS)

- The SDK's `MemoryFileReader` obtains temporary STS credentials through the Gateway `/v2/cos/secret`
- Credentials are cached automatically and refreshed 2 minutes before expiry
- GETs the COS object directly (COS V5 signature), without proxying through the Gateway

### How the AI knows it can call read_cos

1. **Scene Navigation at the end of the Persona**:
   ```
   ## 🗺️ Scene Navigation
   ### Path: scene_blocks/career_development_and_tech_practice.md
   **Heat**: 3 | Summary: Backend engineer, Go + TypeScript...
   ```
   After seeing the path, the AI proactively calls `tdai_read_file` to read the details.

2. **Tool guide (injected by format.ts)**:
   ```
   <memory-tools-guide>
   - tdai_memory_search: search structured memory
   - tdai_conversation_search: search raw conversations
   - tdai_read_file: read scene files (use paths from Scene Navigation)
   </memory-tools-guide>
   ```

3. **Tool description**:
   ```
   "Read a file from cloud storage. Use paths from Scene Navigation
    (e.g. 'scene_blocks/xxx.md') or 'persona.md'."
   ```

## 8. Key Design Decisions

### Q1: How is session_id determined?

Use the `ctx.sessionKey` passed in by the OpenClaw framework directly (carried by the hook context), consistent with the original plugin's behavior. There is no need to generate or assemble it yourself.

### Q2: Offline / disconnection degradation?

Not done in the first version -- when the Gateway is unreachable the hook returns empty (no memory injected), and a capture failure logs a warn. A local fallback can be added later.

### Q3: Does it conflict with the original plugin?

The plugin IDs differ (`memory-tencentdb-client` vs `memory-tencentdb`), so they do not conflict. But enabling both would capture/inject twice, so enabling only one is recommended.

## 9. Implementation Steps

| # | Task | Estimate |
|---|------|------|
| 1 | `package.json` + `openclaw.plugin.json` + `.gitignore` + `README.md` | 15 min |
| 2 | `index.ts` -- initialize SDK Client/MemoryFileReader + register hooks/tools | 30 min |
| 3 | `hooks/capture.ts` -- agent_end -> addConversation | 20 min |
| 4 | `hooks/recall.ts` + `format.ts` -- parallel recall + prompt formatting | 45 min |
| 5 | `tools/*.ts` -- 3 tool forwarders | 30 min |
| 6 | SDK test script (`tests/sdk-cos.ts`) | 15 min |
| 7 | Local integration testing | 30 min |

**Total**: ~3 hours
