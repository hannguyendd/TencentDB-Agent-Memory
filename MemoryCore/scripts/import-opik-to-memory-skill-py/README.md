# Opik → Memory Core Skill Import Tool (Python version)

**Uses only the Python standard library, no third-party dependencies**; runs directly on Python 3.9+.

## Three subcommands

- `list-projects` — only list Opik projects
- `fetch` — pull data from Opik + aggregate it into local session JSON files (does not write to core)
- `import` — load local session files into Memory Core

**Recommended practice: keep fetch and import separate**. After fetch you can disconnect from Opik and let import run slowly; import supports resume from checkpoint (on by default), so if it dies halfway, a rerun only fills in the difference.

## Relationship with the TS version (`../import-opik-to-memory-skill/`)

| Dimension | TS version | Python version |
|---|---|---|
| Fetch vs load | One step | **Two separate steps** (fetch → import) |
| Dependencies | Node ≥ 22.16 + `npm install` | Python 3.9+, zero dependencies |
| Load batching | Packed by bytes/count | **Batched by "one conversation turn"** (one user + the assistant/tool_call/tool_result that follow it) |
| Load pacing | As fast as possible | Sleep after each turn (default 3s), Opik global rate limit 500ms |
| Resume from checkpoint | Yes | **import has it, per-session granularity** |
| Extraction output stats | Polls `skill/list` until convergence | Does not check; see the output in the UI or `/v3/skill/list` |

## Prerequisites

- Python 3.9+
- Opik REST API is reachable
- Memory Core Gateway business endpoints (`/v3/skill/*`) are reachable
- Skill extraction + LLM on the Memory Core side are running (otherwise 0 output)
- `team_id` + `agent_id` are already registered at the metadata layer
  - ⚠️ The agent id is `agt-xxx`, not `apt-xxx`; the `asset_id` found in metadata `/api/v1/meta/asset/list-accessible` is `skl-*` (the skill primary key); to find the corresponding `agent_id`, use core's `/v3/skill/list` to look up `owner_agent_id`

## Only secrets use environment variables; everything else is a command-line argument

This is deliberate: env vars are easy to get wrong, forget to unset, or be inherited by other processes. Identity parameters (`--team-id / --agent-id / --user-id / --service-id / --memory-url / --opik-url`) **must be given explicitly on the command line**, so that every invocation makes clear which environment it targets.

Secrets are read only from environment variables and are not accepted as CLI arguments (to avoid appearing in shell history / `ps aux`):

```bash
export MEMORY_CORE_API_KEY='ck_xxx.xxx'
# Only needed when Opik has auth enabled:
# export OPIK_API_KEY='...'
# export OPIK_AUTH_SCHEME='Bearer'
```

> `user_id` / `team_id` / `agent_id` / `session_id` must not contain `|` (the Redis queue element separator); the script validates this at startup.

## Usage

### 1. List Opik projects

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py list-projects \
  --opik-url 'http://<opik-host>:5173'
```

No Memory Core parameters or secrets are needed.

### 2. Fetch — pull data from Opik to local only

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '3367b740' \
  --out-dir ./opik-dump-3367b740
```

- `--project` supports exact id / exact name / id prefix / name prefix
- The output directory has one `.json` file per session (`session_id + .json`, illegal characters converted to `-`)
- The directory also has a `manifest.json` recording the project id, trace count, session count, and fetch time
- Existing files are skipped by default; add `--overwrite` to overwrite them

**Important**: fetch only hits Opik, not Memory Core; the two are decoupled.

### 3. Import — load from the local directory into Memory Core

```bash
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx \
  --agent-id agt-xxx \
  --user-id  usr-xxx \
  --task-id  opik-import-2026-08 \
  --concurrency 5 \
  --turn-gap-ms 2000
```

On the first run you will see a rough ETA:

```
[import] total sessions=87 (done 0, pending 87) total turns=412 pending turns=412
[import] concurrency=5 turn-gap=2000ms → rough ETA ~2m44s (HTTP time counted separately)
```

After each session completes during the run, a progress line is printed:

```
[progress] sessions 12/87  turns 68/412  elapsed 34s  ETA ~2m5s
```

The checkpoint is saved at `--in-dir/.import-state.json` (overridable with `--state-file`). If it dies, a rerun automatically skips completed sessions; add `--no-resume` to force a reload.

### Dry-run

```bash
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir ./opik-dump-3367b740 \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id  team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --dry-run
```

Nothing is actually sent to core and no checkpoint is written; only the grouping logic is run. Dry-run also requires the identity parameters (the script reads them in to validate and compute the ETA).

## Parameter reference

### `fetch`

| Parameter | Default | Description |
|---|---:|---|
| `--project` | **required** | id / name / prefix |
| `--out-dir` | **required** | Output directory |
| `--max-traces` | 0 | Upper limit on traces pulled from Opik (0=unlimited) |
| `--max-sessions` | 0 | Keep only the first N sessions |
| `--page-size` | 100 | Opik page size |
| `--opik-request-gap-ms` | 500 | Minimum interval between Opik requests (protects Opik) |
| `--include-system` | off | Keep system messages (dropped by default) |
| `--overwrite` | off | Overwrite existing files |

### `import`

| Parameter | Default | Description |
|---|---:|---|
| `--in-dir` | **required** | Directory generated by fetch |
| `--max-sessions` | 0 | Load only the first N sessions |
| `--concurrency` | 2 | Concurrency cap across different sessions |
| `--turn-gap-ms` | 3000 | Interval between turns within the same session |
| `--no-force-archive` | off | Skip the trailing force-archive |
| `--dry-run` | off | Read-only, no writes |
| `--state-file` | `<in-dir>/.import-state.json` | Checkpoint file |
| `--no-resume` | off | Ignore the checkpoint |

## Data flow

```
Opik /projects
    ↓ (project selected)
Opik /traces?project_id=...   (paginated; each request globally rate-limited to 500ms)
    ↓
Aggregate by thread_id → for the same thread keep only the trace with the most messages (cumulative snapshot)
    ↓
Local JSON file: <out-dir>/<session_id>.json
    ↓ (fetch ends; Opik can be disconnected now)
    ↓ (import starts)
Read local files → split each session into "conversation turns"
    ↓
Run different sessions concurrently with concurrency=N; serial within the same session
    ↓
For each turn POST /v3/skill/conversation/add (same session_id)
    ↓ sleep turn-gap-ms
    ↓
force-archive as a backstop → record into the checkpoint
```

**Key points**:
- The same session always uses the same `session_id`; only one turn is pushed at a time
- Sleep between turns within the same session (default 3s); different sessions run concurrently
- Global minimum interval for Opik fetching (default 500ms)
- The import checkpoint granularity is the session; if a turn fails within a session, it warns and continues to the next turn

## Extraction thresholds

Server-side `add-handler` triggers archiving when any one condition is met:

| Condition | Threshold |
|---|---:|
| Cumulative `tool_call` count | 10 |
| Cumulative bytes | 40 KB |
| Bytes in a single request | ≥ 40 KB triggers immediate compression and archiving |

If a session has few tool_calls and short content, only the `force-archive` step archives it; if the extractor judges it "not worth retaining" → 0 skills, which is a **normal result**.

## Quick verification (1 session, verify the pipeline)

```bash
# fetch 1 session
python3 scripts/import-opik-to-memory-skill-py/import_opik.py fetch \
  --opik-url 'http://<opik-host>:5173' \
  --project '019ed0c0' --out-dir /tmp/opik-smoke \
  --max-sessions 1 --max-traces 20

# load into core
MEMORY_CORE_API_KEY='ck_xxx.xxx' \
python3 scripts/import-opik-to-memory-skill-py/import_opik.py import \
  --in-dir /tmp/opik-smoke \
  --memory-url 'http://<memory-core-host>:8080' \
  --service-id default \
  --team-id team-xxx --agent-id agt-xxx --user-id usr-xxx \
  --turn-gap-ms 1000
```

## Known limitations

- No filtering of evaluation data such as SWE-bench (avoid them manually when selecting a project)
- Extraction output is not checked; look at the UI / `/v3/skill/list` later
- A failed turn within a single session warns and continues, with no overall rollback (will rerunning the same session next time duplicate archives? — yes; the checkpoint granularity is the session, with no finer division within a session. If many turns fail, delete that session's checkpoint entry and rerun)
