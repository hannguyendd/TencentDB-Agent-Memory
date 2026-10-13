# memory-tdai CLI

The `openclaw memory-tdai` command namespace, providing offline data management tools.

## seed — import historical conversation data

Import historical conversation JSON files into the memory pipeline, running the full L0→L1→L2→L3 flow. Suitable for:

- Loading existing conversation data into the memory system
- Batch-testing memory extraction quality
- Migrating/restoring memory data

### Usage

```bash
openclaw memory-tdai seed --input <file> [options]
```

### Options

| Option | Required | Description |
|------|------|------|
| `--input <file>` | ✅ | Path to the input JSON file |
| `--output-dir <dir>` | — | Output directory (by default a timestamped directory is generated automatically) |
| `--session-key <key>` | — | Fallback session key (used when the input data lacks one) |
| `--config <file>` | — | Config override file (JSON, deep-merged with the openclaw.json plugin config) |
| `--strict-round-role` | — | Strictly validate that each conversation round contains both user and assistant messages |
| `--yes` | — | Skip interactive confirmations (such as the timestamp auto-fill confirmation) |

### Examples

```bash
# Basic usage
openclaw memory-tdai seed --input conversations.json

# Specify the output directory
openclaw memory-tdai seed --input data.json --output-dir ./seed-output

# Use a custom config override (e.g. to tune pipeline parameters)
openclaw memory-tdai seed --input data.json --config seed-config.json

# Skip all confirmations
openclaw memory-tdai seed --input data.json --yes

# Strict mode + custom config
openclaw memory-tdai seed --input data.json --config seed-config.json --strict-round-role --yes
```

### Input file format

Two JSON formats are supported:

#### Format A: object wrapper

```json
{
  "sessions": [
    {
      "sessionKey": "user-alice",
      "sessionId": "conv-001",
      "conversations": [
        [
          { "role": "user", "content": "Hello", "timestamp": 1711929600000 },
          { "role": "assistant", "content": "Hello! How can I help you?", "timestamp": 1711929601000 }
        ],
        [
          { "role": "user", "content": "How is the weather today?" },
          { "role": "assistant", "content": "It's sunny today, a good day to go out." }
        ]
      ]
    }
  ]
}
```

#### Format B: top-level array

```json
[
  {
    "sessionKey": "user-alice",
    "conversations": [
      [
        { "role": "user", "content": "Hello" },
        { "role": "assistant", "content": "Hello!" }
      ]
    ]
  }
]
```

#### Field reference

| Field | Type | Required | Description |
|------|------|------|------|
| `sessionKey` | string | ✅ | Session identifier (such as a user ID or channel name) |
| `sessionId` | string | — | Conversation instance ID (one sessionKey may have multiple sessionIds) |
| `conversations` | message[][] | ✅ | Array of conversation rounds; each round is a group of messages |
| `role` | string | ✅ | Message role: `user` or `assistant` |
| `content` | string | ✅ | Message content |
| `timestamp` | number \| string | — | Timestamp: epoch milliseconds or an ISO 8601 string. When missing, seed prompts to auto-fill it |

### Config overrides

`--config` accepts a JSON file, which is **merged two levels deep** with the plugin config in `openclaw.json`:

- If a top-level key is an object on both sides → shallow merge (fields in base that are not overridden are kept)
- Other types → overwritten directly

Common scenario: use more aggressive pipeline parameters during seeding to speed up processing:

```json
{
  "pipeline": {
    "everyNConversations": 3,
    "enableWarmup": false,
    "l1IdleTimeoutSeconds": 2,
    "l2DelayAfterL1Seconds": 1,
    "l2MinIntervalSeconds": 1,
    "l2MaxIntervalSeconds": 10
  }
}
```

To seed into a standalone TCVDB database:

```json
{
  "storeBackend": "tcvdb",
  "tcvdb": {
    "database": "my_seed_test_db"
  },
  "pipeline": {
    "everyNConversations": 3,
    "enableWarmup": false,
    "l1IdleTimeoutSeconds": 2
  }
}
```

### Output directory structure

```
<output-dir>/
├── conversations/          — L0 JSONL files
├── records/                — L1 JSONL files
├── scene_blocks/           — L2 scene blocks
├── vectors.db              — SQLite vector database (sqlite backend only)
├── .metadata/
│   ├── manifest.json       — metadata (store binding + seed run records)
│   └── checkpoint.json     — pipeline progress
└── .backup/                — rolling backups
```

After seeding completes, `manifest.json` records information about this run:

```json
{
  "version": 1,
  "createdAt": "2026-04-01T22:00:00.000Z",
  "store": {
    "type": "sqlite",
    "sqlite": { "path": "vectors.db" }
  },
  "seed": {
    "inputFile": "conversations.json",
    "sessions": 3,
    "rounds": 42,
    "messages": 128,
    "startedAt": "2026-04-01T22:00:00.000Z",
    "completedAt": "2026-04-01T22:05:30.000Z"
  }
}
```
