/**
 * L1.5 Task Judgment Prompt — migrated from context-offload-server.
 *
 * Determines task lifecycle: completion, continuation, new task detection.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L15_SYSTEM_PROMPT = `You are the "task lifecycle gatekeeper" for an AI coding assistant.
Your responsibility is to cross-analyze the three provided input sources, precisely judge the task state, and output a pure JSON object.

[Input data usage guide (the chain of thought you must follow)]
1. Step 1 - Analyze recentMessages (identify intent): based on the current and historical conversation, extract the core request of the user's latest reply. Decide whether it is "continue troubleshooting", "declare completion (e.g. it works now)", "single-turn chit-chat Q&A", or "start a brand-new requirement".
2. Step 2 - Align with currentMmd (assess the current baseline): compare the user's latest intent with the full Mermaid content of currentMmd -- pay attention to taskGoal, the status of each node (done/doing/todo), and the summary. If the request is entirely beyond the scope of the current diagram or the goal has been achieved (all nodes done with no follow-up), then taskCompleted is true. If it is still about solving sub-problems in the diagram (including doing nodes or fixing bugs), it is false. (If there is no currentMmd, judge whether to continue the task based only on the current and historical conversation)
3. Step 3 - Search availableMmds (decide whether it is a continuation): if you determine a new task should be started (isLongTask=true and taskCompleted=true / there is currently no task), you must scan the taskGoal and time information of availableMmds. If the new request highly overlaps with an old task in the list (e.g. returning to a module left unfinished yesterday), it is a continuation (isContinuation=true).

[Strict JSON output format]
Be sure to output a valid pure JSON object in the following format:
{
  "taskCompleted": boolean, // whether the current task has ended (if currentMmd is none, this must be true)
  "isLongTask": boolean,    // whether the latest request is a complex engineering job requiring multi-step operations (ordinary technical Q&A and chit-chat: false)
  "isContinuation": boolean, // whether it continues a historical task in availableMmds
  "continuationMmdFile": "string|null", // if continuing an old task, fill in the exact file name in availableMmds (without the path prefix), otherwise null
  "newTaskLabel": "string|null" // if it is a brand-new long task, generate a short label (≤30 characters, kebab-case, e.g. "refactor-api"), otherwise null
}

Output only a pure JSON object; never include explanatory text.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L15CurrentMmd {
  filename: string;
  content: string;
  path: string;
}

export interface L15MmdMeta {
  filename: string;
  path: string;
  taskGoal: string;
  doneCount: number;
  doingCount: number;
  todoCount: number;
  updatedTime?: string | null;
  nodeSummaries?: Array<{ nodeId: string; status: string; summary: string }>;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1.5 user prompt for task judgment.
 * Mirrors context-offload-server/internal/service/prompt/BuildL15UserPrompt.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: L15MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. Recent conversation context (Recent 6 messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. Currently mounted task diagram (Active Mermaid — full content):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    if (currentMmd.path) {
      parts.push(`**Path:** \`${currentMmd.path}\``);
    }
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - currently idle, no active task)");
  }

  parts.push("\n## 3. Available historical task diagrams (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - no historical long tasks yet)");
  } else {
    for (const m of metas) {
      parts.push(`- **${m.filename}**`);
      parts.push(`  path: \`${m.path}\``);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`);
      if (m.updatedTime) {
        parts.push(`  lastUpdated: ${m.updatedTime}`);
      }
      if (m.nodeSummaries && m.nodeSummaries.length > 0) {
        parts.push("  recentNodes:");
        for (const n of m.nodeSummaries) {
          parts.push(`    - [${n.nodeId}] (${n.status}) ${n.summary}`);
        }
      }
      parts.push("");
    }
  }

  parts.push("Strictly follow the [three-step chain of thought] in the system instructions to make your judgment, and output a valid JSON object.");
  return parts.join("\n");
}
