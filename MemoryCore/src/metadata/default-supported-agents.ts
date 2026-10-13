/**
 * Built-in supported-agents fallback constant on the Core side.
 *
 * ## Role
 *
 * **One-to-one** with the Proxy-side source of truth ``MemoryProxy/src/supported-agents.ts::DEFAULT_SUPPORTED_AGENTS``;
 * it is the fallback used when the Core deployment's yaml does not configure ``upstream.supportedAgents``.
 *
 * ## When it applies
 *
 * In ``gateway/config.ts``, for the `upstream.supportedAgents` yaml section:
 *   - **Has a value** (non-empty array): the yaml wins. Used by ops to **temporarily take down** an agent without changing code
 *   - **No value / empty array**: this constant is used automatically. A Core upgrade rollout **does not need** to change yaml in sync; for a new agent, just
 *     change the Proxy constant + **synchronously** this fallback constant, and it takes effect end to end
 *
 * ## Requirement to stay in sync with the Proxy constant
 *
 * Changing this constant = syncing with the Proxy `DEFAULT_SUPPORTED_AGENTS`. Manually verify before release (v2.5 decision);
 * if they disagree, the diff-append of v2.6 option E treats the difference as "Proxy launched a new agent" -- old instances'
 * default would diff-append agents that are in the constant but not in Proxy, which is not the expected behavior.
 *
 * ## Semantics when mixed with yaml
 *
 * Configuring an agent in yaml (e.g. keeping only claude-code) = ops explicitly declaring "this Core only supports these",
 * and even if the fallback constant has 8 agents there is **no fallback**. Non-empty yaml = full override, not additive.
 */

import type { SupportedAgent } from "./types.js";

/**
 * Full Core-side fallback set. Fully aligned with Proxy `MemoryProxy/src/supported-agents.ts::DEFAULT_SUPPORTED_AGENTS`.
 *
 * Warning: after changing this constant, also update the Proxy constant + `upstream.supportedAgents` in `tdai-gateway.standalone.yaml` / `service.yaml`
 * (optional; if not changed it still falls back to this constant).
 *
 * SOP for launching a new agent:
 *   1. Change the Proxy `src/supported-agents.ts` constant
 *   2. **Change the constant in this file** (the fallback ensures a Core deployment still works even if yaml was not updated)
 *   3. Optional: change `tdai-gateway.*.yaml` (only needed when ops wants to manage it explicitly)
 *   4. Deploy Core → deploy Proxy
 */
export const DEFAULT_SUPPORTED_AGENTS_FALLBACK: readonly SupportedAgent[] = Object.freeze([
  { agent_source: "claude-code", protocol: "anthropic",        display_name: "Claude Code" },
  { agent_source: "codebuddy",   protocol: "openai-chat",      display_name: "CodeBuddy" },
  { agent_source: "codex",       protocol: "openai-responses", display_name: "Codex" },
  { agent_source: "workbuddy",   protocol: "openai-responses", display_name: "WorkBuddy" },
  { agent_source: "dsh",         protocol: "openai-chat",      display_name: "DeepSeek Harness" },
  { agent_source: "opencode",    protocol: "openai-chat",      display_name: "OpenCode" },
  { agent_source: "pi",          protocol: "openai-chat",      display_name: "Pi" },
  { agent_source: "hermes",      protocol: "anthropic",        display_name: "Hermes" },
  { agent_source: "openclaw",    protocol: "anthropic",        display_name: "OpenClaw" },
]) as readonly SupportedAgent[];
