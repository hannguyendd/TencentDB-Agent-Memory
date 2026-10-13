# MemoryKnowledge (Knowledge Service)

This directory is the **Knowledge Service (KS)** inside the monorepo: the user-facing Wiki + Code-Graph engine.  
The control plane lives in [`../MemoryPanel`](../MemoryPanel/).

Default port **8421**, API prefix **`/v3`**.

## What it does

| Capability | Description |
| --- | --- |
| **LLM-Wiki** | Upload/pull documents → LLM extracts structured pages → FTS5 full-text search + knowledge graph |
| **Code-Graph** | `git clone` a repo → CodeGraph index (symbols, calls, file tree) → exploratory queries |
| **Auto-Sync** (optional) | Periodically scans code-graphs; a FIFO queue + worker pool pulls git updates and rebuilds the index automatically. Off by default; see "Optional: Auto-Sync" below. |
| **Tools** | `POST /v3/tools/list`, `/v3/tools/call`, for Agent / Kernel self-discovery and invocation |
| **Status callback** | After ingest/sync completes, calls back the Panel (`TMC_CALLBACK_URL`), which then writes remote meta / knowledge |

`pnpm dev` alone can start the service; in the product pipeline, the Panel must push `llm_binding`, receive callbacks, and write remote metadata.

## Source layout

```text
MemoryKnowledge/
├── src/
│   ├── server.ts           # Hono entry: mounts routes, Swagger, starts listening
│   ├── module.ts           # Assembles store / wiki / code-graph / queue / recovery
│   ├── config.ts           # Environment variables
│   ├── callback.ts         # → Panel status-callback
│   ├── telemetry.ts        # Optional Langfuse (disabled if no KEY is set)
│   ├── routes/             # wiki / code-graph / tools / llm-binding / health
│   ├── engines/
│   │   ├── wiki/           # ingest-v2, indexing, graph search
│   │   └── code/           # CodeGraph bridge
│   ├── store/              # SQLite (Drizzle) + build queue + llm_binding
│   ├── source-fetcher/     # Git fetch
│   ├── mcp/                # MCP stdio (forwards to the local HTTP API)
│   ├── db/                 # schema / client
│   └── middleware/
├── docs/                   # Design and API details
├── Dockerfile              # Single KS image (optional)
└── docker-compose.yml      # One-command local KS container (optional)
```

## Local startup

For production/integration testing with the **combined Panel + KS image**, pull [`agentmemory/memory-hub`](https://hub.docker.com/r/agentmemory/memory-hub) directly (see [`../deploy/panel-knowledge-combined/README.md`](../deploy/panel-knowledge-combined/README.md)). Below is how to run just this service from source:

```bash
cd MemoryKnowledge
pnpm install --ignore-workspace
cp .env.example .env
# Edit .env (see below)
pnpm dev
```

```bash
curl -s http://127.0.0.1:8421/health
# Swagger: http://127.0.0.1:8421/docs
```

When integrating with the Panel (Panel defaults to `8123`), the KS `.env` needs at least:

```dotenv
PORT=8421
API_PREFIX=/v3
KNOWLEDGE_DATA_DIR=./data
KNOWLEDGE_DB_PATH=./data/knowledge.db
KNOWLEDGE_PUBLIC_BASE_URL=http://127.0.0.1:8421/v3   # Reachable by the Agent; must include /v3
TMC_CALLBACK_URL=http://127.0.0.1:8123               # Panel root URL; do not append the callback path
LLM_MODE=proxy
LLM_MODEL=Memory-Model
```

On the Panel side (the Panel's own `.env`, not KS):

```dotenv
KNOWLEDGE_SERVICE_URL=http://127.0.0.1:8421
```

| Variable | Read by | Includes `/v3`? |
| --- | --- | --- |
| `KNOWLEDGE_PUBLIC_BASE_URL` | KS → written to the resource `service_url` | Yes |
| Panel `KNOWLEDGE_SERVICE_URL` | Panel → calls the KS admin API | No |
| `TMC_CALLBACK_URL` | KS → calls back the Panel | No (root only) |

`LLM_MODE=proxy` (default): the Wiki uses the `llm_binding` pushed by the Panel per `x-tdai-service-id`; no need to run a Proxy locally.  
`LLM_MODE=custom`: set `LLM_API_KEY` / `LLM_BASE_URL` in `.env` (and optionally `LLM_PROTOCOL=anthropic`).

## Common commands

```bash
pnpm dev          # HTTP API (tsx hot reload)
pnpm dev:mcp      # MCP stdio (in a separate terminal; HTTP must already be running)
pnpm typecheck
pnpm test
pnpm build        # tsdown → dist/
```

## Optional: ClickHouse tool-call telemetry

Off by default. After setting the environment variables below, the Knowledge Service writes `POST /v3/tools/call` to a `tool_call_logs` table compatible with Memory/Skill; the table is created idempotently at startup, and neither batch-write nor table-creation failures block business requests.

```dotenv
KNOWLEDGE_CLICKHOUSE_ENABLED=true
KNOWLEDGE_CLICKHOUSE_URL=http://clickhouse.example.com:8123
KNOWLEDGE_CLICKHOUSE_DATABASE=default
KNOWLEDGE_CLICKHOUSE_TABLE=tool_call_logs
KNOWLEDGE_CLICKHOUSE_USER=knowledge_writer
KNOWLEDGE_CLICKHOUSE_PASSWORD=              # Injected from the environment only; never written into code
```

Optional tuning knobs are in `.env.example`. If the caller passes `x-conversation-id`, `x-tdai-user-id`, `x-tdai-team-id`, `x-tdai-agent-id`, `x-tdai-agent-source`, `x-tdai-space-id`, `x-tdai-turn-seq`, these dimensions are stored too; when missing, the corresponding columns are empty. Request bodies are recursively redacted and truncated to 512 bytes.

## Optional: Langfuse

Setting `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` (and optionally `LANGFUSE_BASE_URL`) reports Wiki LLM calls.  
When not configured, tracing is off and business logic is unaffected.

## Optional: Auto-Sync

Off by default. After setting `KNOWLEDGE_AUTO_SYNC_ENABLED=true`, the Knowledge Service periodically scans code-graphs and uses a FIFO queue + worker pool to pull git updates and rebuild indexes automatically.

```dotenv
KNOWLEDGE_AUTO_SYNC_ENABLED=true
KNOWLEDGE_AUTO_SYNC_SCAN_INTERVAL_MIN=10   # Scan interval (minutes), range 1-60
KNOWLEDGE_AUTO_SYNC_MAX_CONCURRENT=3       # Max concurrent sync workers, range 1-20
```

The first scan runs 30 seconds after startup; while disabled, calling `POST /v3/auto-sync/trigger` is a no-op (returns `triggered: false`).
