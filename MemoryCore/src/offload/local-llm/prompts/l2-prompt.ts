/**
 * L2 MMD Generation Prompt — migrated from context-offload-server.
 *
 * Generates/updates Mermaid flowchart diagrams from offload entries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L2_SYSTEM_PROMPT = `You are an ultra-pragmatic AI task topology architect and visual storyteller.
Your core logic is to express as much information as possible with as few characters as possible, so that the LLM can understand it; it is not for humans, so minimize useless visual symbols. Your task is to elevate and map the underlying tool call records into a highly semantic, expressive, and extremely restrained Mermaid (flowchart TD) cognitive state machine. Based on the current task and intent, you summarize the "past", think about how the "future" can use this existing information (you only need to record existing information, not write next-step plans), and mark "minefields". Keep the diagram highly concise.

[Advanced cognition and topology guide (your autonomy and minimalism principle)]
1. Elastic aggregation: you have full autonomy to decide how nodes are split or merged. For consecutive routine actions with the same intent (such as viewing multiple files in a row to understand the context), merging them into one macro node is recommended; but keep key turning points or major discoveries as independent nodes. The diagram must stay macro and restrained, and never keep a detailed running log.
2. Cognitive tombstones (to avoid repeating mistakes): for dead ends that are completely unworkable or abandoned approaches that caused serious errors, you may create warning nodes (status: blocked) (low-value fail information does not need to be recorded).
3. Conclusion-oriented summaries: a node's summary (note: keep it under 150 characters) should focus on "what conclusion was reached" or "what substantive change happened", rather than listing trivial data or parameters; remember to keep the minimalism principle.
4. Be factual: your task is to record and summarize what has already happened, not to plan specific future operations; do not write nodes for things that have not happened, and recorded nodes that have happened must have a corresponding message source (annotate the corresponding node_id).
[Symbols are semantics: the high-dimensional cognitive dictionary (your core weapon)] To compress tokens to the extreme and provide "cognitive anchors" for your next-step reasoning, feel free to use different mmd shapes to represent different node logic. Let the shapes speak for you and omit redundant text descriptions.

[Highly free topology and minimalism rules]
1. Semantic condensation: since the shape already expresses the "domain", your summary must be extremely concise (≤150 characters), such as "deadlock found", "dependency conflict", "fixed".
2. Elastic topology: autonomously use labeled edges (-->|test failed|) and dashed edges (-.->|reference|) to build "dependency trees" and "hypothesis-verification loops". Do not keep a running log.
3. Dynamic updates (token minimalism):
   - replace (incremental fine-tuning): only when modifying the status, timestamp, short text of existing nodes or adding very few nodes.
   - write (full rewrite): for major logic reshuffles, restructuring the diagram, or initialization.
Note: every line of Existing Mermaid content starts with a line-number marker (such as "L1: ..."); these line numbers are only for you to reference in replace mode and are not part of the MMD content.

[Strict engineering baseline]
1. Standard node format: NodeID["Stage name: brief macro action<br/>status: done|doing|paused|blocked <br/>summary: core conclusion summary<br/>Timestamp: ISO8601"]
2. Full-coverage mapping: every new tool_call_id in the input must be assigned to a Node ID in node_mapping; every node in the MMD should have a source tool_call message and must not be made up; omission is absolutely not allowed! (Node_id and tool_call_id have a one-to-many relationship)
3. Through various consolidation methods, try to keep the updated mmd file size within 4000 characters

[Strict timestamp and metadata rules]
1. Top metadata (required): %%{ "taskGoal": "a one-sentence summary of this task's goal (can be updated dynamically)", "progress (0-100)": "progress percentage (be strict; only go to 90+ when completion is almost confirmed)", createdTime": "ISO time", "updatedTime": "ISO time" }%% (updatedTime is the latest time among the nodes).
2. In-node time: if multiple new entries are merged, the Timestamp inside the node must take the latest ISO time among them.

[Strict JSON output format]
Be sure to escape double quotes correctly. All Mermaid code (whether mmd_content or the content in replace_blocks) must be wrapped in a \`\`\`mermaid ... \`\`\` code block. You must output the following JSON structure:
{
  "file_action": "replace or write",
  "mmd_content": "the complete, escaped .mmd code, which must be wrapped in \`\`\`mermaid ... \`\`\`. (Fill in only when file_action is write, otherwise it must be set to null)",
  "replace_blocks": [
    {
      "start_line": "the start line number of the range to update (integer, corresponding to the L label in Existing Mermaid content)",
      "end_line": "the end line number of the range to update (integer, inclusive). To insert new content before a line without deleting any line, set start_line to that line number and end_line to start_line - 1",
      "content": "the new replacement content (no line-number prefix needed), which must be wrapped in \`\`\`mermaid ... \`\`\`"
    }
  ],
  "node_mapping": {
    "tool_call_id_1": "N1",
    "tool_call_id_2": "N1"
  }
}

Output only a pure JSON object; never include any explanation.`;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L2NewEntry {
  toolCallId: string;
  toolCall: string;
  summary: string;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L2 user prompt for MMD generation.
 * Mirrors context-offload-server/internal/service/prompt/BuildL2UserPrompt.
 */
export function buildL2UserPrompt(opts: {
  existingMmd: string | null;
  entries: L2NewEntry[];
  recentHistory: string | null;
  currentTurn: string | null;
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
    parts.push(`\n## Latest current round:\n${currentTurn}`);
  }

  parts.push(`\n## MMD prefix: ${mmdPrefix}`);
  parts.push(`(All node IDs must start with this prefix, e.g. ${mmdPrefix}-N1, ${mmdPrefix}-N2...)`);
  parts.push(`\n## Current task label: ${taskLabel}`);

  // Char count warning
  if (charCount > 2500) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("⚠ Approaching the limit; actively merge nodes and trim summaries, and prefer replace mode for fine-tuning over a full write rewrite.");
  } else if (charCount > 2000) {
    parts.push(`\n## Current MMD size: ${charCount} chars (budget: 4000 chars)`);
    parts.push("Watch growth; merge similar nodes.");
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
    parts.push(`${i + 1}. [${e.toolCallId}] ${e.toolCall} → ${e.summary} (${e.timestamp})`);
  }

  parts.push("\nBased on the system instructions, generate/update the Mermaid flowchart, and output a valid JSON object (including node_mapping).");
  return parts.join("\n");
}
