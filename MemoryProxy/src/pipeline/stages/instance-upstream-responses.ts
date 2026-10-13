/**
 * stages/instance-upstream-responses.ts — a stage dedicated to codex + workbuddy that does instance
 * upstream resolution + 400 early exit + override application in one go.
 *
 * Unlike openai-chat/anthropic, which use the two-step approach of stageInstanceUpstreamEarly + stageInstanceUpstreamOverride,
 * the reason is that codex/wb's forwardToUpstream runs at the tail of the handler,
 * and early on did not make the instance decision together with modelGate (it only computed shouldOverride for modelGate).
 * Keeping the override inside forwardToUpstream is appropriate (spaceId + path are both in hand),
 * but the blocked/unmanaged 400 + override application is extracted into a single stage, eliminating ~48 lines
 * of duplication between codex/wb.
 *
 * The two stages used by openai-chat/anthropic stay "logically equivalent, different timing" with this stage:
 *   - blocked → 400 (upstream_disabled, consistent with openai-chat's stageInstanceUpstreamEarly)
 *   - unmanaged → 400 (agent_not_configured, same as above)
 *   - override → write body.model + skipCreditReport=true + return the new url/headers override
 *   - official → leave the global upstream untouched
 *
 * Differences stay in place: workbuddy's upstreamPath prefix stripping (`replace(/^\/workbuddy\/[^/]+/, "")`)
 * is passed in by the caller via the pathForOverride parameter; codex uses c.req.path.
 */

import type { ProxyConfig } from "../../types.js";
import { getInstanceUpstreamConfigs, resolveForAgent } from "../../instance-upstream-cache.js";
import { joinUrl } from "../../guard-adapter.js";

export interface InstanceUpstreamResponsesInput {
  agent: string;
  spaceId: string;
  config: ProxyConfig;
  /** The path part joined onto row.base_url when applying the override (codex: c.req.path, wb: after prefix stripping) */
  pathForOverride: string;
  /** Whether to force official (codex's isLegacyProxyPath /proxy/<sid>/ scenario → true) */
  forceOfficial?: boolean;
}

export interface InstanceUpstreamResponsesBlocked {
  kind: "blocked" | "unmanaged";
  /** The 400 Response body (JSON) returned directly to the client */
  errorBody: {
    type: "error";
    error: { type: string; message: string };
    detail: Record<string, unknown>;
  };
}

export interface InstanceUpstreamResponsesResult {
  /** New upstream URL after the override is applied (undefined when there is no override) */
  overrideUrl?: string;
  /** Header changes after the override is applied (custom_unified: override authorization + delete x-api-key; custom_passthrough: empty) */
  headerUpdates?: { authorization?: string; deleteXApiKey?: boolean };
  /** model_id to replace body.model with after the override is applied (empty = leave unchanged) */
  bodyModelOverride?: string;
  /** Custom upstream is paid by the user → skip credit */
  skipCreditReport: boolean;
}

/**
 * Main entry. When it returns { kind: "blocked"|"unmanaged", errorBody }, the caller should respond 400 immediately;
 * otherwise the caller applies result.overrideUrl/headerUpdates/bodyModelOverride/skipCreditReport
 * directly (all undefined/false when no override is triggered).
 */
export async function stageInstanceUpstreamResponses(
  input: InstanceUpstreamResponsesInput,
): Promise<InstanceUpstreamResponsesBlocked | InstanceUpstreamResponsesResult> {
  const { agent, spaceId, config, pathForOverride, forceOfficial } = input;

  const instanceConfigs = await getInstanceUpstreamConfigs(
    config.coreSkill,
    spaceId,
    config.instanceUpstream,
  );

  const resolution = forceOfficial
    ? { kind: "official" as const, row: null }
    : resolveForAgent(instanceConfigs, agent);

  if (resolution.kind === "blocked") {
    return {
      kind: "blocked",
      errorBody: {
        type: "error",
        error: {
          type: "upstream_disabled",
          message: resolution.reason === "default_disabled"
            ? `Default upstream group is disabled; agent "${agent}" has no upstream to route to.`
            : `Custom upstream group "${resolution.group_id}" (covering agent "${agent}") is disabled.`,
        },
        detail: { agent, group_id: resolution.group_id, reason: resolution.reason },
      },
    };
  }

  if (resolution.kind === "unmanaged") {
    return {
      kind: "unmanaged",
      errorBody: {
        type: "error",
        error: {
          type: "agent_not_configured",
          message: `Agent "${agent}" is not assigned to any upstream group in this instance.`,
        },
        detail: {
          agent,
          hint: "Ask the instance administrator to add this agent to a group in Panel.",
        },
      },
    };
  }

  if (resolution.kind === "override") {
    const row = resolution.row;
    const overrideUrl = joinUrl(row.base_url, pathForOverride);
    const headerUpdates: NonNullable<InstanceUpstreamResponsesResult["headerUpdates"]> = {};
    if (row.mode === "custom_unified" && row.api_key) {
      headerUpdates.authorization = `Bearer ${row.api_key}`;
      headerUpdates.deleteXApiKey = true;
    }
    return {
      overrideUrl,
      headerUpdates,
      bodyModelOverride: row.model_id || undefined,
      skipCreditReport: true,
    };
  }

  // official / zero-row fallback: keep the global upstream
  return { skipCreditReport: false };
}

export function isInstanceUpstreamBlocked(
  r: InstanceUpstreamResponsesBlocked | InstanceUpstreamResponsesResult,
): r is InstanceUpstreamResponsesBlocked {
  return (r as InstanceUpstreamResponsesBlocked).kind === "blocked" ||
    (r as InstanceUpstreamResponsesBlocked).kind === "unmanaged";
}
