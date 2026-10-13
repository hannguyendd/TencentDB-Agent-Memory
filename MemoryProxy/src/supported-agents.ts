/**
 * Supported-agents source-of-truth constants.
 *
 * Corresponds to design doc docs/design/2026-08-25-instance-upstream-config.md §8.2.
 *
 * ## Purpose
 *
 * Which agents the Proxy supports is determined by the `DEFAULT_SUPPORTED_AGENTS` constant in this file. It is:
 *   - The criterion for the Proxy's internal handler route matching (see the /:agent/:spaceId/... segment in server.ts)
 *   - The agent allowlist used when fixtures / smoke / e2e tests generate requests
 *   - The **upstream data source** for the `upstream.supportedAgents` section of Core `tdai-gateway.yaml`
 *
 * ## Relationship with the Core yaml
 *
 * Since v2.4 this constant **no longer exposes an HTTP interface** (§6.A moved to Core); Panel requests for supported-agents
 * go through Core only. The `upstream.supportedAgents` section of Core `tdai-gateway.yaml` is a
 * runtime copy of this constant; it must be manually checked for consistency before release (no CI/CD check yet).
 *
 * ## Change procedure
 *
 * When adding or removing an agent, follow this order strictly:
 *   1. Update this constant (add/remove entry)
 *   2. Also update the `upstream.supportedAgents` section of `MemoryCore/tdai-gateway.standalone.yaml`
 *      and `tdai-gateway.service.yaml`
 *   3. Deploy Core -> deploy Proxy (the order must not be reversed, otherwise Core would reference a non-existent agent when seeding the default group)
 */

export type SupportedAgentProtocol = "anthropic" | "openai-chat" | "openai-responses";

export interface SupportedAgent {
  /** Internal enum value, matches the first segment of the Proxy URL path (e.g. /codebuddy/:spaceId/...); this is what the database agents array stores */
  agent_source: string;
  /** Wire protocol; the frontend uses it to remind users that "a custom baseUrl must be compatible with this protocol" */
  protocol: SupportedAgentProtocol;
  /** Human-readable name for frontend display (Chinese or English) */
  display_name: string;
}

/**
 * The full set of agents supported by the current Proxy deployment.
 *
 * ⚠️ After modifying this constant you must also update the Core yaml; see "Change procedure" in the file header comment.
 */
export const DEFAULT_SUPPORTED_AGENTS: SupportedAgent[] = [
  { agent_source: "claude-code", protocol: "anthropic",        display_name: "Claude Code" },
  { agent_source: "codebuddy",   protocol: "openai-chat",      display_name: "CodeBuddy" },
  { agent_source: "codex",       protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "workbuddy",   protocol: "openai-responses", display_name: "WorkBuddy" },
  { agent_source: "dsh",         protocol: "openai-chat",      display_name: "DeepSeek Harness" },
  { agent_source: "opencode",    protocol: "openai-chat",      display_name: "OpenCode" },
  // ── header-only clients (identity is preselected via the x-team-id / x-agent-id / x-task-id request headers,
  //    with no interactive form UI -- the client does not recognize the ask_followup_question tool_call forged by the proxy,
  //    so preset failure/mismatch scenarios must bypass rather than pop up a form).
  //    Set definition: src/session/preset.ts HEADER_ONLY_AGENTS
  //    Consumers:  handler.ts / anthropicHandler.ts session-reset pre-hook,
  //             early-exit branch for header-preselect in session/codebuddy/init.ts
  { agent_source: "pi",          protocol: "openai-chat",      display_name: "Pi" },
  { agent_source: "hermes",      protocol: "anthropic",        display_name: "Hermes" },
  { agent_source: "openclaw",    protocol: "anthropic",        display_name: "OpenClaw" },
];

/** O(1) lookup: agent_source -> SupportedAgent. */
const AGENT_MAP: ReadonlyMap<string, SupportedAgent> = new Map(
  DEFAULT_SUPPORTED_AGENTS.map((a) => [a.agent_source, a]),
);

/** Check whether the given agent_source is supported (whether the first segment of the Proxy path is valid). */
export function isSupportedAgent(agentSource: string | undefined | null): boolean {
  if (!agentSource) return false;
  return AGENT_MAP.has(agentSource);
}
