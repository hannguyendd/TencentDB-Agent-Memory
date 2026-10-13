# CodeBuddy Asset Import

Import the local CodeBuddy **skills / sessions** into Memory Hub. This guide is all you need.


## What is scanned

| Type | Path |
|---|---|
| Skill | `~/.codebuddy/skills/*/SKILL.md`; project `<cwd>/.codebuddy/skills/*/SKILL.md` |
| Session | `~/.codebuddy/projects/<project>/*.jsonl` |

`--workspace` changes the project-side path to that directory (the global `~/.codebuddy` is not excluded).

## Prerequisites

Run from the repo root. Requires Node >= 22, plus:

```bash
export PANEL_URL=http://127.0.0.1:8123
export TDAI_SERVICE_ID=<spaceId>
export TDAI_USER_KEY=<the agent owner's sk-mem-...>
```

`--agent-id` / `--team-id` are required; the owner must match the user resolved from `TDAI_USER_KEY`.

## Usage

The unified entry point is `agents/asset-import.ts` at the repo root. Use `--source codebuddy` to select the IDE this guide covers; when omitted, it defaults to `auto`, which detects the IDE used by the current workspace.

```bash
# Interactive import: first lists the items to import -- skills (number/name/description/source/related script count) and sessions (id/time range/project path), then lets you choose "import all / import none / import some" (for partial import, enter numbers or IDs, separated by commas/spaces, multiple allowed)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid>

# Non-interactive (scripts/CI, imports everything without prompting)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid> -y

# Specify the project directory
tsx agents/asset-import.ts --source codebuddy --workspace /path/to/repo --agent-id <id> --team-id <tid>

# Re-import (ignore resume checkpoints and re-import already imported items)
tsx agents/asset-import.ts --source codebuddy --agent-id <id> --team-id <tid> --force

```


