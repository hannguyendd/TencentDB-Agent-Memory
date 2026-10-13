/**
 * WorkBuddy Session Init — Extractor.
 *
 * The WorkBuddy client reuses CC's `AskUserQuestion` tool contract (same tool name, same
 * questions/answers structure, verified by packet capture [wb-ask-user-schema]). Therefore the user reply's
 * tool_result JSON structure is **exactly the same** as CC's.
 *
 * This file directly re-exports CC's extractor -- keeping the architectural semantics of "WB is handled by a separate module"
 * while avoiding copy-pasting 400 lines of matching logic; if behavior ever diverges on either side, just add a wrapper
 * in this file, with no need to modify upstream.
 *
 * Note: the `SKIP_LABEL / MORE_LABEL / ASSET_CONFIRM_*` constants in the CC extractor
 * are imported from `./claude-code/form.js`. WB form.ts defines constants of the same names, but
 * the values are identical ("Do not associate this time (skip injection, pass through)" / "More →", etc.), so
 * the extractor works with either; just keep using CC's.
 */

export {
  BYPASS_MARKER,
  MORE_MARKER,
  extractAssetConfirm,
  extractTeamFromOptionText,
  extractTaskFromOptionText,
  extractFromOptionText,
  extractStructured,
  resolveAgent,
  resolveTask,
} from "../claude-code/extractor.js";
