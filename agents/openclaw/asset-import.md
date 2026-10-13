# OpenClaw Asset Import

Import the local open-source OpenClaw **skills / sessions** into Memory Hub. This guide is all you need.


It scans the client's native data, not this project's `~/.openclaw/context-offload/*`.

## What is scanned

**Skill** (same name: user-defined overrides system built-in)

| Priority | Path |
|---|---|
| 1 | `~/.agents/skills/<name>/SKILL.md` |
| 2 | `~/npm-global/lib/node_modules/openclaw/skills/<name>/SKILL.md` |

May include `scripts/` `references/` `assets/` `agents/`. Not scanned: workspace / `~/.openclaw/skills` / extraDirs.

**Memory**: local files are no longer scanned; memory is extracted from Sessions only (see below).

**Session** (`$OPENCLAW_STATE_DIR/agents/<id>/sessions/`, default `~/.openclaw`)

Imports the `<sessionId>.jsonl` files one level down. Not scanned: `sessions.json`, `*.trajectory.jsonl`, `*.lock`, sqlite.

## Prerequisites

Run from the repo root. Requires Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
# Optional: OPENCLAW_STATE_DIR / OPENCLAW_WORKSPACE_DIR
```

`--agent-id` / `--team-id` are required; the owner must match the user resolved from `TDAI_USER_KEY`.

## Usage

The unified entry point is `agents/asset-import.ts` at the repo root. Use `--source openclaw` to select the IDE this guide covers; when omitted, it defaults to `auto`, which detects the IDE used by the current workspace.

```bash
# Interactive import: first lists the items to import -- skills (number/name/description/source/related script count) and sessions (id/time range/project path), then lets you choose "import all / import none / import some" (for partial import, enter numbers or IDs, separated by commas/spaces, multiple allowed)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI, imports everything without prompting)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source openclaw --workspace /path/to/workspace --agent-id <id> --team-id <tid>

# Re-import (ignore resume checkpoints and re-import already imported items)
tsx agents/asset-import.ts --source openclaw --agent-id <id> --team-id <tid> --force

```
