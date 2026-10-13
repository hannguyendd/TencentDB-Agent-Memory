/**
 * Codex asset injection -- generator for the `<tdai_injections>` wrapper.
 *
 * Appends a text block to the end of content[] of codex body.input[0] (the developer message):
 * `{type:"input_text", text:"<tdai_injections>...\n</tdai_injections>"}`.
 *
 * Two modes:
 *   - **raw** (the path the current codex handler uses): the **complete finished text** already produced by the pipeline
 *     (containing multiple groups of internal XML tags such as `<available_skills>` / `<user_memory>` / `<tdai_profile_memory>` /
 *     `<memory-tools-guide>`) is embedded as-is inside the wrapper, with no further
 *     escaping or extra tag wrapping, and is **byte-identical** to what the CC / CB clients see in the system message
 *     -- the model learns exactly the same semantics, with no need for a "codex-specific prompt".
 *
 *   - **structured** (`{skills, memory, ...}` split into 5 sections): reserved for a future codex-specific
 *     renderer (enabled when truly splitting by section, e.g. the UI layer wants to render per section). **The current pipeline
 *     output is a single text string and cannot be split back into 5 sections, so this mode must not be used on the main path** -- misuse
 *     would stuff the pipeline's whole output into the single `<available_skills>` tag, and all inner
 *     `<...>` would be XML-escaped into `&lt;...&gt;`, which the model cannot understand. The history of this pitfall is recorded in the P0 fix
 *     commit body.
 *
 * Why use a wrapper instead of appending the pipeline output as a raw text directly:
 *   - When something goes wrong, `grep '<tdai_injections>'` locates the section injected by this handler in one step
 *   - It is easier to compress context when the client replays on the next turn
 *   - If P2/P3 later want to add metadata inside the wrapper, there is a place for it
 *
 * See docs/2026-08-07-codex-integration-plan.md section 4 for details.
 */

// ── XML escape ───────────────────────────────────────────────────────────────

/**
 * XML entity encode: escapes the five XML special characters < > & " '.
 * Used only in structured mode; raw mode (the current main path) does not escape, because the input is already
 * a valid XML structure, and escaping would turn all tags into entity characters so the model could not read the tag semantics.
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
const SEGMENTS: Array<{ tag: string; field: keyof CodexInjectionInputStructured }> = [
  { tag: "available_skills", field: "skills" },
  { tag: "user_memory", field: "memory" },
  { tag: "agents", field: "agents" },
  { tag: "tasks", field: "tasks" },
  { tag: "knowledge", field: "knowledge" },
];

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Raw mode input: the complete XML text string already produced by the pipeline (no second escape / wrapping).
 * The current codex handler takes this path, byte-identical to the CC / CB system message content.
 */
export interface CodexInjectionInputRaw {
  raw: string;
}

/**
 * Structured mode input: split into 5 sections (reserved for a future codex-specific renderer).
 * WARNING: do not use on the current pipeline main path -- see the explanation in the module doc.
 */
export interface CodexInjectionInputStructured {
  skills?: string;
  memory?: string;
  agents?: string;
  tasks?: string;
  knowledge?: string;
}

/**
 * `buildCodexInjectionBlock` input: either raw or structured.
 * Passing `{raw}` -> raw mode, embedded as-is; otherwise treated as structured and rendered split into 5 sections.
 */
export type CodexInjectionInput = CodexInjectionInputRaw | CodexInjectionInputStructured;

/**
 * Build the `<tdai_injections>` wrapper, returning an input_text object that can be pushed directly into the codex
 * `body.input[0].content` array.
 *
 * - raw mode: `{raw: "..."}` -> embedded as-is inside the wrapper, no escape and no sub-tags
 * - structured mode: `{skills, memory, ...}` -> each section wrapped in its tag + XML escape,
 *   empty sections (empty string / undefined) omitted
 * - with no content, still returns an empty wrapper `<tdai_injections>\n</tdai_injections>`
 */
export function buildCodexInjectionBlock(
  input: CodexInjectionInput,
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

function isRawInput(input: CodexInjectionInput): input is CodexInjectionInputRaw {
  return typeof (input as CodexInjectionInputRaw).raw === "string";
}
