/**
 * WorkBuddy asset injection -- generator for the `<tdai_injections>` wrapper.
 *
 * **Isomorphic to but independent of** codex-injection.ts: WorkBuddy also uses the OpenAI Responses API
 * (@openai/agents SDK), and the body structure is the same as Codex (an `input[]` array, a mix of developer/user
 * messages, content arrays containing input_text). The logic could have been reused, but following the project's
 * "clients are decoupled from each other" policy, a separate file is deliberately copied; changing WorkBuddy does not affect
 * Codex, and vice versa.
 *
 * Two modes (keeping the same dual-mode design as codex-injection):
 *   - **raw** (the path the current handler uses): the **complete finished text** already produced by the pipeline
 *     (containing multiple groups of internal XML tags such as `<available_skills>` / `<user_memory>` / `<tdai_profile_memory>` /
 *     `<memory-tools-guide>`) is embedded as-is inside the wrapper, with no further
 *     escaping or sub-tags -- **byte-identical** to what the CC / CB / Codex clients see
 *     in the system message.
 *
 *   - **structured** (`{skills, memory, ...}` split into 5 sections): reserved for a future WorkBuddy-specific
 *     renderer (enabled when splitting by section is needed). The current pipeline main path **cannot use** this
 *     mode (the pipeline output is a single text and cannot be split back into 5 sections; misuse would stuff the whole thing into the
 *     single `<available_skills>` tag and have it XML-escaped, which the model cannot understand).
 *
 * See docs/workbuddy-recon/ and the module doc of codex-injection.ts in this directory for details.
 */

// ── XML escape ───────────────────────────────────────────────────────────────

/**
 * XML entity encode: escapes the five XML special characters < > & " '.
 * Used only in structured mode; raw mode (the current main path) does not escape.
 */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── Segments ─────────────────────────────────────────────────────────────────

/** Structured mode sub-section definition: tag name + the corresponding input field name. Order is rendering order. */
const SEGMENTS: Array<{ tag: string; field: keyof WorkbuddyInjectionInputStructured }> = [
  { tag: "available_skills", field: "skills" },
  { tag: "user_memory", field: "memory" },
  { tag: "agents", field: "agents" },
  { tag: "tasks", field: "tasks" },
  { tag: "knowledge", field: "knowledge" },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Raw mode input: the complete XML text string already produced by the pipeline (no second escape / wrapping).
 * The current WorkBuddy handler takes this path.
 */
export interface WorkbuddyInjectionInputRaw {
  raw: string;
}

/**
 * Structured mode input: split into 5 sections (reserved for a future WorkBuddy-specific renderer).
 * WARNING: do not use on the current pipeline main path.
 */
export interface WorkbuddyInjectionInputStructured {
  skills?: string;
  memory?: string;
  agents?: string;
  tasks?: string;
  knowledge?: string;
}

/**
 * `buildWorkbuddyInjectionBlock` input: either raw or structured.
 * Passing `{raw}` -> raw mode, embedded as-is; otherwise treated as structured and rendered split into 5 sections.
 */
export type WorkbuddyInjectionInput =
  | WorkbuddyInjectionInputRaw
  | WorkbuddyInjectionInputStructured;

/**
 * Build the `<tdai_injections>` wrapper, returning an input_text object that can be pushed directly into the WorkBuddy
 * `body.input[0].content` array.
 *
 * - raw mode: `{raw: "..."}` -> embedded as-is inside the wrapper, no escape and no sub-tags
 * - structured mode: `{skills, memory, ...}` -> each section wrapped in its tag + XML escape,
 *   empty sections (empty string / undefined) omitted
 * - with no content, still returns an empty wrapper `<tdai_injections>\n</tdai_injections>`
 */
export function buildWorkbuddyInjectionBlock(
  input: WorkbuddyInjectionInput,
): { type: "input_text"; text: string } {
  // Raw mode: embed directly without any processing
  if (isRawInput(input)) {
    const raw = input.raw ?? "";
    const inner = raw.length > 0 ? "\n" + raw + "\n" : "\n";
    return { type: "input_text", text: `<tdai_injections>${inner}</tdai_injections>` };
  }

  // Structured mode: split into 5 sections + XML-escape the content
  const parts: string[] = [];
  for (const seg of SEGMENTS) {
    const raw = input[seg.field];
    if (!raw) continue;
    parts.push(`<${seg.tag}>\n${xmlEscape(raw)}\n</${seg.tag}>`);
  }
  const inner = parts.length > 0 ? "\n" + parts.join("\n\n") + "\n" : "\n";
  return { type: "input_text", text: `<tdai_injections>${inner}</tdai_injections>` };
}

function isRawInput(input: WorkbuddyInjectionInput): input is WorkbuddyInjectionInputRaw {
  return typeof (input as WorkbuddyInjectionInputRaw).raw === "string";
}
