/**
 * stages/prewarm-injection.ts — hook-cache prewarm gate + call after session-init.
 *
 * Extracted from the 100% identical prewarm
 * gate+call block (~30 lines/runner) in the 4 runners (openai-chat / anthropic / codex / workbuddy):
 *   if (!bypassed && justRegistered && sessionInfo && !memCommandPending
 *       && injection.enabled && injectors.length > 0) {
 *     import injection; prewarmFromConfig({...}, { clearBefore: true });
 *   }
 *
 * The differences are only logTag (each runner's own warn prefix) and the callerUserKey source (openai-chat
 * uses apiKey, the other 3 use callerUserKey), passed in parameterized by the caller.
 *
 * clearBefore:true is always constant — on first init the cache is empty so it is a no-op, and on reset-flow clearing the old
 * agent cache is necessary; unified semantics are safer (blueprint §5.1 red-line).
 *
 * Fail-silent: a prewarm failure only warns, does not throw; resolveHookBlocks in pipeline.ts
 * has a cache-miss -> execute() fallback as a safety net.
 */

import type { ProxyConfig } from "../../types.js";
import type { SessionInfo } from "../../session/types.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";

export interface PrewarmInjectionInput {
  /** relevant fields of the session-init result, picked out of initResult by the caller and passed in */
  bypassed: boolean;
  justRegistered: boolean;
  sessionInfo: unknown;
  agentDetail: unknown;
  taskDetail: unknown;
  /** do not prewarm when a mem command interception is pending (a mem command changes session state; prewarming early would pollute it) */
  memCommandPending: boolean;

  config: ProxyConfig;
  sessionKey: string;
  userId: string | null;
  agentSource: string;
  spaceId?: string;
  assetCapabilities?: AssetCapabilityFlags;
  /** x-tdai-user-key for TDAI ACL verification; openai-chat passes apiKey, the other 3 pass callerUserKey */
  callerUserKey?: string;
  /** warn prefix, unique to each runner ("[hook-cache] handler prewarm error" / "[codex] prewarm error" etc.) */
  logTag: string;
}

export async function stagePrewarmInjection(input: PrewarmInjectionInput): Promise<void> {
  if (
    input.bypassed ||
    !input.justRegistered ||
    !input.sessionInfo ||
    input.memCommandPending ||
    !input.config.injection?.enabled ||
    (input.config.injection.injectors?.length ?? 0) === 0
  ) {
    return;
  }

  try {
    const mod = await import("../../injection/index.js");
    await mod.prewarmFromConfig(input.config, {
      keyId: input.sessionKey,
      userId: input.userId || "anonymous",
      agentSource: input.agentSource,
      spaceId: input.spaceId,
      sessionInfo: input.sessionInfo as SessionInfo,
      agentDetail: (input.agentDetail ?? null) as import("../../session/types.js").AgentDetail | null,
      taskDetail: (input.taskDetail ?? null) as import("../../session/types.js").TaskDetail | null,
      assetCapabilities: input.assetCapabilities,
      callerUserKey: input.callerUserKey,
    }, { clearBefore: true });
  } catch (err) {
    console.warn(input.logTag, err instanceof Error ? err.message : String(err));
    // Don't re-throw: the cache-miss -> execute() fallback in pipeline.ts resolveHookBlocks is the safety net
  }
}
