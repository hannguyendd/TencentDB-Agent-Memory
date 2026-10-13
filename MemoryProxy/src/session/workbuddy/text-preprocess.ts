/**
 * WorkBuddy Text Mode — input preprocessor.
 *
 * ── Background ────────────────────────────────────────────────────────────
 *
 * The new WorkBuddy official tools set dropped `AskUserQuestion` (verified by packet capture: tools
 * has only 20 entries); continuing to send tool_calls SSE is not recognized by the client → it hangs pending. CP1 detects
 * `capabilities.askUserQuestion === false`, and CP2 already renders plain text; this module
 * is responsible for translating the **next user reply**: turning naked text into a form the
 * CB state machine extractor can recognize.
 *
 * ── Design approach (reuse existing CB capabilities) ──────────────────────
 *
 * The CB extractor already has powerful substring matching + SKIP_RE + short-id fallback logic
 * (see codebuddy/extractor.ts). Text-mode user input forms → translation CB can recognize:
 *
 *   | User input             | translate result                        |
 *   |------------------------|-----------------------------------------|
 *   | "2" (number)           | team_name/agent_name/... of item 2 of the full list |
 *   | "team B" (name/prefix) | passed through as is (CB substring hit) |
 *   | "abc12345" (short-id)  | passed through as is (CB short-id suffix hit) |
 *   | "next" / "下一页"      | "More →" (triggers the existing WB MORE interception) |
 *   | "prev" / "上一页"      | special action = "paginate-prev", short-circuit needed |
 *   | "skip" / "跳过"        | passed through as is (CB SKIP_RE hit)   |
 *   | "是" / "否"            | passed through as is (recognized by the asset_confirm branch) |
 *   | other                  | passed through as is (CB extractor falls back to retry) |
 *
 * ── Numeric addressing: full list vs. current page ────────────────────────
 *
 * A number the user enters ("1", "14", etc.) is addressed by the **1-based index in the full list**, not the
 * relative index within the current page. This matches exactly the absolute index output by
 * `absoluteIdx = offset + i + 1` in the rendering layer (`text-form.ts renderOptionList`) — the number the user
 * sees is the position in the full list; whichever page they are on, entering "14" points precisely to item 14.
 *
 * Out of range: only a number > the full list length counts as out of range → passthrough; it then goes through the CB extractor's
 * retry / bypass fallback. A number within the full list but not within the current page range (for example the user is on page 1
 * and enters "14", and item 14 is on page 2) is still translated to the name of item 14.
 *
 * ── Zero-impact guarantee ─────────────────────────────────────────────────
 *
 * This module has **no global side effects** — it is a pure function. The caller (codebuddy/init.ts) strictly gates on
 * `capabilities?.askUserQuestion === false`; only requests from the new WorkBuddy
 * without the AskUserQuestion tool get in. All other clients never enter.
 */

import type { TeamOption, AgentInTeam, TaskInTeam } from "../types.js";
import type { FormStage } from "./form.js";
import { MORE_LABEL as WB_MORE_LABEL, SKIP_LABEL as WB_SKIP_LABEL } from "./form.js";
import { TEXT_PAGE_SIZE } from "./text-pagination.js";
import { extractUserQueryText } from "../../common/user-query-extractor.js";

// ── Types ──────────────────────────────────────────────────────────────────────

/**
 * Preprocessor decision.
 *
 * - `translate`  → overwrite the content of the last user message at the tail of messages with `translated`,
 *                  then **let it through** to the CB state machine to continue (the old extractor path).
 * - `paginate-next` / `paginate-prev` → **short-circuit**: set
 *                     state.codexPageIndex[corresponding stage] to newPageIndex and
 *                     re-render the form of the same stage. Does not enter the extractor, does not consume
 *                     attemptCount, and does not advance the stage.
 * - `passthrough` → do nothing; the user's original text goes straight to the extractor (for example forms the extractor can already
 *                   recognize, such as "skip / 团队 A / team-abc12345").
 */
export type PreprocessAction = "translate" | "paginate-next" | "paginate-prev" | "passthrough";

export interface PreprocessResult {
  action: PreprocessAction;
  /** Replacement text when action=translate; undefined otherwise. */
  translated?: string;
  /** New page index when action=paginate-* (already clamped to the valid range); undefined otherwise. */
  newPageIndex?: number;
  /**
   * Used only for logging and debugging; explains which branch the preprocessing took.
   */
  reason: string;
}

/**
 * Context the preprocessor needs: the full list of teams, the current stage, pagination info of the current stage,
 * and the selected team/agent ids (used to filter agent/task candidates).
 */
export interface PreprocessOptions {
  stage: FormStage;
  teams: readonly TeamOption[];
  selectedTeamId?: string;
  selectedAgentId?: string;
  /** Page index of the current stage (0-based). */
  currentPage: number;
  /** Page size. Defaults to TEXT_PAGE_SIZE. */
  pageSize?: number;
}

// ── Keyword regexes ─────────────────────────────────────────────────────────

/** next / 下一页 / 下页 / 下一步 — triggers MORE paging. */
const NEXT_RE = /^\s*(next|下一?页|下一?步|n)\s*$/i;

/** prev / 上一页 / 上页 / 上一步 — triggers paginate-prev. */
const PREV_RE = /^\s*(prev|previous|上一?页|上一?步|p)\s*$/i;

/** Pure digits — look up the table by current-page slice and translate into the corresponding label. */
const DIGIT_RE = /^\s*(\d+)\s*$/;

/** yes / y / 是 — translated into the ASSET_CONFIRM_YES label only in the asset_confirm stage. */
const YES_RE = /^\s*(yes|y|是)\s*$/i;

/** no / n / 否 — translated into the ASSET_CONFIRM_NO label only in the asset_confirm stage. */
const NO_RE = /^\s*(no|n|否)\s*$/i;

// ── Main function ───────────────────────────────────────────────────────────

/**
 * Preprocess the user's naked-text reply in text mode.
 *
 * Only WorkBuddy requests with `capabilities?.askUserQuestion === false` call this
 * function (gated at the entry of codebuddy/init.ts). **All other clients never enter.**
 *
 * ── Match priority ────────────────────────────────────────────────────────
 *
 *   1. prev  → action="paginate-prev" (page index -1, clamped to 0)
 *   2. next  → action="paginate-next" (page index +1, clamped to totalPages-1)
 *   3. digit → take item N from the **full list** and translate it to team_name/agent_name/task_name
 *              (or the specific "是/否" label of asset_confirm). Only out of range of the full list
 *              is passthrough; cross-page numbers still hit.
 *   4. other → passthrough (CB extractor falls back to substring / SKIP_RE)
 *
 * Note: **name/short-id matching is left to the CB extractor** (it already does well); we only
 * handle "capabilities the CB extractor lacks" (numeric paging / page-level numbers / prev/next).
 */
export function preprocessTextModeInput(
  rawText: string,
  options: PreprocessOptions,
): PreprocessResult {
  // Strip system XML wrappers such as <system-reminder> / <user_query> /
  // <additional_data> / <craft_mode> that the WorkBuddy client may wrap around the input, keeping only what the user really typed.
  // If the original text has no such wrappers (e.g. an old client or clean input), extractUserQueryText returns it unchanged.
  const cleaned = extractUserQueryText(rawText ?? "");
  const text = cleaned.trim();
  if (!text) {
    return { action: "passthrough", reason: "empty-input" };
  }

  const pageSize = options.pageSize ?? TEXT_PAGE_SIZE;
  const totalItems = getTotalItemsForStage(options);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  // ── 0. yes/no (asset_confirm stage only) → translate to the exact label ──
  // Must come before next/prev: `n` hits both NEXT_RE and NO_RE, and in the asset_confirm stage
  // `n` semantically means "no" rather than "next" (asset_confirm needs no paging either).
  // In other stages yes/no passes through to the extractor (the extractor does not currently recognize it and falls back to
  // retry, behavior unchanged).
  if (options.stage === "asset_confirm") {
    if (YES_RE.test(text)) {
      return {
        action: "translate",
        translated: "Yes, associate team assets",
        reason: `yes-keyword → "Yes, associate team assets"`,
      };
    }
    if (NO_RE.test(text)) {
      return {
        action: "translate",
        translated: "No, do not associate this time",
        reason: `no-keyword → "No, do not associate this time"`,
      };
    }
  }

  // ── 1. prev (previous page) ───────────────────────────────────────────────
  if (PREV_RE.test(text)) {
    const nextPage = Math.max(0, options.currentPage - 1);
    return {
      action: "paginate-prev",
      newPageIndex: nextPage,
      reason: `prev-keyword: ${options.currentPage} → ${nextPage}`,
    };
  }

  // ── 2. next (next page) → paginate-next short-circuit ─────────────────────
  if (NEXT_RE.test(text)) {
    const nextPage = Math.min(totalPages - 1, options.currentPage + 1);
    return {
      action: "paginate-next",
      newPageIndex: nextPage,
      reason: `next-keyword: ${options.currentPage} → ${nextPage} (total=${totalPages})`,
    };
  }

  // ── 3. digit → look up item N ─────────────────────────────────────────────
  const digitMatch = text.match(DIGIT_RE);
  if (digitMatch) {
    const n = parseInt(digitMatch[1], 10);
    const translated = resolveNumberToLabel(n, options);
    if (translated !== null) {
      return {
        action: "translate",
        translated,
        reason: `digit-${n} → "${translated}"`,
      };
    }
    // Number out of range → passthrough, leaving it to the extractor's retry fallback
    return {
      action: "passthrough",
      reason: `digit-${n} out-of-range`,
    };
  }

  // ── 4. other → passthrough (skip/name/id all land here) ───────────────────
  return {
    action: "passthrough",
    reason: "verbatim (skip/name/short-id/other)",
  };
}

// ── Digit → label lookup ─────────────────────────────────────────────────────

/**
 * Map the Nth option (**1-based index in the full list**) back to its label.
 *
 * - asset_confirm: N=1 → the ASSET_CONFIRM_YES keyword; N=2 → the ASSET_CONFIRM_NO keyword
 *   (passing through the full string directly, such as "Yes, associate team assets" / "No, do not associate this time",
 *   is exactly hit by extractAssetConfirm)
 * - team / agent_select / task_select: take the name of item N in the full list (without
 *   the parenthesized short-id suffix; CB substring matching on the name itself is enough)
 *
 * Numeric addressing is independent of paging: a user entering "14" on page 2 also hits item 14 of the full list directly,
 * consistent with the absolute index output by the rendering layer (`absoluteIdx = offset + i + 1`).
 *
 * Returning null means N is out of range (> full list length) / the stage is unknown.
 */
function resolveNumberToLabel(
  n: number,
  options: PreprocessOptions,
): string | null {
  if (n < 1) return null;

  switch (options.stage) {
    case "asset_confirm": {
      // asset_confirm has only 2 fixed options and does not paginate. extractAssetConfirm recognizes
      // keywords such as "是" / "否" / "关联" and directly returns the exact literal string.
      if (n === 1) return "Yes, associate team assets";
      if (n === 2) return "No, do not associate this time";
      return null;
    }

    case "team": {
      if (n > options.teams.length) return null;
      const item = options.teams[n - 1] as TeamOption;
      return item.team_name;
    }

    case "agent_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      if (!team) return null;
      if (n > team.agents.length) return null;
      const item = team.agents[n - 1] as AgentInTeam;
      return item.agent_name;
    }

    case "task_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      if (!team) return null;
      if (n > team.tasks.length) return null;
      const item = team.tasks[n - 1] as TaskInTeam;
      // After the "Skip for now" virtual entry hits, return its original label so that
      // extractTaskOnly goes through the defaultTaskId virtual-entry match path; no extra
      // handling is needed.
      return item.task_name;
    }

    // The agent_task legacy branch (CB one-shot old path) is not reached in text mode,
    // because workbuddy is forced onto the split agent_select / task_select.
    default:
      return null;
  }
}

// ── Utility functions ────────────────────────────────────────────────────────

function findTeam(
  teams: readonly TeamOption[],
  selectedTeamId: string | undefined,
): TeamOption | undefined {
  if (!selectedTeamId) return undefined;
  return teams.find((t) => t.team_id === selectedTeamId);
}

/**
 * Get the total number of candidates for the current stage (used to compute totalPages; only for next/prev clamp).
 * asset_confirm has only 2 fixed items, always a single page, returns 2.
 * team → teams.length; agent_select → team.agents.length; task_select → team.tasks.length.
 * Team not found → 0 (totalPages=1, next clamps to 0, i.e. stays in place).
 */
function getTotalItemsForStage(options: PreprocessOptions): number {
  switch (options.stage) {
    case "asset_confirm":
      return 2;
    case "team":
      return options.teams.length;
    case "agent_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      return team?.agents.length ?? 0;
    }
    case "task_select": {
      const team = findTeam(options.teams, options.selectedTeamId);
      return team?.tasks.length ?? 0;
    }
    default:
      return 0;
  }
}

// ── Exported constants (for tests) ───────────────────────────────────────────

export const _internals = {
  NEXT_RE,
  PREV_RE,
  DIGIT_RE,
  YES_RE,
  NO_RE,
  WB_MORE_LABEL,
  WB_SKIP_LABEL,
};
