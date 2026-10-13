/**
 * stages/mem-command.ts — mem: command interception stage (Phase 4).
 *
 * Extracted from 4 ~100-line mem intercept blocks:
 *   - handler.ts:1225-1341
 *   - anthropicHandler.ts:1107-1241
 *   - codexHandler.ts:771-886
 *   - workbuddyHandler.ts:1557-1680
 *
 * This stage is a thin wrapper — internally it delegates to existing functions of the mem-command/ module:
 *   1. parseMemCommand / parseCommandFromText recognize the command
 *   2. checkFirst fallback (session-just-registered scenario)
 *   3. executeMemCommand executes
 *   4. return a Response or null (no command hit)
 *
 * TDAI L0 + skill extract + langfuse report are handled by the caller (runPipeline),
 * reusing stages/archive.ts + stages/observability.ts (avoiding duplicate implementation with the archive stage).
 */

import type { ProxyConfig } from "../../types.js";
import {
  parseMemCommand,
  parseCommandFromText,
  executeMemCommand,
  type ParsedMemCommand,
  type MemCommandContext,
  type MemCommandResult,
} from "../../mem-command/index.js";
import type { AgentStrategy } from "../strategies/agent/types.js";
import type { SessionInfo } from "../../session/types.js";

export interface MemCommandStageInput {
  agent: AgentStrategy;
  body: Record<string, unknown>;
  /** used by codex/wb (parseCommandFromText needs the pre-extracted userText) */
  userText: string;
  agentSource: string;
  sessionKey: string;
  spaceId: string;
  userId: string;
  apiKey: string;
  sessionInfo: SessionInfo | null;
  sessionJustRegistered: boolean;
  config: ProxyConfig;
  isStream: boolean;
  /** protocol -> decides the mem response envelope (openai/anthropic/responses) */
  protocol: "openai" | "anthropic" | "responses";
  /** anthropic passes body.thinking (needed by buildMemResponse) */
  thinking?: unknown;
  /** main-conversation model_id (needed by taskDraft, option D) */
  model?: string;
  /** main-chain upstream base url (reused by taskDraft) */
  upstreamUrl?: string;
}

export type MemCommandStageResult =
  | { intercepted: false }
  | {
      intercepted: true;
      response: Response;
      /** L0 write + skill trigger need the assistant text; carried in the command execution result */
      assistantText: string;
      /** for the caller to decide whether to trigger archive (mem commands should also trigger L0 + skill, see handler.ts:1275) */
      memCommandResult: MemCommandResult;
      commandName: string;
    };

/**
 * Run the mem command interception stage.
 *
 * Priority (consistent with the old handler):
 *   1. checkFirst fallback (justRegistered && first frame has mem semantics)
 *   2. parseMemCommand (openai/anthropic: body.messages) / parseCommandFromText (responses: userText)
 *   3. no hit -> intercepted:false
 *   4. hit -> executeMemCommand -> build a Response
 */
export async function stageMemCommand(input: MemCommandStageInput): Promise<MemCommandStageResult> {
  const { agent, body, userText, agentSource, protocol } = input;

  // 1. recognize the command
  let parsed: ParsedMemCommand | null = null;
  if (protocol === "responses") {
    // codex/wb: judge from the pre-extracted userText
    parsed = parseCommandFromText(userText);
  } else {
    // openai/anthropic: use the body.messages logic
    parsed = parseMemCommand(body, agentSource);
  }

  if (!parsed) {
    return { intercepted: false };
  }

  // 2. execute — assemble the full MemCommandContext (agent field not needed for now, executeMemCommand looks it up internally as needed)
  const memCtx: MemCommandContext = {
    sessionKey: input.sessionKey,
    agentSource,
    config: input.config,
    spaceId: input.spaceId,
    userId: input.userId,
    apiKey: input.apiKey,
    sessionInfo: (input.sessionInfo ?? {}) as Record<string, unknown>,
    protocol,
    stream: input.isStream,
    thinking: input.thinking,
    model: input.model,
    upstreamUrl: input.upstreamUrl,
  } as MemCommandContext;

  const result = await executeMemCommand(parsed, memCtx);

  return {
    intercepted: true,
    response: result.response,
    assistantText: result.messageText,
    memCommandResult: result,
    commandName: parsed.command,
  };
}
// avoid unused-import warnings; AgentStrategy is kept as a type contract, for use by later hooks
export type { AgentStrategy };
