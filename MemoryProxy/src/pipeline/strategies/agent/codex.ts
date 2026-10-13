/**
 * Codex AgentStrategy.
 * Uses the responses protocol; Default-gate detection lives in session/codebuddy/init.ts (see below).
 *
 * stageGates: full -- aligned with CC/CB observability;
 * fixes the handler-audit bugs B1-B8 of the old codexHandler (rate limit / credit /
 * opik / identity / model gate / usage log / model intent and other observability and governance stages).
 * After deployment, the CH tool_call_logs / Opik trace / identity tables will start receiving codex data.
 *
 * 2026-10-08 cleanup: removed `archiveProtocol` / `detectDefaultGate` from the strategy --
 * neither has any read site. The Default-gate detection that actually takes effect is
 * `session/codebuddy/init.ts::detectCodexDefaultGate` (called at line 611);
 * the archive protocol is passed to stageArchive as a literal by the runner.
 */

import { codexAdapter } from "../../../agent-adapters/codex.js";
import { STAGE_PRESETS, type AgentStrategy } from "./types.js";

export const codexStrategy: AgentStrategy = {
  ...codexAdapter,
  supportsSessionForm: true,
  stageGates: STAGE_PRESETS.full,
};
