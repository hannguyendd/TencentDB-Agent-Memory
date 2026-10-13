# Opik → Memory Core Import Tool

Converts the Traces under an Opik Project into conversation messages and writes them to L0 via the Memory Core Gateway's `POST /v3/conversation/add`.

## Capabilities

- Automatically paginates through all Opik Projects and all Traces of a specified Project
- Supports selecting projects by Project name or UUID
- Recognizes common Trace structures such as `messages`, `conversation`, `history`, `prompt/response`, and OpenAI `choices`
- Automatically merges input/output messages, removes overlap, and limits single-message and single-batch size
- Pre-checks by Session before writing; when more than 40,000 L0 entries are expected, deduplicates across Traces and prioritizes importing the latest tail snapshot
- Supports Dry Run, resume from checkpoint, network retries, and Pipeline throttling
- Secrets are read only from environment variables

## Prerequisites

- Node.js `>= 22.16.0`
- The current project's dependencies are installed
- The Opik REST API is accessible
- The remote Memory Core Gateway is accessible at `/health`, `/v3/conversation/add`, and `/v3/conversation/query`
- The target `service_id`, `team_id`, `agent_id`, and `user_id` have been determined

Enter the Memory Core directory:

```bash
cd MemoryCore
```

View all parameters:

```bash
npm run import:opik -- --help
```

## Opik address and pagination

It is recommended to configure only the Opik root address and workspace:

```bash
export OPIK_URL='http://opik.example.com:5173'
export OPIK_WORKSPACE='default'
```

The UI address is also supported:

```text
http://opik.example.com:5173/default/projects?size=25
```

`size=25` in the UI URL does not limit the import scope. The tool converts it to the `/api/v1/private` API address and automatically reads all pages by `page` and `size`; `--page-size` defaults to `100`.

## Configure the remote Memory Core

The addresses below are examples only; replace them with the actual Gateway address:

```bash
export MEMORY_CORE_URL='http://memory-core.example.com:8423'
export MEMORY_CORE_SERVICE_ID='default'
export MEMORY_CORE_TEAM_ID='team-001'
export MEMORY_CORE_AGENT_ID='agent-001'
export MEMORY_CORE_USER_ID='user-001'
```

Optional Task isolation:

```bash
export MEMORY_CORE_TASK_ID='task-001'
```

When no Task is needed:

```bash
unset MEMORY_CORE_TASK_ID
```

Enter the API Key securely, to avoid writing it into code or config files:

```bash
read -s "MEMORY_CORE_API_KEY?Memory Core API Key: "
echo
export MEMORY_CORE_API_KEY
```

Check the Gateway:

```bash
curl --fail --silent --show-error "${MEMORY_CORE_URL}/health"
```

## Run a Dry Run first

A Dry Run reads the real Opik and converts Traces, but does not write to Memory Core or the checkpoint file:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --dry-run
```

`--project` accepts both Project names and UUIDs, and can be passed repeatedly or comma-separated:

```bash
npm run import:opik -- \
  --project 'project-a' \
  --project '019fb2e2-16a9-717d-98a8-0cd2e1bef87e' \
  --dry-run
```

Omitting `--project` processes all projects under the workspace. When there are many projects, first specify a project and `--max-traces` for a small-batch verification.

## Actual import

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-traces 5 \
  --state-file './opik-import-remote-state.json'
```

On success it prints:

```text
[import] project=... trace=... accepted=...
[done] seen_traces=5 imported_traces=5 ... imported_messages=...
```

The tool actually calls:

```text
POST <MEMORY_CORE_URL>/v3/conversation/add
```

The write scope is determined jointly by the following fields:

- `x-tdai-service-id`: `MEMORY_CORE_SERVICE_ID`
- `team_id`: `MEMORY_CORE_TEAM_ID`
- `agent_id`: `MEMORY_CORE_AGENT_ID`
- `user_id`: `MEMORY_CORE_USER_ID`
- `task_id`: `MEMORY_CORE_TASK_ID`, optional
- `session_id`: generated stably from the Opik Project ID and `thread_id`/Trace ID

Each message writes the original Opik time to both:

- `timestamp`: the time the message actually occurred
- `recorded_at`: the L0 ingestion ordering time, corresponding to TCVDB's `recorded_at_ms`

Therefore when the panel sorts by `recorded_at_ms desc`, it shows items by Opik historical time rather than by the time of this import run. Ordinary Memory Core writes that do not explicitly pass `recorded_at` still use the server receive time.

## Oversized Session protection

The default is `--max-session-messages 40000`. This counts L0 message entries, not the number of "turns" after pairing user/assistant; 40,000 messages is roughly 20,000 standard Q&A turns, below the known single-Session risk boundary of 50,000 entries.

The tool first aggregates the Traces to be processed this run by target `session_id`. If the expected writes of a single Session exceed the limit:

1. Merge the accumulated conversation in Trace time order, eliminating the problem of the previous Trace's history reappearing in the next Trace;
2. Keep only the latest N messages after deduplication;
3. Prefer writing a separate tail snapshot Session, with an ID like `<source-session>:t40000:<snapshot-hash>`;
4. Stop writing that source Session's old Traces one by one, so a single new Session does not exceed the configured limit.

The separate snapshot ID changes with the tail content. When the data source later adds new messages, a new snapshot Session is generated, avoiding further appends to the old Session and exceeding the limit again.

Dry Run to check oversized Sessions:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy tail \
  --dry-run
```

If truncation is not allowed and you want to stop when the limit is exceeded:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --max-session-messages 40000 \
  --large-session-strategy error \
  --dry-run
```

Use `--max-session-messages 0` to turn off the protection, but this is not recommended for Sessions that may exceed 50,000 L0 entries.

## Resume from checkpoint

Resume from checkpoint is enabled by default. Each successful batch is written to `--state-file` immediately, and re-running the same command automatically skips completed batches:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --state-file './opik-import-remote-state.json'
```

Ignore the existing checkpoint:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --no-resume
```

`--no-resume` may cause duplicate imports and should be used only when a re-import is explicitly needed. The checkpoint file permission is `0600`, but it does not store the API Key.

## Pipeline policy

By default, wait for L1 to be idle after every 20 batches written, and wait for L1/L2/L3 to all be idle at the end.

If the target environment has memory extraction turned off and you only need to write L0:

```bash
npm run import:opik -- \
  --project '5d0fd72d' \
  --wait-every 0 \
  --no-final-wait \
  --state-file './opik-import-remote-state.json'
```

## Verify the import results

```bash
curl --fail --silent --show-error \
  -X POST "${MEMORY_CORE_URL}/v3/conversation/query" \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer ${MEMORY_CORE_API_KEY}" \
  -H "x-tdai-service-id: ${MEMORY_CORE_SERVICE_ID}" \
  --data "$(cat <<JSON
{
  \"team_id\": \"${MEMORY_CORE_TEAM_ID}\",
  \"agent_id\": \"${MEMORY_CORE_AGENT_ID}\",
  \"user_id\": \"${MEMORY_CORE_USER_ID}\",
  \"limit\": 100,
  \"offset\": 0
}
JSON
)"
```

## Opik authentication

A self-hosted Opik may not require authentication by default. When authentication is enabled:

```bash
read -s "OPIK_API_KEY?Opik API Key: "
echo
export OPIK_API_KEY
export OPIK_AUTH_SCHEME='Bearer'
```

When `OPIK_AUTH_SCHEME` is empty, `OPIK_API_KEY` is used as-is as the `Authorization` Header.

## Common parameters

| Parameter | Default | Description |
|---|---:|---|
| `--project` | All projects | Project name or UUID, repeatable or comma-separated |
| `--page-size` | `100` | Opik API page size |
| `--max-traces` | `0` | Max Traces to process this run; `0` means unlimited |
| `--max-session-messages` | `40000` | Max L0 messages written for a single target Session; `0` disables protection |
| `--large-session-strategy` | `tail` | Keep the latest tail when exceeded; `error` means stop outright |
| `--state-file` | `.opik-memory-import-state.json` | Checkpoint file |
| `--dry-run` | Off | Only fetch and convert, no writes |
| `--no-resume` | Off | Ignore the checkpoint; may cause duplicate imports |
| `--include-system` | Off | Convert system/developer into user messages with a prefix |
| `--wait-every` | `20` | Wait for L1 every N write requests; `0` disables |
| `--no-final-wait` | Off | Do not wait for final L1/L2/L3 idle |
| `--timeout-ms` | `30000` | Single HTTP request timeout |
| `--retries` | `4` | Retry count for network errors, 429, and 5xx |

## Verified pipeline

This tool has completed end-to-end verification using the real Opik API and an isolated local Memory Core:

1. Paginated reading of the Opik Project and Traces
2. Converted 5 Traces into 15 L0 messages
3. Wrote to `/v3/conversation/add`
4. Queried back 15 messages via `/v3/conversation/query`
5. On re-run, the checkpoint hit and the write count was 0
6. The SQLite and JSONL mirrors on disk had matching counts
