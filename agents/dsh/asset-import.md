# DeepSeek Harness Asset Import

Import the local dsh **skills / sessions** into Memory Hub. This guide is all you need.

Data root `$DSH_HOME` (default `~/.dsh`). Project root = the nearest ancestor containing `.git`; if none is found, use `--workspace` / cwd.

## What is scanned

**Skill** (for same-named skills, the smaller rank number wins; only one level is scanned, no recursive `**/SKILL.md`)

| Rank | Path |
|---|---|
| 100 | `<project root>/.dsh/skills/` |
| 200 | `<project root>/.agents/skills/` |
| 300 | `customSkillDirs` in `settings.yaml`, or `DSH_CUSTOM_SKILL_DIRS` |
| 400 | `$DSH_HOME/skills/` (skipping `.system`) |
| 500 | `~/.agents/skills/` (the root can be changed with `DSH_AGENTS_HOME`) |
| 600 | `$DSH_BUNDLED_SKILL_DIR` / settings `bundledSkillDir` (skipped if not configured) |

Directory style `<name>/SKILL.md` or flat `<name>.md`.

**Memory**: local files are no longer scanned; memory is extracted only from Sessions (see below).

**Session**

Recursively scans `$DSH_HOME/sessions/**/session.jsonl.zstd` (or `session.jsonl` if uncompressed). `--workspace` does not affect sessions; `--sessions` can change the scan root. Only `user/message` + `assistant/message` are parsed; empty sessions are skipped.

## Prerequisites

Run from the repo root. Requires Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<sk-mem-... of that agent's owner>
# Optional: DSH_HOME / DSH_AGENTS_HOME / DSH_CUSTOM_SKILL_DIRS / DSH_BUNDLED_SKILL_DIR
```

`--agent-id` / `--team-id` are required.

## Usage

The unified entry point is `agents/asset-import.ts` at the repo root. Use `--source dsh` to specify the IDE this guide covers; when omitted it defaults to `auto`, which automatically detects the IDE used by the current workspace.

```bash
# Interactive import: first list the items to import -- skills (number/name/description/source/linked script count), sessions (id/time range/project path), then choose "Import all / Import none / Import some" (for some, enter numbers or IDs, separated by commas/spaces, multiple allowed)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI, import everything directly without prompting)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source dsh --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume-from-checkpoint, re-import already imported items)
tsx agents/asset-import.ts --source dsh --agent-id <id> --team-id <tid> --force

```


