# SQLite → Tencent Cloud Vector Database Migration Tool

An offline migration tool for migrating memory-tdai data from local SQLite storage to Tencent Cloud Vector Database (TCVDB).

## Prerequisites

- Node.js >= 22.16.0
- The plugin has been installed via `openclaw plugins install`
- The migration script has been compiled (see below)

## Compile

The migration script is written in TypeScript and must be compiled before running:

```bash
npm run build:migrate-sqlite-to-vdb
```

Build output goes to `scripts/migrate-sqlite-to-tcvdb/dist/` and can be run directly with Node.

## Usage

```bash
# Dry-run mode (only inspect the source data, no writes)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --dry-run

# Actual migration
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --yes
```

### More examples

```bash
# Pass the API Key directly (not via an environment variable)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key 'your-api-key-here' \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --yes
```

```bash
# Specify a custom SQLite path (when the database is not at the default vectors.db location)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --sqlite-path /backup/2026-04/vectors-snapshot.db \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --yes
```

```bash
# Migrate only the L1 memory layer (skip L0 raw messages and Profiles)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --layers l1 \
  --yes
```

```bash
# Migrate only L0 and L1 (do not migrate Profiles)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --layers l0,l1 \
  --yes
```

```bash
# English corpus scenario: use English BM25 tokenization
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-en-v1.5 \
  --bm25-language en \
  --yes
```

```bash
# Disable BM25 sparse vectors (use dense vector retrieval only)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --no-bm25-enabled \
  --yes
```

```bash
# Migrate data only, without automatically updating openclaw.json and the manifest (manage config manually)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --no-apply-config \
  --no-rewrite-manifest \
  --yes
```

```bash
# Incremental migration: allow existing data in the target database, skip the non-empty check
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --no-fail-if-target-nonempty \
  --no-verify-counts \
  --yes
```

```bash
# Write the migration summary to a JSON file (suited for CI/automation pipelines)
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://127.0.0.1:80 \
  --tcvdb-username root \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --summary-json-path ./migration-report.json \
  --job-id "migrate-2026-04-13" \
  --yes
```

```bash
# Set a custom timeout and alias
npm run migrate:sqlite-to-tcvdb -- \
  --plugin-data-dir ~/.openclaw/memory-tdai \
  --openclaw-config-path ~/.openclaw/openclaw.json \
  --tcvdb-url http://10.0.1.50:80 \
  --tcvdb-username admin \
  --tcvdb-api-key-env TCVDB_API_KEY \
  --tcvdb-database agent_memory_prod \
  --tcvdb-embedding-model bge-large-zh \
  --tcvdb-alias "production-primary" \
  --tcvdb-timeout-ms 30000 \
  --yes
```

## Parameters

| Parameter | Required | Default | Description |
|---|---|---|---|
| `--plugin-data-dir` | Yes | — | Plugin data directory path |
| `--openclaw-config-path` | Yes | — | Path to the `openclaw.json` config file |
| `--sqlite-path` | No | `<plugin-data-dir>/vectors.db` | SQLite database file path (defaults to `vectors.db` under the data directory) |
| `--plugin-id` | No | `memory-tencentdb` | Plugin ID used when writing the config |
| `--tcvdb-url` | Yes | — | TCVDB service address |
| `--tcvdb-username` | Yes | — | TCVDB username |
| `--tcvdb-api-key` | * | — | TCVDB API key (plaintext) |
| `--tcvdb-api-key-env` | * | — | Name of the environment variable containing the API key |
| `--tcvdb-database` | Yes | — | TCVDB database name |
| `--tcvdb-embedding-model` | Yes | — | Embedding model name |
| `--tcvdb-alias` | No | `""` | User-defined alias |
| `--tcvdb-timeout-ms` | No | `10000` | Request timeout (milliseconds) |
| `--layers` | No | `l0,l1,l2,l3` | Layers to migrate (comma-separated) |
| `--dry-run` | No | `false` | Preview only, no writes |
| `--yes` | No | `false` | Skip interactive confirmation |
| `--apply-config` | No | `true` | Update openclaw.json after migration |
| `--config-backup` | No | `true` | Back up the original config file before writing the config |
| `--rewrite-manifest` | No | `true` | Update manifest.json to tcvdb |
| `--fail-if-target-nonempty` | No | `true` | Abort if the target database is non-empty |
| `--verify-counts` | No | `true` | Verify record counts after migration |
| `--summary-json-path` | No | — | Write the migration summary to this file |
| `--job-id` | No | — | Migration job ID (for tracking) |
| `--bm25-enabled` | No | `true` | Enable BM25 sparse vectors |
| `--bm25-language` | No | `zh` | BM25 language (`zh` or `en`) |

\* One of `--tcvdb-api-key` and `--tcvdb-api-key-env` is required.

## Directory structure

```
scripts/migrate-sqlite-to-tcvdb/
├── cli-entry.ts          # CLI entry point
├── sqlite-to-tcvdb.ts    # Core migration logic (argument parsing, pre-check, data migration)
├── config-write.ts       # OpenClaw config update (JSON5, self-contained)
├── manifest-write.ts     # Manifest rewrite
├── *.test.ts             # Co-located test files
├── tsconfig.json         # Migration script compile config
├── dist/                 # Build output (gitignored)
└── README.md             # This file

bin/migrate-sqlite-to-tcvdb.mjs     # Very thin bin wrapper → dist/
```

The migration script references the storage implementations (VectorStore, TcvdbMemoryStore, etc.) via `../../src/`, but **does not depend on `openclaw/plugin-sdk`**. Config write-back uses `json5` directly.
