/**
 * stages/session-reset-confirmation.ts — confirmation response after mem:session-reset completes.
 *
 * Extracted from 4 identical 30-line code blocks (blueprint §2.4):
 *   - openai-chat runner: after reset, session-init runs and pops the form -> prompt ok
 *   - anthropic runner:   same as above
 *   - codex runner:       same as above
 *   - workbuddy runner:   same as above
 *
 * Semantics: after the session-init state machine completes the reset flow, take the agent/team/task detail
 * and assemble the "✅ Team assets re-bound" text, returned via buildMemResponse.
 * The caller sends the returned value directly downstream.
 */

import type { SessionResetProtocol } from "./session-reset-pre-hook.js";

export interface ResetFlowResult {
  agentName: string;
  agentIdShort: string;
  teamName?: string;
  teamId: string;
  taskName?: string | null;
  bypassed?: boolean;
}

export interface SessionResetConfirmationInput {
  resetFlowResult: ResetFlowResult;
  protocol: SessionResetProtocol;
  isStream: boolean;
  /** anthropic passes body.thinking */
  thinking?: unknown;
}

/**
 * Build the confirmation response for mem:session-reset completion.
 */
export async function stageSessionResetConfirmation(
  input: SessionResetConfirmationInput,
): Promise<Response> {
  const { agentName, agentIdShort, teamName, teamId, taskName, bypassed } = input.resetFlowResult;
  const teamLine = teamName
    ? `- **Team**: ${teamName}${teamId ? ` (${teamId})` : ""}`
    : teamId
      ? `- **Team**: ${teamId}`
      : null;
  const lines = bypassed
    ? ["✅ Team asset association skipped", "", "Subsequent conversations will not inject any team assets (Skill / memory / Knowledge)."]
    : [
        "✅ Team assets re-bound",
        "",
        `- **Agent**: ${agentName}${agentIdShort ? ` (${agentIdShort})` : ""}`,
        teamLine,
        taskName ? `- **Task**: ${taskName}` : "- **Task**: Not associated",
        "",
        "Subsequent conversations will use the new Agent's Skills, memory and knowledge assets.",
      ].filter(Boolean);
  const text = (lines as string[]).join("\n");

  const { buildMemResponse } = await import("../../mem-command/response-builder.js");
  console.log(`[mem-command:session-reset] completed: bypassed=${!!bypassed} agent=${agentName} (${agentIdShort}) team=${teamName ?? "-"} (${teamId || "-"})`);
  return buildMemResponse(text, {
    protocol: input.protocol,
    stream: input.isStream,
    requestId: `mem-reset-${Date.now()}`,
    thinking: input.thinking as boolean | undefined,
  });
}
