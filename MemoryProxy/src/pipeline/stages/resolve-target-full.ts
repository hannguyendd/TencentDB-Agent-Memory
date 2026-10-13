/**
 * stages/resolve-target-full.ts — full cost-guard target resolution stage.
 *
 * Extracted from the identical ~35-line target resolution block in the openai-chat + anthropic runners:
 *   1. per-agent effectiveApiKey (agents map first, falling back to upstream.apiKey if missing)
 *   2. defaultUpstreamUrl (per-agent → protocol-specific fallback → upstream.url)
 *   3. forwardEndpoint (matches whitelist / fallback)
 *   4. costGuardMode (markerOptIn=false → "full"; true → resolveCostGuardMode)
 *   5. resolveForwardTarget → get the final ForwardTarget
 *
 * Difference from stages/resolve-target.ts: the old one is a raw resolveForwardTarget wrapper
 * (does one thing only); this stage is a "full assembly" pipeline, including all related upstream URL /
 * apiKey / endpoint computation (fully aligned with the runners' inline code).
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import {
  resolveForwardTarget,
  type ForwardTarget,
} from "../../guard-adapter.js";
import { matchWhitelistEndpoint, hasCostGuardMarker, resolveCostGuardMode } from "../../routes/whitelist.js";

export interface ResolveTargetFullInput {
  c: Context;
  config: ProxyConfig;
  protocol: "openai" | "anthropic";
  agentFromPath?: string;
  keyId: string;
  sessionKey: string;
  messages: unknown[];
  hasTools: boolean;
  body: Record<string, unknown>;
  modelId: string;
  headers: Record<string, string>;
  traceId: string;
  startTime: string;
  spaceId: string;
}

export interface ResolveTargetFullResult {
  target: ForwardTarget;
  effectiveApiKey: string;
  forwardEndpoint: string;
  costGuardMode: string;
  /** agentUpstreamEntry — kept for the caller to determine case (a)/(b)/(c) */
  hasAgentEntry: boolean;
}

export async function stageResolveTargetFull(
  input: ResolveTargetFullInput,
): Promise<ResolveTargetFullResult> {
  const { c, config, protocol, agentFromPath } = input;

  const agentUpstreamEntry = agentFromPath ? config.upstream.agents?.[agentFromPath] : undefined;
  const effectiveApiKey = agentUpstreamEntry
    ? (agentUpstreamEntry.apiKey ?? "")
    : config.upstream.apiKey;

  // defaultUpstreamUrl: openai uses upstream.url; anthropic has an additional anthropicUpstream fallback
  const defaultUpstreamUrl = protocol === "anthropic"
    ? (agentUpstreamEntry?.url || config.costGuard.anthropicUpstream?.url || config.upstream.url)
    : (agentUpstreamEntry?.url ?? config.upstream.url);

  // Whitelist endpoint: openai=/chat/completions, anthropic=/messages
  const forwardEndpoint = matchWhitelistEndpoint(c.req.path)?.upstreamEndpoint
    ?? (protocol === "anthropic" ? "/messages" : "/chat/completions");

  const costGuardMode = config.costGuard.markerOptIn ? resolveCostGuardMode(c.req.path) : "full";
  const target: ForwardTarget = await resolveForwardTarget(config, {
    keyId: `${input.keyId}:${input.sessionKey}`,
    messages: input.messages,
    protocol,
    hasTools: input.hasTools,
    body: input.body,
    modelId: input.modelId,
    defaultUpstreamUrl,
    requestPath: forwardEndpoint,
    headers: input.headers,
    traceId: input.traceId,
    startTime: input.startTime,
    spaceId: input.spaceId,
    // markerOptIn=false (default/prod): every request goes through the router (the `/cost-guard` path 404s)
    // markerOptIn=true (test): the router is enabled only when the marker is present; bare paths passthrough
    useGuard: config.costGuard.markerOptIn ? hasCostGuardMarker(c.req.path) : true,
    agentName: agentFromPath,
    costGuardMode,
  });

  return {
    target,
    effectiveApiKey,
    forwardEndpoint,
    costGuardMode,
    hasAgentEntry: !!agentUpstreamEntry,
  };
}
