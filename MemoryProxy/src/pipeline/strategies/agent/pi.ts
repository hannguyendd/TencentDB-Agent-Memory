/**
 * pi AgentStrategy (Phase 3).
 *
 * addendum §4.3: pi is in HEADER_ONLY_AGENTS; on preset failure it always bypasses and never shows the form.
 */

import { piAdapter } from "../../../agent-adapters/pi.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const piStrategy: AgentStrategy = {
  ...piAdapter,
  supportsSessionForm: false, // header-only clients do not recognize the ask_followup_question tool
  bypassOnPresetFail: true,
  stageGates: STAGE_PRESETS.full,
};
