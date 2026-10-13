/**
 * L1.5 Task Judgment Prompt — determines task lifecycle.
 */
import type { MmdMeta } from "../types.js";

export const L15_SYSTEM_PROMPT = `You are the "task lifecycle gatekeeper" for an AI coding assistant.
Your job is to cross-analyze the three provided input sources, accurately judge the task state, and output a pure JSON object.

[Input usage guide (the chain of thought you must follow)]
1. Step 1 - Analyze recentMessages (identify intent): from the current and historical conversation, extract the core request of the user's latest reply. Decide whether it is "continue investigating", "declare completion (e.g. 'it works now')", "single-turn casual Q&A", or "start a brand-new requirement".
2. Step 2 - Align with currentMmd (assess the current baseline): compare the user's latest intent against the full Mermaid content of currentMmd, paying attention to taskGoal, each node's status (done/doing/todo), and summary. If the request is entirely outside the scope of the current diagram or the goal has been achieved (all nodes done with no follow-up), taskCompleted is true. If it is still about solving a sub-problem in the diagram (including doing nodes or bug fixes), it is false. (If there is no currentMmd, judge whether to continue the task based only on the current and historical conversation.)
3. Step 3 - Search availableMmds (decide whether it is a continuation): if you determine that a new task is starting (isLongTask=true and taskCompleted=true / there is currently no task), you must scan the taskGoal and time information in availableMmds. If the new request strongly overlaps with an old task in the list (e.g. returning to a module left unfinished yesterday), it is a continuation (isContinuation=true).

[Strict JSON output format]
Be sure to output a valid pure JSON object in the following format:
{
  "taskCompleted": boolean, // whether the current task has ended (if currentMmd is none, this must be true)
  "isLongTask": boolean,    // whether the latest request is a complex piece of work requiring multiple steps (ordinary technical Q&A or casual chat: false)
  "isContinuation": boolean, // whether it continues a historical task in availableMmds
  "continuationMmdFile": "string|null", // if continuing an old task, fill in the exact file name from availableMmds (without path prefix), otherwise null
  "newTaskLabel": "string|null" // if it is a brand-new long task, generate a short label (<=30 characters, kebab-case, e.g. "refactor-api"), otherwise null
}

Output only a pure JSON object; never include explanatory text.`;

export interface L15CurrentMmd {
  filename: string;
  content: string;
}

/**
 * Build the L1.5 user prompt for task judgment.
 */
export function buildL15UserPrompt(
  recentMessages: string,
  currentMmd: L15CurrentMmd | null,
  metas: MmdMeta[],
): string {
  const parts: string[] = [];

  parts.push("## 1. Recent conversation context (Recent messages):");
  parts.push(recentMessages);
  parts.push("\n## 2. Currently attached task graph (Active Mermaid — full content):");

  if (currentMmd && currentMmd.filename) {
    parts.push(`**File:** ${currentMmd.filename}`);
    parts.push(`\n\`\`\`mermaid\n${currentMmd.content}\n\`\`\``);
  } else {
    parts.push("(none - currently idle, no active task)");
  }

  parts.push("\n## 3. Available historical task graphs (Available Mermaid task files):");

  if (metas.length === 0) {
    parts.push("(none - no historical long tasks yet)");
  } else {
    for (const m of metas) {
      const total = m.doneCount + m.doingCount + m.todoCount;
      parts.push(`- **${m.filename}**`);
      parts.push(`  taskGoal: ${m.taskGoal}`);
      parts.push(
        `  progress: ${m.doneCount}/${total} done, ${m.doingCount} doing, ${m.todoCount} todo`,
      );
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

  parts.push(
    "Judge strictly according to the [three-step chain of thought] in the system instructions, and output a valid JSON object.",
  );
  return parts.join("\n");
}
