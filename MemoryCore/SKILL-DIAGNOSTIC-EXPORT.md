---
name: openclaw-diagnostic-export
description: Helps users export on-site diagnostic data of the OpenClaw + memory-tencentdb (formerly memory-tdai) memory plugin for troubleshooting. Trigger when the user mentions "export diagnostic data", "export diagnostic", "on-site data", "troubleshoot", "export logs", "collect on-site data", or "package on-site data".
version: 1.0.0
---

## Purpose

Package OpenClaw logs, memory plugin data (L0~L3), and the redacted config into a local archive, which the user confirms and then manually sends to the dev team for troubleshooting.

> **Naming note**: the plugin was renamed from `@tdai/memory-tdai` to `@tencentdb-agent-memory/memory-tencentdb`, but the data directory is always `~/.openclaw/memory-tdai/` (hard-coded in the code). All references to the `memory-tdai` directory in this skill refer to the actual data directory path, unrelated to the plugin ID.

## Export Workflow

### Step 1: Confirm the environment

Before exporting, first confirm that the OpenClaw working directory exists and is accessible:

```bash
# Detect the working directory (priority: environment variable > ~/.openclaw > ~/.clawdbot)
OPENCLAW_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
[ -d "$OPENCLAW_DIR" ] || OPENCLAW_DIR="$HOME/.clawdbot"
ls -la "$OPENCLAW_DIR/" 2>/dev/null && echo "✅ Found: $OPENCLAW_DIR" || echo "❌ OpenClaw working directory not found"
```

Confirm that the memory-tdai subdirectory exists:

```bash
ls -la "$OPENCLAW_DIR/memory-tdai/" 2>/dev/null
```

### Step 2: Run the export script

Run the export script under the project's `scripts/` directory:

```bash
bash scripts/export-diagnostic.sh
```

> The script is at `scripts/export-diagnostic.sh` in this project. If running via `pnpm` or another method, make sure the working directory is the project root.

By default the script outputs the archive to `~/Downloads/openclaw-diagnostic-<timestamp>.tar.gz`.

To specify a different output directory:

```bash
bash scripts/export-diagnostic.sh /tmp
```

### Step 3: Confirm the export result

After the script finishes, check the output:

1. **Confirm the archive was generated** — the script prints the archive path and size at the end
2. **Explain the contents to the user**:

| File/Directory | Content | Privacy Risk |
|-----------|------|---------|
| `env-info.txt` | System version, OpenClaw version, directory structure, disk usage | Low |
| `logs/` | OpenClaw gateway logs + rolling logs (last 3 days, up to 5000 lines per file) | Low |
| `memory-tdai/` | Full memory plugin data: L0 conversations, L1 memories, L2 scenes, L3 persona, SQLite database, checkpoint | **High** — contains the original user conversation text |
| `openclaw-config-redacted.json` | Redacted config (API Key/Token/Password/Secret removed; models/channels/env replaced as a whole) | Low |
| `plugins-info.txt` | Installed plugin list and versions | Low |

3. **Remind the user**:
   - The config file is automatically redacted; sensitive information such as API Key and Token has been replaced with `***REDACTED***`
   - **Memory data (memory-tdai/) contains the original user conversation text**; confirm it can be shared before sending
   - The archive is stored locally and **is not uploaded automatically**; the user must send it to the dev team manually

### Step 4: Tell the user the next steps

After the export completes, tell the user:

1. The archive has been saved locally (print the specific path)
2. After reviewing the contents, send it manually to the dev team via WeCom/email or similar
3. If only part of the data is needed (e.g. only logs or only config), unpack it and send selectively

## Export Content Details

### OpenClaw log locations

| Log Type | Path | Description |
|---------|------|------|
| Gateway stdout | `~/.openclaw/logs/gateway.log` | Standard output of the gateway daemon |
| Gateway stderr | `~/.openclaw/logs/gateway.err.log` | Error output of the gateway daemon |
| Rolling logs | `/tmp/openclaw/openclaw-YYYY-MM-DD.log` | Rolled by date, JSON Lines format, auto-cleaned after 24h |
| Config audit | `~/.openclaw/logs/config-audit.jsonl` | Config write audit records |
| Command log | `~/.openclaw/logs/commands.log` | Command event log (hook optional) |

### Memory plugin data structure

```
~/.openclaw/memory-tdai/
├── conversations/          — L0 raw conversations (daily JSONL shards)
├── records/                — L1 structured memories (daily JSONL shards)
├── scene_blocks/           — L2 scene Markdown files
├── persona.md              — L3 user persona
├── vectors.db              — SQLite database (vectors + full-text index)
├── .metadata/              — checkpoint, scene_index.json
└── .backup/                — rolling backups
```

### Config redaction rules

The export script applies the following redaction to `openclaw.json`:

| Rule | Handling |
|------|---------|
| Field name matches `apiKey/token/password/secret/credential` and value is a string | Replaced with `***REDACTED(Nchars)***` |
| SecretRef object (containing source/provider/id) | id replaced with `***REDACTED***` |
| Top-level `models`, `secrets`, `channels`, `env` blocks | Replaced as a whole with `***REDACTED_SECTION***` |
| token/password under `gateway.auth` | Replaced with `***REDACTED***` |
| Other fields (including full `plugins` config) | **Kept as is** (plugin config is the focus of troubleshooting) |

## Manual Export (fallback when the script is unavailable)

If the export script cannot run (e.g. Node.js is unavailable), collect manually with the following steps:

```bash
# 1. Create the export directory
EXPORT_DIR=~/Downloads/openclaw-diagnostic-$(date +%Y%m%d-%H%M%S)
mkdir -p "$EXPORT_DIR"

# 2. Copy logs
cp -r ~/.openclaw/logs/ "$EXPORT_DIR/logs/" 2>/dev/null
cp /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log "$EXPORT_DIR/" 2>/dev/null

# 3. Copy memory plugin data
cp -r ~/.openclaw/memory-tdai/ "$EXPORT_DIR/memory-tdai/" 2>/dev/null

# 4. Manually redact the config (⚠️ you must manually delete sensitive fields!)
# Copy the config and use an editor to delete the models/secrets/channels blocks and all apiKey/token values
cp ~/.openclaw/openclaw.json "$EXPORT_DIR/openclaw-config-NEEDS-MANUAL-REDACTION.json"

# 5. Package
cd ~/Downloads && tar -czf "$EXPORT_DIR.tar.gz" "$(basename $EXPORT_DIR)"

echo "⚠️ Be sure to manually check and delete sensitive information in the config before sending!"
```

## Common Troubleshooting Clues

After exporting data, the dev team usually focuses on the following:

| Direction | File to Check | Key Information |
|---------|---------|---------|
| Is the plugin loaded | Search `[memory-tdai]` in `logs/` | Plugin registration and config parsing logs (note: the log tag is still `[memory-tdai]`, unrelated to the plugin ID) |
| Is memory recall working | Search `[recall]` in `logs/` | Search strategy, latency, hit count |
| Is L1 extraction triggered | Search `[pipeline]` in `logs/` | Scheduling triggers, L1/L2/L3 execution status |
| Is vector search available | `plugins.entries` in `openclaw-config-redacted.json` | Whether the embedding config is correct |
| Data volume/disk usage | `env-info.txt` | du output, file count |
| Checkpoint status | `memory-tdai/.metadata/recall_checkpoint.json` | Progress, cursor, counters |
