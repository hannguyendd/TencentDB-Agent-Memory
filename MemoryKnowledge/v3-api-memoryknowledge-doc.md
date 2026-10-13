# v3 API Reference · Volume 2: MemoryKnowledge

> Service: MemoryKnowledge (Knowledge Service, KS), port `8421`
> This volume covers all `/v3/*` endpoints exposed by MemoryKnowledge. See Volume 1 for MemoryCore and Volume 3 for MemoryProxy.
> Maintenance rule: any endpoint change must update this document in the same PR.

---

## 1. Common conventions

### 1.1 Service and port

| Item | Value |
|---|---|
| Service | MemoryKnowledge (Knowledge Service, KS) |
| Port | 8421 (`PORT`, default `8421`) |
| API prefix | `/v3` (`API_PREFIX`, default `/v3`) |
| Method | Except `GET /v3/auto-sync/status` and `GET /health`, **all others are `POST`** |
| Content-Type | `application/json` |
| Health check | `GET /health` (**not v3**; returns bare JSON `{ status, timestamp }`) |
| Swagger | `GET /docs` (UI), `GET /openapi.json` (spec, not v3) |

### 1.2 Response envelope

**Note: unlike MemoryCore, the KS envelope has no `request_id` field.**

```json
{ "code": 0, "message": "ok", "data": { } }
```

| Field | Type | Description |
|---|---|---|
| code | number | `0` on success; non-zero on failure, and the **HTTP status code = code** (`wrapError(code, ...)` followed by `c.json(..., code)`) |
| message | string | Always `"ok"` on success; on failure, a **lowercase English sentence** (not an enum, see §1.5) |
| data | any | Business data; `null` on failure |

> In the `wrapOk` implementation `request_id` is optional, but **no route passes it**, so actual responses are always the three fields `{ code, message, data }`.

> ⚠️ **isError special case (code-graph query tools / tools/call)**: when tool execution fails (`result.isError === true`), the HTTP status code is **500**, but the body is still the **success envelope** of `wrapOk(result)`: `{ code: 0, message: "ok", data: { text, isError: true } }`. That is, **`code=0` but HTTP=500**, which violates the usual "HTTP status code = code" convention in the table above. The only reliable signal for the frontend to detect a tool failure is **`data.isError === true`** (the error text is in `data.text`); do not rely on the HTTP status or `code` alone.

### 1.3 Authentication

KS uses an **intranet trust model**, unlike MemoryCore's user-key scheme:

| Item | Description |
|---|---|
| Only required header | `x-tdai-service-id` (tenant/service identifier, i.e. the kernel routing key) |
| Other auth | Optional Bearer: when `KNOWLEDGE_SERVICE_KEY` is non-empty, endpoints other than the read-only allowlist require `Authorization: Bearer <key>` (including all of `internal/llm-binding/*`); when empty it is not enforced (backward compatible, intranet trust) |
| Exception | `POST /v3/internal/llm-binding/list` does not require the `x-tdai-service-id` header (returns all bindings, for the Panel startup cache; still requires Bearer when a key is enabled) |

> `service_id` / `team_id` / resource IDs all go through **path-segment allowlist validation** (`^[A-Za-z0-9_-]+$`, length <= 200) to prevent path traversal.

### 1.4 IDs and multi-tenancy

| Item | Value |
|---|---|
| Wiki ID | `wiki-` + 8 chars of `[0-9a-z]` (e.g. `wiki-a1b2c3d4`) |
| Code-Graph ID | `cg-` + 8 chars of `[0-9a-z]` (e.g. `cg-e5f6g7h8`) |
| Multi-tenancy | All endpoints are scoped by `service_id`; **id-only endpoints use `getById(service_id, id)`, and cross-tenant resources uniformly return 404 (existence is not revealed)** |

### 1.5 Error message format

On failure, `message` is a **lowercase English sentence** (not an enum, not the `CODE: detail` format). The frontend should branch on the HTTP `code` and not parse the message. Common examples:

| code | Example message | Scenario |
|---|---|---|
| 400 | `x-tdai-service-id header is required` / `wiki_id is required` / `query is required` | Missing parameter |
| 400 | `invalid path: traversal detected` / `forbidden path (structural file or outside wiki/)` | Illegal path |
| 404 | `wiki not found` / `code graph not found` | Resource does not exist (including cross-tenant) |
| 409 | `wiki is processing; cannot write/delete` | State conflict |
| 409 | `busy` | Concurrency rejection (ingest/sync) |
| 413 | `content exceeds size limit` / `too many files (max 10)` | Limit exceeded |
| 503 | `code graph instance not loaded` | Dependency not ready |

### 1.6 Resource status enums

| Resource | Status values | Description |
|---|---|---|
| Wiki | `draft` → `pending` → `processing` → `ready` / `failed` | `draft` is the initial shell state created by create |
| Code-Graph | `pending` / `processing` / `ready` / `failed` | No `draft` |

> General rule: in states before `ready`, query endpoints (graph/search/query tools) return an **empty result rather than an error** (see §3.1/§3.2).

---

## 2. Endpoint catalog

| Module | Endpoints | Prefix |
|---|---|---|
| Wiki | 16 | `/v3/wiki/*` |
| Code-Graph | 14 | `/v3/code-graph/*` |
| Tools (Agent self-discovery) | 2 | `/v3/tools/*` |
| Internal LLM-Binding | 3 | `/v3/internal/llm-binding/*` |
| Auto-Sync | 2 | `/v3/auto-sync/*` |

**Total: 37 endpoints.**

---

## 3. Endpoint details

## 3.1 Wiki (16)

> The comment says "15 endpoints", but the actual code has 16 (one extra: `update-meta`).
> Two categories: **id-only** (only `x-tdai-service-id` + `wiki_id`, cross-tenant 404) and **with-team** (requires `team_id`).

**WikiDetail response shape**:

| Field | Type | Description |
|---|---|---|
| wiki_id | string | Resource ID |
| team_id | string | Team ID |
| name | string | Name |
| service_url | string\|null | Base URL for tools self-discovery |
| summary | string\|null | Summary |
| status | string | Status (see §1.6) |
| internal_status | string\|null | Internal fine-grained status |
| sync_error | string\|null | Sync error |
| version | string | Version (string) |
| owner_user_id | string\|null | owner |
| page_count | number\|null | Page count |
| last_sync_at | string\|null | Last sync time |
| created_at / updated_at | string | Timestamps |

### POST /v3/wiki/create

Create a Wiki shell (`draft` state). **Idempotent**: same name in the same team returns the existing record (HTTP 200); a new one returns 201.

**Request body** (with-team)

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| name | string | Yes | Name |
| user_id / agent_id / task_id | string | No | Ownership (owner_user_id = user_id) |

**Response** `data`: `WikiDetail`.

**Errors**: `400` (missing team_id or name).

**Example**

```json
// Request
POST /v3/wiki/create
{ "team_id": "t_1", "name": "Team wiki" }

// Response (201)
{
  "code": 0,
  "message": "ok",
  "data": {
    "wiki_id": "wiki-a1b2c3d4",
    "team_id": "t_1",
    "name": "Team wiki",
    "status": "draft",
    "version": "0",
    "owner_user_id": "u_1",
    "created_at": "2026-08-20T00:00:00Z",
    "updated_at": "2026-08-20T00:00:00Z"
  }
}
```

### POST /v3/wiki/list

Paginated list by team.

**Request body**: `team_id` (required), `status?`, `limit?` (default 20), `offset?` (default 0).

**Response** `data`: `{ items: WikiDetail[], total }`.

### POST /v3/wiki/get

Single lookup (id-only).

**Request body**: `wiki_id` (required).

**Response** `data`: `WikiDetail`.

**Errors**: `404` (wiki not found).

### POST /v3/wiki/update-meta

Update name / summary.

**Request body**: `wiki_id` (required), `name?`, `summary?` (at least one).

**Response** `data`: `WikiDetail`.

**Errors**: `400` (neither provided), `404`.

### POST /v3/wiki/delete

Batch delete (cascades to connections/metadata/disk and unregisters the engine).

**Request body**: `wiki_ids` (1–100, non-empty array).

**Response** `data`: `BatchDeleteResult` = `{ deleted_ids: string[], failed: [{ id, reason }] }`.

> A single failure does not fail the whole call; it is recorded in `failed` (reason: `invalid id` / `not found` / `delete failed`).

### POST /v3/wiki/ingest

Trigger Wiki extraction. **Empty wikis (no source files) are rejected**.

**Request body**: `wiki_id` (required), `user_id?`.

**Response** `data`: `{ wiki_id, status }` (HTTP `202`).

**Errors**: `400` (empty wiki), `404` (not found), `409` (busy; data carries `{ status, step }`).

### POST /v3/wiki/raw/ls

List raw source files (id-only).

**Request body**: `wiki_id`.

**Response** `data`: `{ items: RawFile[] }`.

### POST /v3/wiki/raw/read

Batch-read raw files (id-only).

**Request body**: `wiki_id`, `filenames: string[]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400` (parameters), `404` (wiki does not exist / file missing), `413` (too large).

### POST /v3/wiki/raw/write

Upload source files (with-team). **Raw must be written before ingest is triggered**.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| wiki_id | string | Yes | Wiki ID |
| files | object[] | Yes | `[{ filename, content }]`, <= 10 files, <= 512KB per file, <= 5MB total |
| user_id / agent_id / task_id | string | No | Ownership |

**Response** `data`: `{ items }`.

**Errors**: `400` (invalid structure), `404`, `409` (processing), `413` (limit exceeded).

**Example**

```json
// Request
POST /v3/wiki/raw/write
{ "team_id": "t_1", "wiki_id": "wiki-a1b2c3d4", "files": [ { "filename": "README.md", "content": "# Home" } ] }

// Response
{ "code": 0, "message": "ok", "data": { "items": [ { "filename": "README.md", "status": "written" } ] } }
```

### POST /v3/wiki/raw/rm

Delete raw files (with-team).

**Request body**: `team_id`, `wiki_id`, `filenames: string[]`.

**Response** `data`: deletion result.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/page/ls

List extracted pages (id-only).

**Request body**: `wiki_id`.

**Response** `data`: `{ items: Page[] }` (`Page = { ref, title, path }`).

### POST /v3/wiki/page/read

Batch-read pages (id-only).

**Request body**: `wiki_id`, `refs: string[]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400`, `404`.

### POST /v3/wiki/page/write

Write pages (with-team).

**Request body**: `team_id`, `wiki_id`, `pages: [{ ref, content }]` (non-empty).

**Response** `data`: `{ items }`.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/page/rm

Delete pages (with-team).

**Request body**: `team_id`, `wiki_id`, `refs: string[]`.

**Response** `data`: deletion result.

**Errors**: `400`, `404`, `409` (processing).

### POST /v3/wiki/graph

Knowledge graph (id-only). **Returns an empty graph (not an error) when not `ready`**.

**Request body**: `wiki_id`.

**Response** `data`: `{ nodes: [], edges: [], communities: [] }` (empty when not ready; when ready, returns the `wikiMgr.graph` result).

### POST /v3/wiki/search

Full-text search (BM25, id-only). **Returns an empty result (not an error) when not `ready`**.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| wiki_id | string | Yes | Wiki ID |
| query | string | Yes | Search query |
| limit | number | No | Default 20 |
| hop | number | No | Graph expansion hops, integer 0–5 |
| decay | number | No | Decay factor 0–1 |
| minScore | number | No | Minimum relevance (non-negative) |

**Response** `data`: `{ results, links, count }`.

**Errors**: `400` (query missing / hop/decay/minScore out of range), `404`.

**Example**

```json
// Request
POST /v3/wiki/search
{ "wiki_id": "wiki-a1b2c3d4", "query": "release", "limit": 10 }

// Response
{ "code": 0, "message": "ok", "data": { "results": [ { "ref": "page/release-plan", "title": "Release plan" } ], "links": [], "count": 1 } }
```

---

## 3.2 Code-Graph (14)

> The comment says "13 endpoints", but the actual count is 14 (one extra: `update-meta`).
> Two categories: **Management** (6: create/list/get/update-meta/sync/delete) and **Query** (8: search/explore/callers/callees/impact/node/status/files).
> Query endpoints delegate to `engines/code executeTool` and return a `{ text, isError }` text block.

**CodeGraphDetail response shape**:

| Field | Type | Description |
|---|---|---|
| code_graph_id | string | Resource ID |
| team_id | string | Team ID |
| repo_name | string | Repository name |
| repo_url | string | Repository URL |
| branch | string | Branch (default main) |
| commit_hash | string\|null | commit |
| service_url | string\|null | Base URL for tools self-discovery |
| summary | string\|null | Summary |
| status | string | Status (see §1.6) |
| sync_error | string\|null | Sync error |
| version | string | Version |
| owner_user_id | string\|null | owner |
| stats | `{ files, nodes, edges }`\|null | Statistics |
| last_sync_at | string\|null | Last sync time |
| created_at / updated_at | string | Timestamps |

### POST /v3/code-graph/create

Create a Code-Graph (`pending`, build is triggered automatically). **Idempotent**: same repo_url+branch returns the existing record (200); a new one returns 201.

**Request body** (with-team)

| Field | Type | Required | Description |
|---|---|---|---|
| team_id | string | Yes | Team ID |
| repo_url | string | Yes | Repository URL |
| branch | string | No | Branch, default `main` |
| repo_name | string | No | Repository name |
| user_id / agent_id / task_id | string | No | Ownership |

**Response** `data`: `CodeGraphDetail`.

**Errors**: `400` (missing team_id/repo_url).

**Example**

```json
// Request
POST /v3/code-graph/create
{ "team_id": "t_1", "repo_url": "https://github.com/org/repo", "branch": "main" }

// Response (201)
{
  "code": 0,
  "message": "ok",
  "data": {
    "code_graph_id": "cg-e5f6g7h8",
    "team_id": "t_1",
    "repo_name": "repo",
    "repo_url": "https://github.com/org/repo",
    "branch": "main",
    "status": "pending",
    "version": "0",
    "owner_user_id": "u_1"
  }
}
```

### POST /v3/code-graph/list

Paginated list by team.

**Request body**: `team_id` (required), `status?`, `limit?`, `offset?`.

**Response** `data`: `{ items: CodeGraphDetail[], total }`.

### POST /v3/code-graph/get

Single lookup (id-only).

**Request body**: `code_graph_id`.

**Response** `data`: `CodeGraphDetail`.

**Errors**: `404`.

### POST /v3/code-graph/update-meta

Update repo_name / summary.

**Request body**: `code_graph_id`, `repo_name?`, `summary?` (at least one).

**Response** `data`: `CodeGraphDetail`.

**Errors**: `400`, `404`.

### POST /v3/code-graph/sync

Trigger a sync (rebuild the index).

**Request body**: `code_graph_id`, `user_id?`.

**Response** `data`: `{ code_graph_id, status }` (HTTP `202`).

**Errors**: `404`, `409` (busy; data carries `{ status, step }`).

### POST /v3/code-graph/delete

Batch delete.

**Request body**: `code_graph_ids` (1–100, non-empty).

**Response** `data`: `BatchDeleteResult`.

---

### Query tools (8, all id-only)

> The 8 query endpoints are registered together in a loop from `CODEGRAPH_QUERY_TOOL_NAMES` and share one handler:
> - First `getById(service_id, code_graph_id)` scopes ownership, with `404` as the fallback;
> - **When not `ready`, returns `{ text: "", isError: false }` (HTTP 200, not an error)**;
> - Parameters are strictly validated against the `QUERY_SPECS` allowlist, and **undeclared fields get a 400 immediately** (`unexpected field: xxx`);
> - Delegates to `executeTool`; when the result has `isError=true` the HTTP status is 500, but the body is still the `code=0` success envelope, and the failure flag is `data.isError=true` (see the isError special case in §1.2).

| Endpoint | Parameters (default/range) | Description |
|---|---|---|
| `POST /search` | `query` (required), `kind?` (function/method/class/interface/type/variable/route/component), `limit?` (default 10, 1–100) | Search by symbol name; returns locations only (no source) |
| `POST /explore` | `query` (required), `maxFiles?` (default 12, 1–200) | **Preferred**: returns the full source of relevant symbols grouped by file |
| `POST /callers` | `symbol` (required), `limit?` (default 20, 1–200) | List functions that call symbol |
| `POST /callees` | `symbol` (required), `limit?` (default 20, 1–200) | List functions that symbol calls |
| `POST /impact` | `symbol` (required), `depth?` (default 2, 1–10) | Impact analysis |
| `POST /node` | `symbol` (required), `includeCode?` (default false), `file?`, `line?` (>=1) | Full info for a single symbol (optionally with source) |
| `POST /status` | No parameters | Index health check |
| `POST /files` | `path?`, `pattern?`, `format?` (tree/flat/grouped, default tree), `includeMetadata?` (default true), `maxDepth?` (>=1) | Indexed file tree |

**Common request body**: `code_graph_id` (required) + the parameters in the table above.

**Common response** `data`: `{ text: string, isError: boolean }`.

**Common errors**: `400` (parameters), `404` (code graph not found), `500` (tool execution failed, `data.isError=true`, body still code=0), `503` (instance not loaded).

**Example** (explore)

```json
// Request
POST /v3/code-graph/explore
{ "code_graph_id": "cg-e5f6g7h8", "query": "user login logic", "maxFiles": 12 }

// Response
{
  "code": 0,
  "message": "ok",
  "data": { "text": "```src/auth.ts\n...\n```", "isError": false }
}
```

---

## 3.3 Tools — Agent self-discovery (2)

> v7 progressive-exposure: the LLM Agent first discovers available tools via `tools/list`, then executes them via `tools/call`.
> Only **read-only query tools** are exposed; management operations (create/delete/ingest/sync) are not.
> `knowledge_id` determines the resource type: `wiki-*` → Wiki toolset (7), `cg-*` → Code-Graph toolset (9).

### POST /v3/tools/list

List the tools available for a knowledge resource.

**Request body**: `knowledge_id` (required).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| knowledge_id | string | Echoed back |
| type | string | `wiki` / `code-graph` |
| name | string | Resource name |
| summary | string\|null | Summary |
| status | string | Resource status |
| tools | object[] | `[{ name, description, params }]` |

**Errors**: `400` (knowledge_id missing/malformed), `404` (resource does not exist).

**Example**

```json
// Request
POST /v3/tools/list
{ "knowledge_id": "wiki-a1b2c3d4" }

// Response
{
  "code": 0,
  "message": "ok",
  "data": {
    "knowledge_id": "wiki-a1b2c3d4",
    "type": "wiki",
    "name": "Team wiki",
    "status": "ready",
    "tools": [
      { "name": "search", "description": "BM25 full-text search over wiki page content", "params": { "query": { "type": "string", "required": true } } }
    ]
  }
}
```

### POST /v3/tools/call

Execute a tool.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| knowledge_id | string | Yes | Resource ID |
| tool_name | string | Yes | Tool name |
| params | object | Yes | Tool parameters (as defined by tools/list) |

**Response** `data`: tool execution result (wiki tools return structured data; code-graph tools return `{ text, isError }`).

**Errors**: `400` (parameters), `403` (unknown tool), `404` (resource does not exist), `500` (code-graph tool execution failed, `data.isError=true`, body still code=0), `503` (instance not loaded).

> **Tool allowlist** (tool_name):
> - Wiki (7): `get_info`, `search`, `list_pages`, `read_page`, `get_graph`, `list_raw`, `read_raw`
> - Code-Graph (9): `get_info`, `search`, `explore`, `callers`, `callees`, `impact`, `node`, `status`, `files`

---

## 3.4 Internal LLM-Binding (3)

> Per-instance LLM routing configuration, control plane (TMC / operator curl). `api_key` is never echoed back.

### POST /v3/internal/llm-binding/set

Upsert binding (`proxy`\|`byo`). **Idempotent**: repeated set overwrites.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| mode | string | Yes | `proxy` / `byo` |
| proxy_base_url | string | Required for proxy | Proxy LLM address |
| base_url | string | Required for byo | Self-hosted LLM address |
| api_key | string | Required on first set | If the record already exists and it is omitted, the existing value is kept |
| enabled | boolean | No | Default true |

**Response** `data`: `{ service_id, mode, enabled, updated_at }` (**does not include api_key**).

**Errors**: `400` (invalid mode / missing address / missing api_key on first set).

### POST /v3/internal/llm-binding/status

Read binding status (without api_key).

**Response** `data`

| Field | Type | Description |
|---|---|---|
| bound | boolean | Whether a binding is configured |
| mode | string\|null | `proxy` / `byo`; `null` if not configured |
| enabled | boolean | Whether enabled; `false` if not configured |

> When not configured, returns `{ bound: false, mode: null, enabled: false }`.

### POST /v3/internal/llm-binding/list

List all bindings (**the `x-tdai-service-id` header is not required**).

**Response** `data`: `{ items: [{ service_id, mode, proxy_base_url, base_url, has_api_key, enabled }] }`.

---

## 3.5 Auto-Sync (2)

> Status query and manual trigger for the scheduled sync scheduler. **No authentication**. A rare v3 module that includes GET.

### GET /v3/auto-sync/status

Query scheduler runtime status + configuration.

**Response** `data`: `{ running, activeSyncs, scanning, ... , config: { enabled, scanIntervalMs, maxConcurrentSyncs } }`.

### POST /v3/auto-sync/trigger

Manually trigger one full scan (fire-and-forget, returns immediately).

**Response** `data`: `{ triggered: boolean, reason? }` (when `KNOWLEDGE_AUTO_SYNC_ENABLED` is off, `triggered=false` + reason).

---

## 4. Appendix

### 4.1 Key differences from MemoryCore (required reading for cross-volume integration)

| Dimension | MemoryCore (Volume 1) | MemoryKnowledge (this volume) |
|---|---|---|
| Envelope | `{ code, message, request_id, data }` | `{ code, message, data }` (**no request_id**) |
| Auth | Layered: Bearer + service-id + user-key | `x-tdai-service-id` only (intranet trust) |
| Error message | Three formats (enum / 5-digit code / `CODE: detail`) | Lowercase English sentences (branch on HTTP code) |
| Pagination output | `{ items, total, limit, offset }` | `{ items, total }` (no limit/offset echo) |
| ID prefix | skill `skl-` etc. | wiki `wiki-`, code-graph `cg-` |

### 4.2 Endpoint count corrections

| File | Declared in comment | Actual | Difference |
|---|---|---|---|
| `wiki.ts` | 15 endpoints | 16 | extra `update-meta` |
| `code-graph.ts` | 13 endpoints | 14 | extra `update-meta` |

### 4.3 Idempotency summary

| Endpoint | Idempotent behavior |
|---|---|
| `wiki/create` | Same name in the same team returns the existing record (200, not an error) |
| `code-graph/create` | Same repo_url+branch returns the existing record (200) |
| `llm-binding/set` | Repeated set overwrites (an omitted api_key keeps the original value) |
| `wiki/delete`, `code-graph/delete` | A single failure does not fail the whole call; it is recorded in the `failed` array |
