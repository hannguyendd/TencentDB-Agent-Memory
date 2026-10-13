/**
 * WorkBuddy AgentStrategy.
 * Uses the responses protocol; unique AskUserQuestion tool detection -> without it, falls back to the text-mode form.
 *
 * stageGates: full -- aligned with codex/CC/CB observability;
 * fixes the handler-audit bugs B1-B8 of the old workbuddyHandler (same as codex).
 *
 * 2026-10-08 cleanup: removed `archiveProtocol` / `detectClientCapabilities` /
 * `detectDefaultGate` from the strategy -- none of the three has a read site. The implementations that actually take effect are
 * `session/client-capabilities.ts::detectClientCapabilities` (called by
 * `runners/openai-chat.ts:679`) and `session/codebuddy/init.ts::detectCodexDefaultGate`;
 * the archive protocol is passed to stageArchive as a literal by the runner.
 */

import { workbuddyAdapter } from "../../../agent-adapters/workbuddy.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const workbuddyStrategy: AgentStrategy = {
  ...workbuddyAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
