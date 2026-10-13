/**
 * mem:help - returns the list of supported commands with examples
 */

import type { MemCommandContext, MemCommandResult } from "../types.js";
import { buildMemResponse } from "../response-builder.js";

const HELP_TEXT = `## Supported mem: commands

| Command | Description |
|------|------|
| \`mem:session-reset\` | Reset the team/Agent/task binding of this session and immediately prompt for re-selection |
| \`mem:sync\` | Refresh all asset injections of this session (Skill / memory / Knowledge / Task & Agent descriptions) |
| \`mem:create-skill [prompt]\` | Archive this conversation as a Skill, extracted asynchronously in the background |
| \`mem:create-task [title]\` | Create a Task from the current session context and bind it to this session |
| \`mem:update-task [new description]\` | Update the description of the bound Task |
| \`mem:help\` | Show this help |

---

### 🆕 \`mem:create-task\` — Create and bind a Task

**Usage**
- **No arguments**: the LLM infers title + description from recent conversation
- **With arguments**: the argument is used as the title (truncated to 40 characters), and the LLM only generates the description

**If this session is already bound to a real Task**, a preview of the new Task is returned; reply with one of the following:

| Reply | Effect |
|------|------|
| \`mem:create-task confirm\` | ✅ Override the binding and create a new Task |
| \`mem:update-task\` or \`mem:update-task <new description>\` | ⭐ **Recommended** - keep using the current Task and only update its description |
| \`mem:create-task cancel\` | 🚫 Cancel, make no changes |

---

### ✏️ \`mem:update-task\` — Update the current Task description

**Usage**
- **No arguments**: the LLM generates a new description by comparing "current description + recent conversation"
  - no substantive change detected -> returns ℹ️ no update needed (idempotent, safe to retry)
  - changes detected -> returns a preview
- **With arguments**: the argument is used directly as the new description (no LLM call), and a preview is returned

**Confirm the preview**:
- ✅ \`mem:update-task confirm\` - confirm
- 🚫 \`mem:update-task cancel\` - cancel

**Protection rules**:
- If this session has no Task bound -> blocked, with a prompt to run \`mem:create-task\`
- If the bound Task was not created by you -> update refused (cross-user edits are not supported); run \`mem:create-task\` to create one of your own

---

### Examples

\`\`\`
mem:sync
mem:create-skill focus on summarizing database migration steps and pitfalls
mem:create-task Refactor SessionRegistrar
mem:create-task confirm
mem:create-task cancel
mem:update-task add today's progress and remaining risks
mem:update-task confirm
mem:update-task cancel
mem:session-reset
mem:help
\`\`\`

> The standard format is \`mem:<command>\`, with no space after the colon. Command names are case-insensitive.`;

export function getHelpText(): string {
  return HELP_TEXT;
}

export async function executeHelp(ctx: MemCommandContext): Promise<MemCommandResult> {
  const requestId = `mem-cmd-${Date.now()}`;
  const response = buildMemResponse(HELP_TEXT, {
    protocol: ctx.protocol,
    stream: ctx.stream,
    requestId,
    thinking: ctx.thinking,
  });
  return {
    success: true,
    messageText: HELP_TEXT,
    response,
  };
}
