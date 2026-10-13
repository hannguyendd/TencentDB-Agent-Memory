/**
 * Client Capabilities Detection.
 *
 * Purpose: different clients differ in their support for "proxy-initiated fake ask tool_calls".
 *   - workbuddy old versions: body.tools contains `AskUserQuestion` → card forms supported (tool_calls SSE)
 *   - workbuddy new versions: body.tools does **not** contain `AskUserQuestion` → cards unsupported, must degrade to plain-text replies
 *   - other clients: this module makes no determination (original path is kept)
 *
 * Detection signals: agentSource + body.tools[]. **Computed live on every request**, not cached,
 * so if the same sessionKey carries the ask tool next time it automatically switches back to card mode.
 *
 * Scope (current iteration): only determines whether workbuddy has the `AskUserQuestion` tool.
 * All other clients always get `askUserQuestion: true` (original logic), to avoid breaking existing branches of dsh / codebuddy /
 * claude-code / codex / opencode / hermes / openclaw.
 */

// ── Constants ──────────────────────────────────────────────────────────────────

/** Tool name WorkBuddy uses to pop up card forms. Keep consistent with TOOL_NAME in workbuddy/form.ts. */
export const WB_ASK_TOOL_NAME = "AskUserQuestion";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ClientCapabilities {
  /**
   * Whether the client supports proxy-initiated "ask the user" card tool calls.
   *
   * - `true`  → use the existing card mode (tool_calls SSE + form rendering)
   * - `false` → use text mode (content chunk + markdown rendering + plain-text parsing)
   *
   * Currently only workbuddy returns false (when body.tools has no AskUserQuestion);
   * all other clients always return true (existing behavior preserved).
   */
  askUserQuestion: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Check whether body.tools[] contains a tool with the given name.
 *
 * Compatible with two shapes:
 *   - OpenAI:    `{ type: "function", function: { name: "..." } }`
 *   - flat:      `{ name: "..." }`
 *
 * Returns false when tools is an empty array / not an array / undefined.
 */
function toolsContain(tools: unknown, name: string): boolean {
  if (!Array.isArray(tools) || tools.length === 0) return false;
  return tools.some((t) => {
    if (!t || typeof t !== "object") return false;
    const fn = (t as { function?: { name?: string } }).function;
    const flatName = (t as { name?: string }).name;
    const n = fn?.name ?? flatName;
    return n === name;
  });
}

// ── Detection ──────────────────────────────────────────────────────────────────

/**
 * Detect the capabilities of the client making the current request.
 *
 * @param agentSource - client type, e.g. "workbuddy" / "codebuddy" / "dsh" / ...
 * @param body        - raw request body (including tools[])
 * @returns capability flags
 */
export function detectClientCapabilities(
  agentSource: string,
  body: unknown,
): ClientCapabilities {
  // Only workbuddy gets capability detection; all other clients take the original path.
  if (agentSource !== "workbuddy") {
    return { askUserQuestion: true };
  }

  // workbuddy: check whether body.tools[] contains AskUserQuestion.
  // - tools not an array / empty array / missing → treated as **no capability** (this is the shape of new WB)
  //   This is the more conservative choice: better to use text mode (worse UX but works),
  //   than card mode (client does not recognize the tool → hangs).
  const tools = (body as { tools?: unknown } | null | undefined)?.tools;
  const hasAskTool = toolsContain(tools, WB_ASK_TOOL_NAME);
  return { askUserQuestion: hasAskTool };
}
