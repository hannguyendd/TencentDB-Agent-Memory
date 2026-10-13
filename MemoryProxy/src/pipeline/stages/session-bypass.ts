/**
 * stages/session-bypass.ts — small helper for post-processing the session-init "bypass branch".
 *
 * Extracted from ~6 lines of identical code in the 4 runners (but the caller-owned variable names differ, so it cannot mutate in place):
 *   if (initResult.bypassed) {
 *     injection[Ss]kipped = true;
 *     console.log("... bypassed → skipping injection");
 *     if (initResult.resetFlow) _resetFlowResult = { ...teamId(Short)?, bypassed: true };
 *   }
 *
 * Returns a structured result for the caller to apply, and does not directly mutate caller variables.
 *
 * Goals:
 *   1. make the "bypassed -> skipInjection + empty resetFlow" constraint explicit (blueprint §5.2 red-line)
 *   2. eliminate 4 small duplicates; when adding an agent in the future, only add the caller-side apply
 *
 * Differences preserved (handled explicitly by the caller):
 *   - wb uses teamIdShort, the other 3 use teamId — via the useTeamIdShort parameter
 *   - wb alone puts bypassReason into the log — via the extraLog parameter
 *   - warn prefix is separate for each of the 4
 */

export interface SessionBypassInput {
  bypassed: boolean;
  resetFlow: boolean;
  sessionKey: string;
  /** log prefix (e.g. "[codex]" / "[workbuddy]" / "[session-init]") */
  logPrefix: string;
  /** wb only: the " (reason=xxx)" segment appended to the log (the other 3 pass an empty string) */
  extraLog?: string;
  /** wb only: on bypass reset, the resetFlowResult field uses teamIdShort instead of teamId */
  useTeamIdShort?: boolean;
}

export interface ResetFlowBypassResult {
  agentName: string;
  agentIdShort: string;
  teamId?: string;
  teamIdShort?: string;
  bypassed: boolean;
}

export interface SessionBypassResult {
  /** whether bypass took effect (the caller uses it to set its own variable: injectedSkipped or injectionSkipped) */
  skipInjection: boolean;
  /** content of _resetFlowResult on bypass reset-flow (when undefined the caller leaves it alone) */
  resetFlowResult?: ResetFlowBypassResult;
}

export function stageSessionBypass(input: SessionBypassInput): SessionBypassResult {
  if (!input.bypassed) {
    return { skipInjection: false };
  }

  console.log(
    `${input.logPrefix} session=${input.sessionKey}${input.extraLog ?? ""} bypassed → skipping injection`,
  );

  if (input.resetFlow) {
    const resetFlowResult: ResetFlowBypassResult = input.useTeamIdShort
      ? { agentName: "", agentIdShort: "", teamIdShort: "", bypassed: true }
      : { agentName: "", agentIdShort: "", teamId: "", bypassed: true };
    return { skipInjection: true, resetFlowResult };
  }

  return { skipInjection: true };
}
