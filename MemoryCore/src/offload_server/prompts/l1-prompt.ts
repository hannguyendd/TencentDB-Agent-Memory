/**
 * L1 Summarization Prompt — converts ToolPairs into OffloadEntry summaries.
 */
import type { ToolPair } from "../types.js";

const PARAMS_MAX_LEN = 500;
const RESULT_MAX_LEN = 2000;
const COMPRESS_THRESHOLD = 200;

export const L1_SYSTEM_PROMPT = `You are a "tool result summarizer" built for an AI coding assistant. Your core task is to deeply understand the current conversation context and distill verbose tool calls and execution results (one toolcall and its tool result merged into a single summary output) into a high-information-density JSON array.

Before generating a summary, be sure to think through the following internally:
1. Task alignment: using the recent conversation, identify the user's current core goal and latest intent. If the context conflicts, always follow the latest user intent.
2. Value filtering: ignore redundant details about how the tool works, and directly extract "what key clue was found", "what key action was taken", "what specific content was changed", or "what specific error was encountered".
3. Impact assessment: judge the substantive impact of this result on the current task (e.g. confirmed a hypothesis, advanced a certain step, led to a decision, or caused a blockage because of some error).

[Output format requirements]
You must output, and only output, a valid JSON array of objects [{...}], where each object **must** contain the following fields:
- "tool_call": a concise description of the tool call. Rules:
  · If the input marks this tool pair with [NEEDS_COMPRESS], you must compress the tool name + key parameters into one concise description (<=150 characters), keeping the tool name and the operation target (such as file path or command intent) and omitting the details of inline scripts/large content.
    Example: exec({"command":"python3 -c 'import csv; ...200-line script...'"}) → "exec: run a Python script (xx/xx/xx.sh; state the specific path and file) to analyze the data quality of sales_channels.csv"
    Example: write_file({"path":"/root/app.py","content":"...5000 characters..."}) → "write_file: write /root/app.py (main file of the Flask app), roughly containing ..."
  · If [NEEDS_COMPRESS] is not marked, simply describe the tool and parameters briefly (the system will overwrite it with the original value).
- "summary": a refined summary that incorporates the above thinking (<=200 characters). It must get straight to the point about the business value of the result and its effect of advancing/blocking the task.
- "tool_call_id": the original tool_call_id (must be passed through verbatim).
- "timestamp": the original ISO 8601 timestamp (must be passed through verbatim).
- "score" (**required**): analyze how well the summary can substitute for the original text, based on information density and the task's purpose, in the range 0-10; the closer to 10, the better the summary can replace the original.

[Strict rules]
Output only a pure JSON array; never output the thinking process or any other explanatory text.`;

/**
 * Build the L1 user prompt for summarization.
 */
export function buildL1UserPrompt(
  recentContext: string,
  pairs: ToolPair[],
): string {
  const parts: string[] = [];

  parts.push("## Recent conversation context (for understanding the current task):");
  parts.push(recentContext || "(no context available)");
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
