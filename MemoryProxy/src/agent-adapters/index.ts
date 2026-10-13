/**
 * Agent Adapter factory.
 *
 * Returns the adapter matching the `agentSource` mapped from the URL prefix; unrecognized clients get
 * the default adapter (conservative behavior equivalent to the status quo).
 *
 * Details for each piece:
 *   - types.ts -- AgentAdapter interface + description of the three adaptation points
 *   - claude-code.ts -- CC specialization (currently the only client with source/capture evidence)
 *   - codebuddy.ts -- CB stub (reuses default behavior; CB specialization to be added once captures exist)
 *   - default.ts -- fallback for unknown clients
 */

import type { AgentAdapter } from "./types.js";
import { claudeCodeAdapter } from "./claude-code.js";
import { codebuddyAdapter } from "./codebuddy.js";
import { codexAdapter } from "./codex.js";
import { workbuddyAdapter } from "./workbuddy.js";
import { dshAdapter } from "./dsh.js";
import { opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { defaultAdapter } from "./default.js";

export type { AgentAdapter, AgentKind, RequestKind } from "./types.js";

export function resolveAgentAdapter(agentSource: string): AgentAdapter {
  switch (agentSource) {
    case "claude-code":
      return claudeCodeAdapter;
    case "codebuddy":
      return codebuddyAdapter;
    case "codex":
      return codexAdapter;
    case "workbuddy":
      return workbuddyAdapter;
    case "dsh":
      return dshAdapter;
    case "opencode":
      return opencodeAdapter;
    case "pi":
      return piAdapter;
    default:
      return defaultAdapter;
  }
}
