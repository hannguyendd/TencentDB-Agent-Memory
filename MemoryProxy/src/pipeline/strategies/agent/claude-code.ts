/**
 * Claude Code AgentStrategy (Phase 3).
 * Uses the anthropic protocol; behavior is equivalent to the current anthropicHandler.ts.
 */

import { claudeCodeAdapter } from "../../../agent-adapters/claude-code.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const claudeCodeStrategy: AgentStrategy = {
  ...claudeCodeAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full, // the existing handler already has everything enabled
};
