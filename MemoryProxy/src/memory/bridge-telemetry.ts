/**
 * Bridge-side tool-call telemetry helper (shared by memory-bridge + skill-bridge).
 *
 * Design: every time an upstream fetch completes (success or failure), emit one kind='bridge_call'.
 *      The caller is responsible for sanitizing the body to <= 512 bytes (this function does no further cleaning), only passing it through.
 *
 * Hard constraints (section 7.-1):
 *   - return void synchronously
 *   - swallow sink exceptions silently
 *   - body/sub are already prepared by the caller; never read the session store additionally
 */
import { writeSkillUsageRow, writeToolCallRow, type SkillUsageLogInput, type ToolCallLogInput } from "../clickhouse.js";

export interface BridgeCallTelemetryInput {
  sessionKey: string;
  turnSeq?: number;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  /** "claude-code" | "codebuddy" | "unknown" — reverse-derived from the sessionKey prefix */
  agentSource: string;
  /** "memory-bridge" | "skill-bridge" */
  bridgeSource: string;
  /** The concrete sub string ("atomic/search" / "skill/get" etc.) */
  executedEndpoint: string;
  /** Sanitized, truncated outbound body (<= 512 bytes) */
  requestBody: string;
  /** upstream HTTP status (may pass 0 or 502 on network failure) */
  upstreamStatus: number;
  /** upstream latency in milliseconds */
  elapsedMs: number;
  /**
   * Reason a pre-validation failed. Empty/unset = the request reached upstream (success or 4xx/5xx).
   * Non-empty = the proxy returned early before reaching the fetcher. See the comment on clickhouse.ts ToolCallLogInput.
   */
  rejectReason?: string;
}

/**
 * Emit one bridge_call telemetry event. The sink defaults to clickhouse.writeToolCallRow.
 * Swallows exceptions internally and never throws.
 */
export function emitBridgeToolCallTelemetry(
  input: BridgeCallTelemetryInput,
  sink: (row: ToolCallLogInput) => void = writeToolCallRow,
): void {
  try {
    const row: ToolCallLogInput = {
      timestamp: new Date().toISOString(),
      sessionKey: input.sessionKey,
      turnSeq: input.turnSeq,
      spaceId: input.spaceId,
      userId: input.userId,
      teamId: input.teamId,
      agentId: input.agentId,
      agentSource: input.agentSource,
      kind: "bridge_call",
      bridgeSource: input.bridgeSource,
      initiatedTool: "",
      executedEndpoint: input.executedEndpoint,
      requestBody: input.requestBody,
      upstreamStatus: input.upstreamStatus,
      elapsedMs: input.elapsedMs,
      rejectReason: input.rejectReason,
    };
    try {
      sink(row);
    } catch {
      // If the sink throws → telemetry never blocks the business
    }
  } catch {
    // Also swallow exceptions from constructing the input
  }
}

/**
 * Reverse-derive agentSource from a proxy session-key.
 *   "claude-code:conv-abc" → "claude-code"
 *   "codebuddy:conv-abc"   → "codebuddy"
 *   "conv-abc" (no prefix)    → "unknown"
 */
export function agentSourceFromSessionKey(sessionKey: string): string {
  const idx = sessionKey.indexOf(":");
  if (idx <= 0) return "unknown";
  return sessionKey.slice(0, idx);
}

/**
 * Pre-validation-failure telemetry helper -- the proxy layer rejected the request and it never reached the upstream fetcher.
 *
 * Most early pre-validation exits haven't even parsed the session ids yet (missing header / bad content-type /
 * invalid json ...), so the stable fields available are limited. The remaining fields are passed through optionally.
 *
 * Wraps emitBridgeToolCallTelemetry internally; kind is still 'bridge_call', distinguished by rejectReason
 * being non-empty. Old dashboards whose SQL all use kind='bridge_call' keep running untouched,
 * and the new dimension is queried via `WHERE reject_reason != ''`.
 *
 * Hard constraints: return void synchronously, telemetry never blocks the business; sessionKey may be an empty string.
 */
export interface BridgeRejectTelemetryInput {
  /** Fill in when derived; if it cannot be derived in the pre-validation stage (missing header) use "" */
  sessionKey: string;
  bridgeSource: "memory-bridge" | "skill-bridge";
  /** Stable enum value, for GROUP BY -- see the tool_call_logs.reject_reason comment for details */
  rejectReason: string;
  /** HTTP status the proxy returned to the client (401/415/400/...); stored in the upstream_status column */
  httpStatus: number;
  /** Fill in subpath if it can already be computed, otherwise "" */
  executedEndpoint?: string;
  /** Fill in body if already parsed (the caller is responsible for <=512 truncation), otherwise "" */
  requestBody?: string;
  spaceId?: string;
  userId?: string;
  teamId?: string;
  agentId?: string;
  agentSource?: string;
}

export function emitBridgeRejectTelemetry(input: BridgeRejectTelemetryInput): void {
  emitBridgeToolCallTelemetry({
    sessionKey: input.sessionKey,
    spaceId: input.spaceId,
    userId: input.userId,
    teamId: input.teamId,
    agentId: input.agentId,
    agentSource: input.agentSource
      ?? (input.sessionKey ? agentSourceFromSessionKey(input.sessionKey) : "unknown"),
    bridgeSource: input.bridgeSource,
    executedEndpoint: input.executedEndpoint ?? "",
    requestBody: input.requestBody ?? "",
    upstreamStatus: input.httpStatus,
    elapsedMs: 0,
    rejectReason: input.rejectReason,
  });
}

/**
 * Skill usage telemetry helper -- emit one event when the LLM actively views/search_hits.
 *
 * Design: docs/design/2026-09-09-skill-usage-telemetry-and-default-task-recall.md
 *
 * Instrument only real usage signals (the LLM actively calling skill_view / skill_search and hitting),
 * not the `<available_skills>` injection -- to avoid a self-loop (recall → inject → telemetry → higher score).
 *
 * Hard constraints: return void synchronously, swallow sink exceptions silently, never block the main path;
 * when CH is not configured writeSkillUsageRow is itself a no-op.
 */
export interface SkillUsageTelemetryInput {
  /** 'view' | 'search_hit' */
  eventType: string;
  skillId: string;
  sessionKey?: string;
  spaceId?: string;
  teamId?: string;
  agentId?: string;
  userId?: string;
  /** claude-code/codebuddy/... when empty, reverse-derived from the sessionKey prefix */
  agentSource?: string;
}

export function emitSkillUsageTelemetry(
  input: SkillUsageTelemetryInput,
  sink: (row: SkillUsageLogInput) => void = writeSkillUsageRow,
): void {
  try {
    const row: SkillUsageLogInput = {
      timestamp: new Date().toISOString(),
      eventType: input.eventType,
      skillId: input.skillId,
      sessionKey: input.sessionKey,
      spaceId: input.spaceId,
      teamId: input.teamId,
      agentId: input.agentId,
      userId: input.userId,
      agentSource: input.agentSource
        ?? (input.sessionKey ? agentSourceFromSessionKey(input.sessionKey) : "unknown"),
    };
    try {
      sink(row);
    } catch {
      // If the sink throws → telemetry never blocks the business
    }
  } catch {
    // Also swallow exceptions from constructing the input
  }
}
