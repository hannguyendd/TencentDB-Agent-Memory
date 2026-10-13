/**
 * L1 Summarization Prompt — migrated from context-offload-server.
 *
 * Converts tool call/result pairs into high-density JSON summaries.
 */

// ─── System Prompt ───────────────────────────────────────────────────────────

export const L1_SYSTEM_PROMPT = `You are a "tool result summarizer" built for an AI coding assistant. Your core task is to deeply understand the current conversation context and distill the verbose tool calls and execution results (one toolcall and its tool result merged into a single summary output) into a high-information-density JSON array.

Before generating the summary, you must carry out the following internal reasoning:
1. Task alignment: combining the recent conversation, identify the user's current core goal and latest intent. If the context conflicts, always go with the latest user intent.
2. Value filtering: ignore redundant details of how the tool works, and directly extract "what key clue was found", "what key action was taken", "what specific content was modified", or "what specific error was encountered".
3. Impact assessment: judge the substantive impact of the result on the current task (for example: confirmed a hypothesis, advanced a certain step, led to a decision, or caused a blockage due to an error).

[Output format requirements]
You must output, and may only output, a valid JSON object array [{...}], where every object **must** contain the following fields:
- "tool_call": a concise description of the tool call. Rules:
  · If the tool pair is marked [NEEDS_COMPRESS] in the input, you must compress the tool name + key parameters into one concise description (≤150 characters), keeping the tool name and the operation target (such as file path, command intent), and omitting the details of inline scripts/large content.
    Example: exec({"command":"python3 -c 'import csv; ...200-line script...'"}) → "exec: run a Python script (xx/xx/xx.sh, state the specific path and file) to analyze the data quality of sales_channels.csv"
    Example: write_file({"path":"/root/app.py","content":"...5000 characters..."}) → "write_file: write /root/app.py (main file of the Flask app), roughly containing ..."
  · If not marked [NEEDS_COMPRESS], simply describe the tool and parameters briefly (the system will overwrite it with the original values).
- "summary": a refined summary that fuses the reasoning above (≤200 characters). It must get straight to the point about the business value of the result and its role in advancing/blocking the task.
- "tool_call_id": the original tool_call_id (must be passed through unchanged).
- "timestamp": the original China Standard Time (+08:00) ISO 8601 timestamp (must be passed through unchanged).
- "score" (**required**): based on information density and the task purpose, analyze how well the summary can substitute for the original text, in the range 0-10; the closer to 10, the better the summary can substitute for the original.

[Strict rules]
Output only a pure JSON array; never output the reasoning process or other explanatory text.`;

// ─── Constants ───────────────────────────────────────────────────────────────

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface L1ToolPair {
  toolName: string;
  toolCallId: string;
  params: unknown;
  result: unknown;
  timestamp: string;
}

// ─── User Prompt Builder ─────────────────────────────────────────────────────

/**
 * Build the L1 user prompt for summarization.
 * Mirrors context-offload-server/internal/service/prompt/BuildL1UserPrompt.
 */
export function buildL1UserPrompt(recentMessages: string, pairs: L1ToolPair[]): string {
  const parts: string[] = [];

  parts.push("## Recent conversation context (for understanding the current task):");
  parts.push(recentMessages);
  parts.push("\n## Tool call/result pairs to summarize:");

  for (let i = 0; i < pairs.length; i++) {
    const p = pairs[i];
    const paramsStr = truncate(stringify(p.params), PARAMS_MAX_LEN);
    const resultStr = truncate(stringify(p.result), RESULT_MAX_LEN);
    const canonical = `${p.toolName}(${stringify(p.params)})`;
    const needsCompress = canonical.length > COMPRESS_THRESHOLD;

    parts.push(`--- Tool Pair ${i + 1} ---`);
    parts.push(`tool_call_id: ${p.toolCallId}`);
    parts.push(`timestamp: ${p.timestamp}`);
    if (needsCompress) {
      parts.push(`Tool: ${p.toolName} [NEEDS_COMPRESS]`);
    } else {
      parts.push(`Tool: ${p.toolName}`);
    }
    parts.push(`Params: ${paramsStr}`);
    parts.push(`Result: ${resultStr}\n`);
  }

  parts.push("Summarize each pair into the JSON array format described.");
  return parts.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stringify(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "...";
}
