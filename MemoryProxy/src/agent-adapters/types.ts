/**
 * Agent Adapter -- an abstraction layer that adapts to the differing behavior of
 * the CC client / CodeBuddy / other IDE clients.
 *
 * Background: different clients stuff different things into requests:
 *   - Claude Code (anthropic protocol): user content is an array of text blocks, with
 *     metadata such as <system-reminder> / <local-command-*> up front; only the last text block
 *     is the user's input; fork-type requests (SUGGESTION/RECAP/COMPACT) differ from the main
 *     conversation in cache_control marker position (n-2 vs n-1).
 *   - CodeBuddy (openai protocol): user content is often a string, possibly mixed with CB internal
 *     tags -- structure differs greatly from CC.
 *   - Others (cursor / windsurf / custom SDKs): not studied.
 *
 * The proxy needs per-client adaptation in three places:
 *   1. Classifying the request category (main / fork / sidequery) -- decides which path later stages take
 *   2. Extracting the "text the user actually typed" from user message content -- used by mem command detection /
 *      skill buffer normalization
 *
 * Common capabilities (skill_buffer writes, L0 memory, mem interception) must be open to all clients;
 * only the **rules for extracting user input** and the **classification rules** are adapted per agent.
 */

/**
 * Client type identifier.
 *
 * Note: this field is currently used only as a label -- nothing in the whole repo branches on its value (`resolveAgentAdapter` /
 * `resolveAgentStrategy` both dispatch on the agentSource string and do not read agentKind).
 * So giving hermes/openclaw an honest value does not change any behavior.
 */
export type AgentKind =
  | "claude-code" | "codebuddy" | "codex" | "workbuddy"
  | "dsh" | "opencode" | "pi"
  | "hermes" | "openclaw"
  | "unknown";

export type RequestKind = "main" | "fork" | "sidequery" | "auxiliary";

export interface AgentAdapter {
  /** Client type identifier, mapped from the URL prefix. */
  readonly agentKind: AgentKind;

  /**
   * Classify the request category. Used by the handler to decide whether later stages bypass injection / mem interception /
   * L0 / skill buffer and other business side effects.
   *
   * - claude-code: three-way fallback split by cache_control marker position + tools/thinking
   *   (see docs/design/2026-07-30-cc-request-routing-plan.md)
   * - codebuddy / unknown: always returns "main" -- the client's classification rules have not been studied; conservatively take
   *   the old path equivalent to the status quo (no routing split)
   */
  classifyRequest(
    body: Record<string, unknown>,
    path?: string,
    headers?: Record<string, string>,
  ): RequestKind;

  /**
   * Extract the "text the user actually typed" from the user message content.
   *
   * - claude-code: take the last type:"text" block (skipping the leading <system-reminder>
   *   and other CC-internal metadata, and skipping other block types such as tool_result / image / thinking)
   * - codebuddy / unknown: conservatively use the old "content to string" logic, equivalent to the status quo
   *
   * Returns null to mean "the content has no user-typed text" (e.g. all tool_result).
   */
  extractUserText(content: unknown): string | null;
}
