/**
 * handler-glue.ts — bridges the per-turn lifecycle in handler.ts /
 * anthropicHandler.ts to core `/v3/skill/conversation/add`.
 *
 * The proxy only takes the **new path**: when each real-human conversation round ends (the agent gives a final reply
 * with no tool_use), the conversation slice of this round is pushed to core, which accumulates it
 * and decides on its own when to archive once a threshold is reached (entering the skill extraction pipeline).
 *
 * History: there used to be an old path SkillExtractTrigger -> /v3/skill/extract, where the proxy
 * triggered an extraction every turn and relied on the proxy-side KvExtractStore to hold the buffer. It has been deleted,
 * see commit history. The entry point for the agent to trigger extraction actively via skill-bridge (/v3/skill/extract)
 * has also been commented out -- core plans to ship a "manual archive" endpoint, at which point the agent tools
 * will be re-pointed to that endpoint.
 *
 * Trigger timing: **round-level** -- only when the agent gives a final reply (no tool_use /
 * tool_calls) is it pushed to core. Intermediate states (the agent is calling tools, and the client will bring back
 * tool_result to continue this round) are skipped directly, and sent together once the round truly ends.
 *
 * Why not turn-level (send on every HTTP):
 *   From the proxy's perspective one HTTP is a "turn", but one real-human
 *   question in Claude Code / CodeBuddy triggers N HTTPs (tool-use loop). If sent on every turn, the core buffer
 *   accumulates extremely fast -- by default 10 tool_uses trigger one archive, and in production a few conversation rounds
 *   can produce 30+ archives. Round-level triggering guarantees "1 real-human Q&A = 1 add",
 *   with clear semantics and the RPC count reduced by ~N times. See
 *   docs/design/2026-07-17-conversation-normalize.md.
 */

import type { ProxyConfig } from "../types.js";
import type { AssetCapabilityFlags } from "../injection/types.js";
import { getCoreSkillClient } from "./core-client.js";
import {
  countToolCalls,
  findLastFinalAssistant,
  isFinalAnswer,
  normalizeConversation,
} from "./normalize-conversation.js";

/** loose message shape for internal use in this module */
interface IncomingMsg {
  role?: string;
  content?: unknown;
  tool_calls?: unknown[];
}

export interface TriggerInput {
  config: ProxyConfig;
  sessionKey: string;
  /** Client type (the first segment of the URL path), used for the three-segment isolation key; defaults to `claude-code`. */
  agentSource: string;
  sessionInfo: Record<string, unknown> | null | undefined;
  inputMessages: unknown[] | undefined;
  assistantMessage: Record<string, unknown> | null | undefined;
  /**
   * The protocol the request goes through -- determines the parsing rules for messages/assistantMessage.
   *   "anthropic" → anthropicHandler.ts (/v1/messages), content may be a blocks array,
   *                 tool_result hides in role=user, tool_use hides in role=assistant
   *   "openai"    → handler.ts (/v1/chat/completions), content is generally a string,
   *                 tool_result is a separate role=tool message, tool_calls is a separate assistant field
   *   "responses" → codexHandler.ts (/responses), the top level is input[] rather than messages[],
   *                 items are discriminated by type: message / function_call / function_call_output /
   *                 reasoning (see the top of normalize-conversation.ts)
   *
   * The proxy already knows explicitly which protocol each request takes via the route whitelist (see routes/whitelist.ts),
   * so it is passed explicitly by the caller (handler.ts / anthropicHandler.ts / codexHandler.ts) rather than inferred.
   */
  protocol: "anthropic" | "openai" | "responses";
  /** Per-user asset capability flags; skill=false disables extraction collection. */
  assetCapabilities?: AssetCapabilityFlags;
  /** Optional override (e.g. SSE accumulators contain the truth in streaming mode). */
  toolCallCountOverride?: number;
}

export async function triggerSkillExtractIfReady(input: TriggerInput): Promise<void> {
  try {
    const { config, sessionKey, sessionInfo, inputMessages, assistantMessage } = input;
    if (input.assetCapabilities?.skill === false) return;
    if (!sessionKey || !sessionInfo) return;

    const userId = sessionInfo.user_id as string | undefined;
    const teamId = sessionInfo.team_id as string | undefined;
    const agentId = sessionInfo.agent_id as string | undefined;
    if (!userId || !teamId || !agentId) return;

    if (!config.coreSkill?.endpoint || !config.coreSkill?.serviceToken) return;

    const spaceId = sessionInfo.space_id as string | undefined;
    if (!spaceId) {
      console.warn(
        `[skill-conversation-add] skipped: no space_id on sessionInfo session=${sessionKey}`,
      );
      return;
    }

    const msgs: IncomingMsg[] = Array.isArray(inputMessages)
      ? (inputMessages as IncomingMsg[])
      : [];
    const rawAsst = (assistantMessage as Record<string, unknown>) ?? {};
    const hasAsst = Boolean(rawAsst && (rawAsst.role || rawAsst.content || rawAsst.tool_calls));
    const rawMsgs = msgs as unknown[] as Array<Record<string, unknown>>;

    // -- round-level trigger gate --
    // Only a final answer continues; intermediate states containing tool_use / tool_calls return directly.
    // The determination relies on the count of tool_use / tool_calls in assistantMessage;
    // in the stream branch assistantMessage.content is flattened to a string and the blocks info is lost,
    // in which case input.toolCallCountOverride is authoritative (see anthropicHandler.ts:1592-1597).
    if (!isFinalAnswer(hasAsst ? rawAsst : null, input.toolCallCountOverride)) return;

    // -- this round's slice --
    // slice start = after the last "final assistant" = the start of this round's user input.
    // If not found (first round / history is all intermediate states) → -1 + 1 = 0, naturally sending the whole segment, which is semantically correct.
    const lastFinal = findLastFinalAssistant(rawMsgs, input.protocol);
    const startIdx = lastFinal + 1;

    // Branch by protocol to do 5-role normalization -- expand anthropic content blocks / openai tool_calls,
    // recognize tool_use / tool_result and convert them to role=tool_call / role=tool_result respectively.
    // agentSource is used to extract user text by client rules (see agent-adapters/)
    // See normalize-conversation.ts and docs/design/2026-07-17-conversation-normalize.md
    const turnMessages = normalizeConversation(
      rawMsgs.slice(startIdx),
      input.protocol,
      hasAsst ? rawAsst : null,
      input.agentSource,
    );
    if (turnMessages.length === 0) return;

    try {
      const client = getCoreSkillClient(config.coreSkill);
      const t0 = Date.now();
      const result = await client.addConversation(
        {
          session_id: sessionKey,
          space_id: spaceId,
          user_id: userId,
          team_id: teamId,
          agent_id: agentId,
          task_id: sessionInfo.task_id as string | undefined,
          messages: turnMessages,
        },
        // core Shark uses x-tdai-service-id = the real kernel instance ID
        { serviceId: spaceId },
      );
      if (result.status === "archived" && result.archived) {
        console.log(
          `[skill-conversation-add] archived session=${sessionKey} task_id=${result.archived.task_id}` +
            ` reason=${result.archived.reason} took=${Date.now() - t0}ms` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}`,
        );
      } else {
        // status=ok: archive not triggered -- core has accumulated this round into the buffer, and will only archive
        // after a few more rounds reach the threshold.
        console.log(
          `[skill-conversation-add] appended session=${sessionKey}` +
            ` round_msgs=${turnMessages.length} slice=${startIdx}/${rawMsgs.length}` +
            ` took=${Date.now() - t0}ms`,
        );
      }
    } catch (err) {
      // A core failure does not affect the main response chain; watch the metrics before deciding whether to escalate to error
      console.warn(
        "[skill-conversation-add] addConversation failed:",
        err instanceof Error ? err.message : String(err),
      );
    }
  } catch (err) {
    // Conservative: swallow any exception to avoid affecting the main response chain.
    console.warn(
      "[skill-extract-glue] triggerSkillExtractIfReady swallowed error:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

// Compat: some old code imports countToolCalls from handler-glue
export { countToolCalls };
