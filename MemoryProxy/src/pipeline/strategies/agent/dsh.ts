/**
 * dsh (deepseek-harness) AgentStrategy (Phase 3).
 * Uses the openai-chat protocol; skips session-init when headless (no ask_user_question tool).
 */

import { dshAdapter } from "../../../agent-adapters/dsh.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const dshStrategy: AgentStrategy = {
  ...dshAdapter,
  supportsSessionForm: true, // only shown when ask_user_question exists; headless detection is inlined in the runner
  stageGates: STAGE_PRESETS.full,
};
