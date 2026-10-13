/**
 * mem: command parser
 *
 * Detects whether the last user message in request body.messages is a mem: command.
 *
 * Rules:
 * 1. Take the last message with role="user" in the messages array
 * 2. Extract the user's real input via agentAdapter.extractUserText according to client rules:
 *    - claude-code: take the last text block (skipping <system-reminder> prefix metadata)
 *    - codebuddy / unknown: use the conservative "concatenate all text" approach (pending traffic-capture adaptation)
 * 3. After trim, starts with "mem:" (case-insensitive)
 * 4. The whole message is the command (not embedded in other text)
 */

import { resolveAgentAdapter } from "../agent-adapters/index.js";

export interface ParsedMemCommand {
  /** Command name (lowercase), e.g. "sync"、"create-skill"、"help" */
  command: string;
  /** Argument text after the command (e.g. the prompt for create-skill) */
  args: string;
  /** Original user message (for audit / L0 writes) */
  rawMessage: string;
}

/**
 * Args constraint table for known mem commands.
 * - `false`: the command is **strictly matched** -- it cannot be followed by any non-whitespace content (e.g. `mem:help hello` is treated as
 *   normal conversation and passed through to the upstream LLM rather than intercepted).
 * - `true` : the command **accepts optional args** -- `mem:create-skill database migration summary` matches and carries
 *   args; `mem:create-skill` (no args) also matches.
 *
 * Commands not in the table (user typos such as `mem:helpp` / `mem:foo`) are not affected by this check -- the parser
 * still returns a ParsedMemCommand, and `executeMemCommand` handles it in the "unknown command" branch with the feedback
 * `❌ Unknown command mem:xxx, type mem:help to see available commands`, as a safety net for user typos.
 */
const MEM_COMMANDS_ARGS: Record<string, boolean> = {
  help: false,
  sync: false,
  "create-skill": true,
  // task command family: args semantics aligned with create-skill -- used as an extra hint (reason) for the LLM
  // to generate title/description; empty args means generating purely from the last 30 context messages.
  "create-task": true,
  "update-task": true,
  "session-reset": false,
};

/**
 * Detect whether the request body contains a mem: command.
 * Returns null if it is not a mem: command, so the normal pipeline continues.
 *
 * ⚠️ Only supports the body.messages[] form (CC/CB). Codex uses body.input[];
 * the caller (codexHandler) should first use `codexAdapter.extractUserText(input)` to get
 * the text, then call `parseCommandFromText(text)` directly (skipping the body parsing step).
 *
 * @param body - request body (including the messages array)
 * @param agentSource - client type (URL prefix), used to select the agentAdapter
 * @param options.checkFirst - when true, check the first user message instead of the last one.
 *   Used right after session init completes: the last message is the init interaction answer, and the first is the user's original command.
 */
export function parseMemCommand(
  body: Record<string, unknown>,
  agentSource: string,
  options?: { checkFirst?: boolean },
): ParsedMemCommand | null {
  const messages = (body as any)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // Pick the target message: the last one by default; with checkFirst, the first user message
  let targetMsg: any;
  if (options?.checkFirst) {
    targetMsg = messages.find((m: any) => m && m.role === "user");
  } else {
    targetMsg = messages[messages.length - 1];
  }
  if (!targetMsg || targetMsg.role !== "user") return null;
  const lastMsg = targetMsg;

  // Extract plain text via the adapter according to client rules
  const adapter = resolveAgentAdapter(agentSource);
  const text = adapter.extractUserText(lastMsg.content);
  if (text === null) return null;

  return parseCommandFromText(text);
}

/**
 * Determine whether already-extracted user text is a mem: command.
 *
 * This layer is extracted so the codex handler can reuse the same mem command semantics:
 * the codex body uses `input[]` instead of `messages[]`, and the parseMemCommand path that starts from the body
 * could not recognize codex and returned null early, so every mem:xxx was silently passed through to the
 * LLM, which fabricated fake replies such as "Memory synced" (P0-1 QA report). The codex handler
 * now gets the text via `codexAdapter.extractUserText(input)` and calls this function directly.
 *
 * CC/CB's `parseMemCommand(body, agentSource)` also goes through this path internally, with
 * completely unchanged behavior.
 */
export function parseCommandFromText(text: string): ParsedMemCommand | null {
  // Check after trim
  const trimmed = text.trim();

  // Must start with mem: (case-insensitive)
  if (!trimmed.toLowerCase().startsWith("mem:")) return null;

  // Extract the command part (content after mem:)
  const afterPrefix = trimmed.slice(4); // strip "mem:"

  // Allow optional whitespace after the colon
  const stripped = afterPrefix.trimStart();

  // Split command name and args (on the first space)
  const spaceIdx = stripped.indexOf(" ");
  let command: string;
  let args: string;

  if (spaceIdx === -1) {
    command = stripped;
    args = "";
  } else {
    command = stripped.slice(0, spaceIdx);
    args = stripped.slice(spaceIdx + 1).trim();
  }

  command = command.toLowerCase();

  // Command name must not be empty
  if (!command) return null;

  // Strict args validation for known commands: when a command does not accept args, non-empty args are treated as normal conversation.
  // E.g. `mem:help hello` -> the user "typed mem:help and asked a question at the same time", which should go to the upstream
  // LLM for a normal answer rather than returning the help text. Unknown commands are not subject to this (see the MEM_COMMANDS_ARGS note).
  if (MEM_COMMANDS_ARGS[command] === false && args.length > 0) {
    return null;
  }

  return { command, args, rawMessage: trimmed };
}
