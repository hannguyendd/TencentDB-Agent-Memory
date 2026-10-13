/**
 * AgentStrategy factory -- dispatches 10 AgentStrategy instances by agentSource.
 *
 * The main blueprint §2.1 lists 8 (claude-code/codebuddy/codex/workbuddy/dsh/opencode/
 * pi/default); addendum §4.3 adds two header-only agents, hermes/openclaw,
 * which share the same constraints as pi (supportsSessionForm=false + bypassOnPresetFail=true).
 * The first 8 derive from the same-named adapters under `agent-adapters/`; hermes/openclaw
 * have no dedicated adapter (no capture-specific specialization), reuse defaultAdapter and fill in fields at the strategy layer --
 * see the header comment of hermes.ts.
 */

import type { AgentStrategy } from "./types.js";
import { claudeCodeStrategy } from "./claude-code.js";
import { codebuddyStrategy } from "./codebuddy.js";
import { codexStrategy } from "./codex.js";
import { workbuddyStrategy } from "./workbuddy.js";
import { dshStrategy } from "./dsh.js";
import { opencodeStrategy } from "./opencode.js";
import { piStrategy } from "./pi.js";
import { hermesStrategy } from "./hermes.js";
import { openclawStrategy } from "./openclaw.js";
import { defaultStrategy } from "./default.js";

export {
  claudeCodeStrategy,
  codebuddyStrategy,
  codexStrategy,
  workbuddyStrategy,
  dshStrategy,
  opencodeStrategy,
  piStrategy,
  hermesStrategy,
  openclawStrategy,
  defaultStrategy,
};

export function resolveAgentStrategy(agentSource: string): AgentStrategy {
  switch (agentSource) {
    case "claude-code": return claudeCodeStrategy;
    case "codebuddy": return codebuddyStrategy;
    case "codex": return codexStrategy;
    case "workbuddy": return workbuddyStrategy;
    case "dsh": return dshStrategy;
    case "opencode": return opencodeStrategy;
    case "pi": return piStrategy;
    // three header-only agents (addendum §4.3) -- separate instances rather than shared, to allow future per-agent specialization
    case "hermes": return hermesStrategy;
    case "openclaw": return openclawStrategy;
    default: return defaultStrategy;
  }
}
