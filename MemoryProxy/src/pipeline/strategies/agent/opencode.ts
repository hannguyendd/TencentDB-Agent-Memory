/**
 * opencode AgentStrategy (Phase 3).
 * Uses the openai-chat protocol, always main, shows the 5-step form.
 */

import { opencodeAdapter } from "../../../agent-adapters/opencode.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const opencodeStrategy: AgentStrategy = {
  ...opencodeAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
