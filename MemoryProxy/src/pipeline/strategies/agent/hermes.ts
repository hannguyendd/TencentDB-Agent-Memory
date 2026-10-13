/**
 * hermes AgentStrategy (addendum §4.3 contract completion).
 *
 * addendum §4.3 original text:
 *   > `HEADER_ONLY_AGENTS` and `isHeaderOnlyAgent(agentSource)` are a **cross-stage hard constraint**,
 *   > not an optional specialization. In `AgentStrategy` it is expressed as:
 *   >   - `supportsSessionForm: false` (given to the pi/hermes/openclaw agents in Phase 3)
 *   >   - `bypassOnPresetFail: true`
 *
 * Phase 3 only landed pi (`pi.ts`); hermes/openclaw were missed at the time and fell back to
 * `defaultStrategy`. This file fills the gap, symmetric with pi.
 *
 * Warning: this is a contract refinement, not a behavior fix: runtime behavior is identical before and after.
 *   - Those two fields currently have no consumers (the original consumer `stages/session-init.ts` was
 *     replaced by `stages/session-init-orchestrate.ts` in Round 18 and deleted), see the field JSDoc in types.ts
 *   - The header-only bypass that actually takes effect is the `isHeaderOnlyAgent(agentSource)` branch at
 *     `session/codebuddy/init.ts:835`, decided by the `HEADER_ONLY_AGENTS` Set,
 *     which already covered hermes and is unrelated to the strategy
 *   - The only strategy field actually consumed is `stageGates`, and when this agent fell back to default
 *     it was also `STAGE_PRESETS.full`, so the value is the same
 *
 * Protocol: hermes uses anthropic /v1/messages (supported-agents.ts marks
 * protocol="anthropic"). The archive protocol is passed to stageArchive as a literal by the runner,
 * and the strategy no longer holds that field (2026-10-08 cleanup; the "openai" it held originally was also wrong).
 *
 * Behavior: reuses defaultAdapter's classifyRequest/extractUserText (no capture-specific specialization);
 * agentKind is explicitly set to "hermes" (the AgentKind union type already includes it, see agent-adapters/types.ts).
 */

import { defaultAdapter } from "../../../agent-adapters/default.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const hermesStrategy: AgentStrategy = {
  ...defaultAdapter,
  agentKind: "hermes",        // overrides defaultAdapter's "unknown"
  supportsSessionForm: false, // header-only clients do not recognize the form tool_call forged by the proxy
  bypassOnPresetFail: true,   // on preset failure always bypass in every scenario, never show the form
  stageGates: STAGE_PRESETS.full,
};
