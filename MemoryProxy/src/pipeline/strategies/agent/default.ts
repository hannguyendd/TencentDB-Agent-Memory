/**
 * Default (unknown) AgentStrategy (Phase 3).
 * Conservative fallback: uses openai-chat, shows the form, all stages enabled.
 */

import { defaultAdapter } from "../../../agent-adapters/default.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const defaultStrategy: AgentStrategy = {
  ...defaultAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
