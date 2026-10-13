/**
 * AgentStrategy — strategy interface split by client (claude-code / codebuddy / codex / workbuddy / dsh /
 * opencode / pi / hermes / openclaw / default).
 *
 * Extends the existing `AgentAdapter` (agent-adapters/types.ts) with:
 *   - stage gating (StageGates + preset) — the only part actually consumed by the pipeline
 *   - session-init contract fields (supportsSessionForm / bypassOnPresetFail, reserved by contract)
 *
 * blueprint-review decisions:
 *   - Keep a single interface + optional methods (`?.()`) (§4 did not adopt mixins; the current agent count is manageable)
 *   - Adopt the preset pattern (§5) to reduce the combinatorial complexity of stageGates
 *
 * addendum §4.3: `bypassOnPresetFail` is a hard constraint shared by pi/hermes/openclaw,
 * not an optional specialization.
 */

import type { AgentAdapter, AgentKind } from "../../../agent-adapters/types.js";

/**
 * Independent gate for whether each stage is enabled — the only part of this interface actually consumed by the pipeline.
 *
 * Current state (2026-10-08): **all 10 agents use the `full` preset**.
 *   - The original design had codex/workbuddy start from `minimal` and opt in step by step in Phase 5,
 *     but the bug-fix code for handler-audit B1-B8 does not take effect under minimal (no effect after deployment),
 *     so they were changed to full, consistent with CC/CB.
 *   - The `minimal` / `observe-only` presets are kept as debug/rollback tiers and currently have no callers.
 *   - direct/utility (passthrough/auxiliary) use a separate runner and do not consume stageGates.
 */
export interface StageGates {
  /** Whether the model is in the pricing table → if not, 400 (block) */
  modelGate: boolean;
  /** identity/inspectAndRecord instrumentation */
  identityRecord: boolean;
  /** rate limit (enforceRateLimit + recordInputTokenUsage) */
  rateLimit: boolean;
  /** credit report (tryReportCreditFromPath + writeFailedReportRaw) */
  creditReport: boolean;
  /** opik trace + span reporting */
  opik: boolean;
  /** writeLog(event:"usage") — write usage to the CH table after stream/non-stream completes */
  writeLogUsage: boolean;
  /** emitModelIntentTelemetry — write tool_use intent to the tool_call_logs table */
  modelIntentTelemetry: boolean;
  /** fetch with AbortSignal.timeout(config.forwardTimeoutMs) */
  forwardTimeout: boolean;
  /** forward a second time when a cost-guard retryTarget exists (including the anthropic sanitizeForRetry hook) */
  forwardRetry: boolean;
  /** systemUser short-circuit (passthrough directly when systemUserId matches, skipping session/injection) */
  systemUser: boolean;
}

export type StagePreset = "full" | "minimal" | "observe-only";

export const STAGE_PRESETS: Record<StagePreset, StageGates> = {
  /**
   * The full version of the existing behavior carried by handler.ts / anthropicHandler.ts.
   * It must stay fully equivalent after switching to the pipeline; not a single gate may be missing.
   */
  full: {
    modelGate: true,
    identityRecord: true,
    rateLimit: true,
    creditReport: true,
    opik: true,
    writeLogUsage: true,
    modelIntentTelemetry: true,
    forwardTimeout: true,
    forwardRetry: true,
    systemUser: true,
  },
  /**
   * Initial version for codex/workbuddy — only the core path (forward+stream), no observability/billing/rate limiting.
   * Behavior is fully identical to the pre-migration codex/wb handlers (the blueprint's explicit "zero regression" baseline).
   *
   * On Phase 5 opt-in, flip to true one by one per §5.1~5.8, each step as an independent commit.
   */
  minimal: {
    modelGate: false,
    identityRecord: false,
    rateLimit: false,
    creditReport: false,
    opik: false,
    writeLogUsage: false,
    modelIntentTelemetry: false,
    forwardTimeout: false,
    forwardRetry: false,
    systemUser: false,
  },
  /**
   * observe-only — Phase 5 midway state: all observability stages on, but billing/rate limiting still off.
   * Used to first check that the data flow is normal before deciding whether to flip creditReport/rateLimit.
   */
  "observe-only": {
    modelGate: false,
    identityRecord: true,
    rateLimit: false,
    creditReport: false,
    opik: true,
    writeLogUsage: true,
    modelIntentTelemetry: true,
    forwardTimeout: false,
    forwardRetry: false,
    systemUser: false,
  },
};

/**
 * Wire protocol label of the archive hook.
 *
 * Note: it is not a field on AgentStrategy — `stageArchive` receives the literal passed by each runner
 * through its own `ArchiveProtocol` parameter. The type is defined here because
 * stages/archive.ts imports from here.
 */
export type ArchiveProtocol = "anthropic" | "openai" | "responses";

/**
 * AgentStrategy — extends the existing AgentAdapter, adding stage gating and client-specific fields.
 *
 * Only `stageGates` is actually consumed by the pipeline (17 `_gates.<name>` uses in the runners).
 * The remaining fields fall into two categories:
 *   - `supportsSessionForm` / `bypassOnPresetFail`: **reserved by contract**, currently no consumers,
 *     see each field's JSDoc. Values must be correct so the semantics are in place when wired up in the future.
 *   - Dead fields removed (2026-10-08 cleanup): `archiveProtocol` / `buildFormResponse` /
 *     `detectClientCapabilities` / `detectDefaultGate` — these 4 have
 *     zero read sites on the strategy; the implementations that actually take effect are respectively in:
 *       * archiveProtocol      → runner passes a hardcoded literal to stageArchive
 *       * buildFormResponse    → session/{codebuddy,claude-code,workbuddy,dsh,opencode}/form.ts
 *       * detectClientCapabilities → session/client-capabilities.ts
 *       * detectDefaultGate    → session/codebuddy/init.ts::detectCodexDefaultGate
 *     Keeping them would create a second source of truth in the strategy that is inconsistent with the implementation.
 */
export interface AgentStrategy extends AgentAdapter {
  /**
   * Whether to show the 5-step form. false means a header-only or headless client.
   *
   * Warning: reserved by contract, currently no consumers — the original consumer `stages/session-init.ts` was
   * replaced by `stages/session-init-orchestrate.ts` in Round 18 and deleted (that orchestration stage
   * calls `handleSessionInit` directly, not through this field). The header-only / headless
   * detection that actually takes effect is in `session/codebuddy/init.ts` (judging agentSource by the `isHeaderOnlyAgent` Set)
   * and the dshHeadless branch inlined in the runner. The values are kept to maintain the addendum §4.3 contract.
   */
  readonly supportsSessionForm: boolean;

  /**
   * addendum §4.3: pi/hermes/openclaw always bypass on preset failure in every scenario and never show the form.
   * Only header-only agents with supportsSessionForm=false are set to true.
   *
   * Warning: reserved by contract, currently no consumers (same as `supportsSessionForm`; the two stages at the original consumer
   * `stages/session-init.ts:70` were deleted). The bypass that actually takes effect is the
   * `isHeaderOnlyAgent(agentSource)` branch at `session/codebuddy/init.ts:835`.
   */
  readonly bypassOnPresetFail?: boolean;

  /** Gate switch for each stage — the only field of this interface actually consumed by the pipeline */
  readonly stageGates: StageGates;
}

/**
 * Whitelist of valid protocol x agent combinations (adopted from blueprint-review §6).
 * assertValidCombo() validates at the pipeline/run.ts entry, to prevent mistakes when replacing the 60+ server.ts routes.
 */
export const VALID_COMBOS: ReadonlySet<string> = new Set([
  "openai-chat:codebuddy",
  "openai-chat:dsh",
  "openai-chat:opencode",
  "openai-chat:pi",
  "openai-chat:unknown",
  "anthropic:claude-code",
  "responses:codex",
  "responses:workbuddy",
]);

export function assertValidCombo(
  protocolName: string,
  agentKind: AgentKind | null,
): void {
  if (!agentKind) return; // passthrough / utility are not bound to an agent
  const key = `${protocolName}:${agentKind}`;
  if (!VALID_COMBOS.has(key)) {
    throw new Error(
      `Invalid protocol×agent combination: ${key}. Add to VALID_COMBOS if intentional.`,
    );
  }
}
