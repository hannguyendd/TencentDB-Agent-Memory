/**
 * Pre-intercept check for mem:session-reset.
 *
 * Background: all mem commands were originally recognized in each handler only **after** the session-init
 * section (`anthropicHandler.ts:869-1000` / `handler.ts:922-1000` /
 * `codexHandler.ts:609-680` / `workbuddyHandler.ts:1111-1180`). That order is reasonable for
 * sync / create-skill, which depend on sessionInfo. But session-reset must work from all four
 * starting states **uninitialized / pending_* / initialized / bypassed**:
 *
 *   - uninitialized: the state machine would treat "mem:session-reset" as the "user's first message";
 *     the asset_confirm branch that reflects form data does not apply, but a form would still be shown first,
 *     which confuses the user
 *   - pending_*: the state machine would treat it as "the user's answer to the form" and go through parseFormAnswer
 *     -> unrecognized -> session bypass, so the reset command is never intercepted
 *   - initialized / bypassed: the old mem-command interception section can recognize it, but once the
 *     "session not initialized, command unavailable" gate is removed the behavior is the same. Pre-intercepting these two is simpler too
 *
 * Compromise: add pre-interception only for session-reset -- other mem commands are untouched. This function
 * just decides "is this request a session-reset"; the handler puts a single if in front to decide
 * whether to short-circuit.
 */

import { parseCommandFromText } from "./parser.js";
import { resolveAgentAdapter } from "../agent-adapters/index.js";

/**
 * Determine whether the last user message in the request body is `mem:session-reset`.
 *
 * Supports both body.messages[] (CC/CB/dsh) and body.input[] (Codex/WB) shapes.
 * Internally uses the corresponding adapter's `extractUserText` to extract plain text, keeping the same
 * text-extraction semantics as the existing mem-command interception section.
 *
 * Never throws: any exception / missing field returns false so the original path keeps running.
 */
export function isSessionResetCommand(
  body: Record<string, unknown> | null | undefined,
  agentSource: string,
): boolean {
  if (!body) return false;

  try {
    const adapter = resolveAgentAdapter(agentSource);
    let text: string | null = null;

    // Codex / WorkBuddy use body.input[] (Responses API)
    if (Array.isArray((body as any).input)) {
      const input = (body as any).input as any[];
      if (input.length === 0) return false;
      // Only recognize the case where the latest input item is a role=user message;
      // if the latest is a function_call_output, a form interaction is in progress,
      // and the codex client replays the whole input history including the earliest mem:session-reset --
      // the pre-hook must not fire again then, otherwise state is reset to uninitialized in an endless loop.
      const lastItem = input[input.length - 1] as Record<string, unknown> | null | undefined;
      if (!lastItem || typeof lastItem !== "object") return false;
      if (lastItem.type !== "message" || lastItem.role !== "user") return false;
      // Extract text directly from the last message; do not reuse extractUserText (it scans backwards)
      const content = lastItem.content;
      if (!Array.isArray(content)) return false;
      const texts: string[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown> | null | undefined;
        if (b && typeof b === "object" && b.type === "input_text" && typeof b.text === "string") {
          texts.push(b.text);
        }
      }
      text = texts.length > 0 ? texts.join("\n") : null;
    } else if (Array.isArray((body as any).messages)) {
      // CC/CB/dsh use body.messages[]
      const messages = (body as any).messages as any[];
      if (messages.length === 0) return false;
      // Last user message
      const last = messages[messages.length - 1];
      if (!last || last.role !== "user") return false;
      text = adapter.extractUserText(last.content);
    } else {
      return false;
    }

    if (!text) return false;
    const parsed = parseCommandFromText(text);
    return parsed?.command === "session-reset";
  } catch {
    return false;
  }
}
