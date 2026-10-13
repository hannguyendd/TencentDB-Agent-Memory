/**
 * CodeBuddy AgentStrategy (Phase 3).
 * Uses the openai-chat protocol, always main, shows the 5-step form.
 */

import { codebuddyAdapter } from "../../../agent-adapters/codebuddy.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const codebuddyStrategy: AgentStrategy = {
  ...codebuddyAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
