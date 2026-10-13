/**
 * openclaw AgentStrategy (addendum §4.3 contract completion).
 *
 * Fully symmetric with hermes -- the addendum original lists both together in `HEADER_ONLY_AGENTS`
 * (session/preset.ts:32-36), and `isHeaderOnlyAgent()` behaves identically for both:
 *   > - `hermes`   — anthropic, no ask-user tool available
 *   > - `openclaw` — anthropic, same as hermes
 *
 * The reason for the completion, the protocol, the behavior, and the note that this is a "contract refinement, not a behavior fix"
 * are all the same as hermes.ts; see that file's header comment.
 * It is a separate file (rather than reusing the hermes instance) to keep the structure consistent with the other agents --
 * so that capture-specific specialization of either one never affects the other.
 */

import { defaultAdapter } from "../../../agent-adapters/default.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const openclawStrategy: AgentStrategy = {
  ...defaultAdapter,
  agentKind: "openclaw",      // overrides defaultAdapter's "unknown"
  supportsSessionForm: false, // header-only clients do not recognize the form tool_call forged by the proxy
  bypassOnPresetFail: true,   // on preset failure always bypass in every scenario, never show the form
  stageGates: STAGE_PRESETS.full,
};
