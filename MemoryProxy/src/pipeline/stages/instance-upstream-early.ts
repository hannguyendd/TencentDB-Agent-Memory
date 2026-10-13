/**
 * stages/instance-upstream-early.ts — early instance upstream config resolution (Phase 4 stage-ification).
 *
 * Extracted from the identical ~40-line 4-state Resolution resolve block in the openai-chat + anthropic runners:
 *   1. resolveForAgent / resolveExtraction fetch the conv / extract upstreams
 *   2. External customer hits blocked/unmanaged -> immediate 400 (systemUser channel skips this)
 *   3. shouldOverride computes _isCustomUpstream (decides later model gate / credit report)
 *
 * The caller gets the result: if blockedResp !== null -> return it directly to the client;
 * otherwise destructure { earlyConvResolution, earlyExtractRow, earlySysMatch,
 * isCustomUpstream } and continue the pipeline.
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import {
  getInstanceUpstreamConfigs,
  resolveForAgent,
  resolveExtraction,
  shouldOverride,
  type Resolution,
} from "../../instance-upstream-cache.js";
import type { InstanceUpstreamRow } from "../../instance-upstream-cache.js";
import { matchSystemUserByUserId, hasSystemUsers } from "../../systemUser.js";
import type { SystemUserMatch } from "../../systemUser.js";
import { isLegacyProxyPath } from "../../routes/whitelist.js";

export interface InstanceUpstreamEarlyInput {
  c: Context;
  config: ProxyConfig;
  spaceId: string;
  earlyUserId: string;
  /** error envelope format:
   *  - openai: {code, error_code, message, detail}
   *  - anthropic: {type:"error", error:{type,message}, detail} */
  errorEnvelope: "openai" | "anthropic";
}

export interface InstanceUpstreamEarlyResult {
  /** non-null -> the caller returns this response immediately, not continuing the pipeline */
  blockedResp: Response | null;
  agent: string | undefined;
  legacyProxy: boolean;
  earlyConvResolution: Resolution;
  earlyExtractRow: InstanceUpstreamRow | null;
  earlySysMatch: SystemUserMatch | null;
  isCustomUpstream: boolean;
}

export async function stageInstanceUpstreamEarly(
  input: InstanceUpstreamEarlyInput,
): Promise<InstanceUpstreamEarlyResult> {
  const { c, config, spaceId, earlyUserId } = input;

  const agent = c.req.path.split("/").filter(Boolean)[0] ?? undefined;
  const instanceConfigs = await getInstanceUpstreamConfigs(
    config.coreSkill, spaceId, config.instanceUpstream,
  );
  const legacyProxy = isLegacyProxyPath(c.req.path);
  const earlyConvResolution: Resolution = legacyProxy
    ? { kind: "official", row: null }
    : resolveForAgent(instanceConfigs, agent ?? "");
  const earlyExtractRow = resolveExtraction(instanceConfigs);
  const earlySysMatch = hasSystemUsers() ? matchSystemUserByUserId(earlyUserId) : null;

  // external conversation request: blocked / unmanaged -> early 400 (systemUser goes through extraction and is never blocked)
  let blockedResp: Response | null = null;
  if (earlySysMatch === null) {
    if (earlyConvResolution.kind === "blocked") {
      // The openai version carries the full "Ask the administrator..." suffix; the anthropic version is shorter.
      // Fully aligned with the original text; the suffix difference is preserved.
      const blockedMsg = earlyConvResolution.reason === "default_disabled"
        ? (input.errorEnvelope === "anthropic"
            ? `Default upstream group is disabled; agent "${agent ?? ""}" has no upstream to route to.`
            : `Default upstream group is disabled; agent "${agent ?? ""}" has no upstream to route to. Ask the administrator to enable the default group in Panel, or add a custom group covering this agent.`)
        : (input.errorEnvelope === "anthropic"
            ? `Custom upstream group "${earlyConvResolution.group_id}" (covering agent "${agent ?? ""}") is disabled.`
            : `Custom upstream group "${earlyConvResolution.group_id}" (covering agent "${agent ?? ""}") is disabled. Ask the administrator to enable it in Panel, or delete the group so the agent becomes unmanaged and can be reassigned.`);
      const blockedDetail = {
        agent: agent ?? "",
        group_id: earlyConvResolution.group_id,
        reason: earlyConvResolution.reason,
      };
      blockedResp = input.errorEnvelope === "anthropic"
        ? c.json({
            type: "error",
            error: { type: "upstream_disabled", message: blockedMsg },
            detail: blockedDetail,
          }, 400)
        : c.json({
            code: 400,
            error_code: "UPSTREAM_DISABLED",
            message: blockedMsg,
            detail: blockedDetail,
          }, 400);
    } else if (earlyConvResolution.kind === "unmanaged") {
      const unmMsg = input.errorEnvelope === "anthropic"
        ? `Agent "${earlyConvResolution.agent}" is not assigned to any upstream group in this instance.`
        : `Agent "${earlyConvResolution.agent}" is not assigned to any upstream group in this instance. Ask the administrator to add it to the default group or a custom group in Panel.`;
      const unmDetail = {
        agent: earlyConvResolution.agent,
        hint: "Ask the instance administrator to add this agent to a group in Panel.",
      };
      blockedResp = input.errorEnvelope === "anthropic"
        ? c.json({
            type: "error",
            error: { type: "agent_not_configured", message: unmMsg },
            detail: unmDetail,
          }, 400)
        : c.json({
            code: 400,
            error_code: "AGENT_NOT_CONFIGURED",
            message: unmMsg,
            detail: unmDetail,
          }, 400);
    }
  }

  // caller dispatch: systemUser looks at extraction, external customers look at conversation
  const isCustomUpstream = earlySysMatch !== null
    ? shouldOverride(earlyExtractRow)
    : shouldOverride(earlyConvResolution);

  return {
    blockedResp,
    agent,
    legacyProxy,
    earlyConvResolution,
    earlyExtractRow,
    earlySysMatch,
    isCustomUpstream,
  };
}
