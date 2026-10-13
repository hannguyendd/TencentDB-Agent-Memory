# Hermes Asset Import

Import the local Hermes Agent **skills / sessions** into Memory Hub. This guide is all you need.


Data root `$HERMES_HOME` (default `~/.hermes`). Sessions are read from SQLite and require **Node >= 22** (`node:sqlite`).

## What is scanned

**Skill** (same name: the global one overrides the repo built-in; subdirectories containing `SKILL.md`, deeper categories allowed such as `mlops/inference/llama-cpp`)

| Priority | Path |
|---|---|
| 1 | `$HERMES_HOME/skills/<category>/<name>/SKILL.md` |
| 2 | `<hermes-agent repo>/skills/` |
| 3 | `<hermes-agent repo>/optional-skills/` |

Repo root: `HERMES_AGENT_ROOT`, otherwise `$HERMES_HOME/hermes-agent`. `HERMES_BUNDLED_SKILLS` / `HERMES_OPTIONAL_SKILLS` are also recognized.

Not scanned: project `.hermes/skills` / `.agents/skills`, `skills.external_dirs`, `.hub`, pending, and `SKILL.md` files nested under `references/`.

**Memory**: local files are no longer scanned; memory is extracted from Sessions only (see below).

**Session**

| Storage | Path | Imported? |
|---|---|---|
| Main DB | `$HERMES_HOME/state.db` | Yes: `sessions` metadata + `user`/`assistant` rows from `messages` |
| Raw dump | `$HERMES_HOME/sessions/request_dump_*.json` | No |

Not scanned: `session_{sid}.json`, `moa-traces/`. `--workspace` does not restrict sessions. Below Node 22, session scanning is skipped.

## Prerequisites

Run from the repo root:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
# Optional: HERMES_HOME / HERMES_AGENT_ROOT
```

`--agent-id` / `--team-id` are required. If a skill lives in the repo's `optional-skills/`, point `--workspace` at the hermes-agent repo root, or set `HERMES_AGENT_ROOT`.

## Usage

The unified entry point is `agents/asset-import.ts` at the repo root. Use `--source hermes` to select the IDE this guide covers; when omitted, it defaults to `auto`, which detects the IDE used by the current workspace.

```bash
# Interactive import: first lists the items to import -- skills (number/name/description/source/related script count) and sessions (id/time range/project path), then lets you choose "import all / import none / import some" (for partial import, enter numbers or IDs, separated by commas/spaces, multiple allowed)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI, imports everything without prompting)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source hermes --workspace /path/to/hermes-agent --agent-id <id> --team-id <tid>

# Re-import (ignore resume checkpoints and re-import already imported items)
tsx agents/asset-import.ts --source hermes --agent-id <id> --team-id <tid> --force

```
