/**
 * stages/rate-limit.ts — rate-limit stage (Phase 4).
 *
 * Extracted from the enforceRateLimit calls at handler.ts:1606-1623 / anthropicHandler.ts:1499-1520.
 * codex/wb originally lacked it (handler-audit bug B1 P0); in Phase 5.7 opt-in it takes effect via
 * stageGates.rateLimit=true.
 *
 * Like stages/credit.ts, this stage is a thin wrapper that delegates to rate-limit/guard.ts.
 */

import type { ProxyConfig } from "../../types.js";
import {
  enforceRateLimit,
  isRateLimitExceededError,
  recordInputTokenUsage,
} from "../../rate-limit/guard.js";
import type { RateLimitProtocol } from "../../rate-limit/guard.js";
import type { UsageProtocol } from "../../rate-limit/usage.js";

export interface RateLimitEnforceInput {
  config: ProxyConfig;
  instanceId?: string;
  modelId: string;
  protocol: RateLimitProtocol;
  isCustomUpstream: boolean;
}

export interface RateLimitRecordInput {
  config: ProxyConfig;
  instanceId?: string;
  modelId: string;
  usage: Record<string, unknown> | null | undefined;
  protocol: UsageProtocol;
  isCustomUpstream: boolean;
}

/**
 * Pre-request rate-limit stage. On a limit hit, throws RateLimitExceededError and the caller converts it to 429.
 * custom upstream short-circuits (when isCustomUpstream=true, it does not enter the rate-limit ledger).
 */
export async function stageEnforceRateLimit(input: RateLimitEnforceInput): Promise<void> {
  if (input.isCustomUpstream) return;
  await enforceRateLimit({
    config: input.config,
    instanceId: input.instanceId,
    modelId: input.modelId,
    protocol: input.protocol,
  });
}

/** After stream/non-stream completes -> put the actual usage back into the rate-limit bucket */
export async function stageRecordInputTokenUsage(input: RateLimitRecordInput): Promise<void> {
  if (input.isCustomUpstream) return;
  await recordInputTokenUsage({
    config: input.config,
    instanceId: input.instanceId,
    modelId: input.modelId,
    usage: input.usage,
    protocol: input.protocol,
  });
}

export { isRateLimitExceededError };
