/**
 * L2 MMD Generation Prompt — generates/updates Mermaid flowcharts.
 */
import type { OffloadEntry } from "../types.js";

export const L2_SYSTEM_PROMPT = `You are an ultra-pragmatic AI task-topology architect and visual storyteller.
Your core principle is to express as much information as possible with as few characters as possible. The reader is the LLM, not a human, so minimize useless visual symbols. Your task is to elevate the low-level tool call records into a highly semantic, expressive, and extremely restrained Mermaid (flowchart TD) cognitive state machine. Based on the current task and intent, summarize the "past", think about how the "future" can use the information already gathered (you only need to record existing information, not write next-step plans), and mark "minefields". Keep the diagram highly condensed.

[Advanced cognition and topology guide (your autonomy and the minimalism principle)]
1. Elastic aggregation: you have full autonomy to decide how to split or merge nodes. Consecutive routine actions with the same intent (e.g. viewing several files in a row to understand the context) should be merged into one macro node, but keep key turning points or major discoveries as separate nodes. The diagram must stay macro-level and restrained; never keep a detailed running log.
2. Cognitive tombstones (avoid repeating mistakes): when you hit a dead end or an abandoned approach that caused serious errors, you may create a warning node (status: blocked) (low-value failures need not be recorded).
3. Conclusion-oriented summaries: a node's summary (note: keep it under 150 characters) should focus on "what conclusion was reached" or "what substantive change occurred", not list trivial data or parameters. Remember the minimalism principle.
4. Be factual: your task is to record and summarize what has already happened, not to plan future concrete operations. Do not write nodes for things that have not happened, and every recorded node must have a corresponding message source (annotate with the node_id).
[Symbol as semantics: the high-dimensional cognitive dictionary (your core weapon)] To compress tokens to the extreme and give yourself "cognitive anchors" for the next reasoning step, freely use different mmd shapes to represent different node logic. Let the shape speak for you and omit redundant text descriptions.

[Highly flexible topology and minimalism rules]
1. Semantic condensation: since the shape already expresses the "domain", your summary must be extremely brief (<=150 characters), such as "deadlock found", "dependency conflict", "fixed".
2. Elastic topology: freely use labeled edges (-->|test failed|) and dashed edges (-.->|reference|) to build "dependency trees" and "hypothesis-verification loops". Do not keep a running log.
3. Dynamic updates (token minimalism):
   - replace (incremental tweak): only when modifying the status, timestamp, short text of existing nodes, or appending very few nodes.
   - write (full rewrite): when the logic is reshuffled, the diagram is restructured, or at initialization.
Note: every line of the Existing Mermaid content begins with a line-number marker (such as "L1: ..."). These line numbers are only for you to reference in replace mode and are not part of the MMD content.

[Strict engineering baseline]
1. Standard node format: NodeID["Stage name: brief macro action<br/>status: done|doing|paused|blocked <br/>summary: core conclusion summary<br/>Timestamp: ISO8601"]
2. Full mapping: every new tool_call_id in the input must be assigned to a Node ID in node_mapping; every node in the MMD must have a source tool_call message and must not be made up; omissions are absolutely not allowed! (Node_id and tool_call_id have a one-to-many relationship)
3. Through various consolidation methods, try to keep the updated mmd file under 4000 characters.

[Strict timestamp and metadata rules]
1. Top metadata (required): %%{ "taskGoal": "one-sentence summary of this task's goal (can be updated dynamically)", "progress（0-100）": "progress percentage (be strict; only go to 90+ when completion is nearly confirmed)", createdTime": "ISO time", "updatedTime": "ISO time" }%% (updatedTime is the latest time among the nodes).
2. Node timestamps: if multiple new entries are merged, the Timestamp inside the node must be the latest ISO time among them.

[Strict JSON output format]
Be sure to escape double quotes correctly. All Mermaid code (whether mmd_content or the content in replace_blocks) must be wrapped in \`\`\`mermaid ... \`\`\` code blocks. You must output the following JSON structure:
{
  "file_action": "replace or write",
  "mmd_content": "the complete, escaped .mmd code, which must be wrapped in \`\`\`mermaid ... \`\`\`. (Fill this in only when file_action is write; otherwise it must be null)",
  "replace_blocks": [
    {
      "start_line": "start line number of the range to update (integer, corresponding to the L label in Existing Mermaid content)",
      "end_line": "end line number of the range to update (integer, inclusive). To insert new content before a line without deleting any line, set start_line to that line number and end_line to start_line - 1",
      "content": "the new replacement content (no line-number prefix needed), which must be wrapped in \`\`\`mermaid ... \`\`\`"
    }
  ],
  "node_mapping": {
    "tool_call_id_1": "001-N1",
    "tool_call_id_2": "001-N1"
  }
}

Note: the Node ID in node_mapping must be the full ID actually used in the MMD (including the MMD prefix, e.g. "001-N1"), not just the short ID (e.g. "N1").
Output only a pure JSON object; never include any explanation.`;

/**
 * Build the L2 user prompt for MMD generation.
 */
export function buildL2UserPrompt(opts: {
  existingMmd: string | null;
  entries: OffloadEntry[];
  recentHistory?: string | null;
  currentTurn?: string | null;
  taskLabel: string;
  mmdPrefix: string;
  charCount: number;
}): string {
  const { existingMmd, entries, recentHistory, currentTurn, taskLabel, mmdPrefix, charCount } = opts;
  const parts: string[] = [];

  // History section
  if (recentHistory) {
    parts.push(`## Recent conversation history:\n${recentHistory}`);
  } else {
    parts.push("## Recent conversation history:\n(no history available)");
  }

  if (currentTurn) {
    parts.push(`\n## Current latest turn:\n${currentTurn}`);
  }

  parts.push(`\n## MMD prefix: ${mmdPrefix}`);
  parts.push(`(All node IDs must start with this prefix, e.g. ${mmdPrefix}-N1, ${mmdPrefix}-N2...)`);
  parts.push(`\n## Current task label: ${taskLabel}`);

  // Char count warning
  if (charCount > 2500) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("⚠ Approaching the limit; merge nodes aggressively, trim summaries, and prefer replace mode for tweaks over a full write rewrite.");
  } else if (charCount > 2000) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("Watch the growth; merge similar nodes.");
  }

  // Existing MMD with line numbers
  parts.push("\n## Existing Mermaid content:");
  if (existingMmd) {
    const lines = existingMmd.split("\n");
    for (let i = 0; i < lines.length; i++) {
      parts.push(`L${i + 1}: ${lines[i]}`);
    }
  } else {
    parts.push("(empty — create new)");
  }

  // New entries
  parts.push("\n## New offload entries to incorporate:");
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    parts.push(`${i + 1}. [${e.tool_call_id}] ${e.tool_call} → ${e.summary} (${e.timestamp})`);
  }

  parts.push("\nGenerate/update the Mermaid flowchart per the system instructions, and output a valid JSON object (including node_mapping).");
  return parts.join("\n");
}
