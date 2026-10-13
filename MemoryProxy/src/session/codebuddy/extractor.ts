/**
 * CodeBuddy Session Init — Extractor.
 *
 * Parse the user's reply from the `ask_followup_question` form.
 *
 * ── Why this looks like XML parsing yet also works for multi-round cross-team forms ──
 *
 * Currently only `<question_answer>` XML (the legacy CodeBuddy format) is parsed.
 * In practice CodeBuddy writes back a `multi_question_result` JSON in a `role: "tool"` message
 * (see the captured format in the header comment of cleaner.ts), but the extractor's substring fallback matching
 * can "happen" to match team/agent/task names in unrelated user message text, so session init succeeds by luck.
 * This is a fragile dependency, not precise parsing. Reliable extraction requires adding a JSON parsing path.
 *
 * Contains no Claude Code logic (does not parse JSON tool_result).
 */

import type { SessionInitData, TeamOption } from "../types.js";
import { SKIP_LABEL, PATH_SEP, ASSET_CONFIRM_YES, ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

// SKIP_RE (the `/跳过|不关联|skip/i` free-text regex) was removed on 2026-09-21: historically it
// served as a fallback path for "user free-text reply → BYPASS", but the team/agent/task stage
// forms **no longer offer an explicit skip button** (the only entry is asset_confirm's
// ASSET_CONFIRM_NO), so this fallback has no legitimate use case and causes false positives: when WB / opencode /
// dsh clients replay the original form question text (including the hint "if you choose skip...") together with the user's answer,
// the regex would match the "跳过" (skip) wording in the question text → the whole session is wrongly bypassed and
// the client never sees the agent selection form. After removal the contract is: the extractor only recognizes the exact
// SKIP_LABEL text; any failed match returns null → the upper layer's attemptCount >= maxRetries fallback applies.
export const BYPASS_MARKER = "__bypass__" as const;

// ── opencode tool-result unwrapping ─────────────────────────────────────────
//
// After opencode CLI's native `question` tool receives the user's choice, it returns the answer to the
// model as plain text in a tool-result, in the format:
//   User has answered your questions: "question description..."="user answer"[, "question 2"="answer 2"]
//
// Purpose of unwrapping: extract the answer segment for later exact matching (SKIP_LABEL / team-name /
// short-id, etc.) so it is no longer disturbed by the question description text. Non-opencode scenarios (CB XML / codex
// bare text / wb direct answer) have no such wrapper; the helper returns null and the original content is used.
//
// The asset_confirm scenario does not use this helper, because extractAssetConfirm uses whitelist-style matching that
// "looks for positive markers first, then negative markers", so "跳过" (skip) wording in the question description is naturally harmless.
//
// Match the value in `="value"`. Note the value may contain inner quotes escaped by opencode.
// Observed (2026-08-19): when the opencode client encounters inner quotes it either outputs escaped
// `\"` or passes through full-width quotes `"`. For maximum compatibility a simple `[^"]*` match suffices (it covers
// all labels in our form.ts, since plain label text contains no bare ASCII quotes).
function extractOpencodeAnswers(content: string): string | null {
  if (!content.includes("User has answered your questions:")) return null;
  const answers: string[] = [];
  const re = /"[^"]*"="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m[1]) answers.push(m[1]);
  }
  return answers.length > 0 ? answers.join(" | ") : null;
}

/**
 * Extract the asset_confirm choice from the user's reply.
 * Returns true=yes (link assets), false=no (bypass), null=unrecognized.
 *
 * ── Strip answer + exact match + safety valve (2026-09-22 fix, aligned with CC extractAssetConfirm) ──
 *
 * The old implementation ran loose regexes like `/是.*关联|关联.*是/i` over the whole content, which would match the
 * form question text "是否要**关联**团队资产" (do you want to link team assets) (WB / opencode replay sends the form question text
 * together with the user answer) — a user choosing "否，本次不关联" (no, do not link this time) was misjudged as YES → the
 * team form popped up again instead of taking the bypass.
 *
 * The fix is fully aligned with CC (session/claude-code/extractor.ts:extractAssetConfirm):
 *   1. First strip out the real answer segment (XML → opencode → naked eq → content fallback);
 *   2. Exact match against the full ASSET_CONFIRM_YES / ASSET_CONFIRM_NO strings;
 *   3. Only short answers (<= 80 chars) may use anchored loose regexes (free-text "是/y/否/n" fallback);
 *   4. The loose regex uses the anchor `^(?:是|确认|yes|confirm)[，,\s]` which must match at the start, to avoid matching "是否/不是" etc.
 */
export function extractAssetConfirm(content: string): boolean | null {
  // 1. XML parsing (legacy CB client <question_answer>)
  const xml = parseQuestionAnswerXml(content);
  let answer = xml?.teamAnswer ?? xml?.agentAnswer ?? xml?.taskAnswer ?? null;

  // 2. opencode tool-result unwrapping (User has answered your questions: "Q"="A")
  if (!answer) {
    const oc = extractOpencodeAnswers(content);
    if (oc !== null) answer = oc;
  }

  // 3. Trailing bare `="answer"` (common in Claude Code / workbuddy text-mode replay)
  if (!answer) {
    const eq = content.match(/="([^"]+)"[^"]*$/);
    if (eq) answer = eq[1];
  }

  // 4. Fallback: use the whole content, but the 80-char safety valve below disables the loose regexes
  if (!answer) answer = content;
  answer = answer.trim();
  if (!answer) return null;

  // Exact match (no length limit): return as soon as the full option text matches
  if (answer.includes(ASSET_CONFIRM_YES)) return true;
  if (answer.includes(ASSET_CONFIRM_NO)) return false;

  // Safety valve: over 80 chars is most likely the question text + answer glued together; skip the loose regexes
  const allowLoosePattern = answer.length <= 80;
  if (allowLoosePattern) {
    // Loose "yes" match: must start with "是" or "确认", to avoid "是否"/"不是" false hits
    if (/^(?:是|确认|yes|confirm)[，,\s]/i.test(answer)) return true;
    // Loose "no" match: must start with "否" or "不" (free text "否" / "不" / "不关联")
    if (/^(?:否|no|不[，,\s]?|本次不)/i.test(answer)) return false;
  }
  return null;
}

// ── XML parsing ───────────────────────────────────────────────────────────────

/**
 * Parse CodeBuddy's `<question_answer>` XML from user message.
 */
function parseQuestionAnswerXml(
  content: string,
): {
  teamAnswer?: string;
  agentAnswer?: string;
  taskAnswer?: string;
} | null {
  if (!content.includes("<question_answer") && !content.includes("<question_item")) {
    return null;
  }

  const result: { teamAnswer?: string; agentAnswer?: string; taskAnswer?: string } = {};
  const itemRe =
    /<question_item\s+id="([^"]+)"\s*>[\s\S]*?<answers>\s*([\s\S]*?)\s*<\/answers>/g;

  // First scan all question_item entries to determine the total (round 1: 1, round 2: 2)
  const allIds: string[] = [];
  const idRe = /<question_item\s+id="([^"]+)"\s*>/g;
  let idM: RegExpExecArray | null;
  while ((idM = idRe.exec(content)) !== null) {
    allIds.push(idM[1].trim().toLowerCase());
  }
  const isSingleQuestion = allIds.length === 1;

  let m: RegExpExecArray | null;
  let index = 0;
  while ((m = itemRe.exec(content)) !== null) {
    const id = m[1].trim().toLowerCase();
    const answer = m[2].trim();
    if (!answer) { index++; continue; }

    if (id === "team") {
      result.teamAnswer = result.teamAnswer ?? answer;
    } else if (id === "agent") {
      result.agentAnswer = result.agentAnswer ?? answer;
    } else if (id === "task") {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (id === "q1") {
      if (isSingleQuestion) {
        result.teamAnswer = result.teamAnswer ?? answer;
      } else {
        result.agentAnswer = result.agentAnswer ?? answer;
      }
    } else if (id === "q2" && !isSingleQuestion) {
      result.taskAnswer = result.taskAnswer ?? answer;
    } else if (index === 0 && !result.teamAnswer && !result.agentAnswer) {
      result.teamAnswer = answer;
    }
    index++;
  }

  return result.teamAnswer || result.agentAnswer || result.taskAnswer ? result : null;
}

// ── Team matching ─────────────────────────────────────────────────────────────

/**
 * Round 1 extraction: identify the selected team_id from the user's reply.
 * CodeBuddy: the user's choice is in a `role: "user"` message, parsed via `<question_answer>` XML.
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
): string | null {
  if (cachedTeams.length === 0) return null;

  // opencode: unwrap the tool-result wrapper so "跳过" (skip) wording in the question description does not trigger a false SKIP.
  // See the header comment of extractOpencodeAnswers.
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let teamText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    teamText = xml.teamAnswer ?? null;
  }

  // Matching strategy (team option label format: "team name (last 8 chars of id)")
  const hay = teamText ?? content;
  const trimmed = hay.trim();

  // Only the exact SKIP_LABEL text → BYPASS (the SKIP_RE free-text fallback was removed; see the note at the top of the file).
  // If the user replies with free text (e.g. a bare "跳过"), it falls to the matching loop below; on no match it returns
  // null, leaving it to the upper init.ts attemptCount >= maxRetries fallback.
  if (trimmed.includes(SKIP_LABEL)) {
    return BYPASS_MARKER;
  }

  const exactFull = cachedTeams.find(
    (t) => `${t.team_name} (${t.team_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.team_id;

  const exactName = cachedTeams.find((t) => t.team_name === trimmed);
  if (exactName) return exactName.team_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = cachedTeams.find((t) => t.team_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.team_id;
  }

  const sorted = [...cachedTeams].sort((a, b) => b.team_name.length - a.team_name.length);
  for (const t of sorted) {
    if (hay.includes(t.team_name)) return t.team_id;
  }
  for (const t of cachedTeams) {
    if (hay.includes(t.team_id.slice(-8))) return t.team_id;
  }
  return null;
}

// ── Agent / Task matching ─────────────────────────────────────────────────────

function matchAgentInTeam(text: string, team: TeamOption): string | null {
  const trimmed = text.trim();

  const exactFull = team.agents.find(
    (a) => `${a.agent_name} (${a.agent_id.slice(-8)})` === trimmed,
  );
  if (exactFull) return exactFull.agent_id;

  const exactName = team.agents.find((a) => a.agent_name === trimmed);
  if (exactName) return exactName.agent_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.agents.find((a) => a.agent_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.agent_id;
  }

  const sorted = [...team.agents].sort((a, b) => b.agent_name.length - a.agent_name.length);
  for (const a of sorted) {
    if (text.includes(a.agent_name)) return a.agent_id;
  }
  for (const a of team.agents) {
    if (text.includes(a.agent_id.slice(-8))) return a.agent_id;
  }
  return null;
}

function matchTaskInTeam(text: string, team: TeamOption): string | undefined {
  if (!text) return undefined;
  const trimmed = text.trim();

  const exactFull = team.tasks.find((t) => `${t.task_name} (${t.task_id.slice(-8)})` === trimmed);
  if (exactFull) return exactFull.task_id;

  const exactName = team.tasks.find((t) => t.task_name === trimmed);
  if (exactName) return exactName.task_id;

  const suffixMatch = trimmed.match(/\((\w{8})\)$/);
  if (suffixMatch) {
    const exactSuffix = team.tasks.find((t) => t.task_id.slice(-8) === suffixMatch[1]);
    if (exactSuffix) return exactSuffix.task_id;
  }

  const sorted = [...team.tasks].sort((a, b) => b.task_name.length - a.task_name.length);
  for (const t of sorted) {
    if (trimmed.includes(t.task_name)) return t.task_id;
  }
  for (const t of team.tasks) {
    if (trimmed.includes(t.task_id.slice(-8))) return t.task_id;
  }
  return undefined;
}

/**
 * Round 2 extraction: identify agent + task from the user's reply, **strictly limited to the already selected team**.
 * CodeBuddy: parsed via `<question_answer>` XML.
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): SessionInitData | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  // opencode: unwrap tool-result wrapper (see header of extractOpencodeAnswers).
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;

  let agentText: string | null = null;
  let taskText: string | null = null;

  // XML parsing: CodeBuddy <question_answer> in user message.
  const xml = parseQuestionAnswerXml(content);
  if (xml) {
    agentText = xml.agentAnswer ?? null;
    taskText = xml.taskAnswer ?? null;
  }

  // Detect Agent choosing "本次不关联" (do not link this time) → bypass (only the exact SKIP_LABEL text is recognized;
  // the SKIP_RE free-text fallback was removed, see the note at the top of the file)
  if (agentText && agentText.includes(SKIP_LABEL)) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task. The defaultTaskId fallback is implemented by injection at the head of fetchTeamsAndAgents:
  // when the user picks the "暂时跳过" (skip for now) label, matchTaskInTeam hits the virtual entry and returns
  // defaultTaskId, so no separate handling is needed here. The SKIP_RE free-text fallback was removed (see the note at the top of the file);
  // on match failure taskId stays undefined and the completeRegistration default logic applies.
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  taskId = matchTaskInTeam(taskHay, team);

  return { agent_id: agentId, task_id: taskId };
}

// ── codex-only single-question extractor ─────────────────────────────────────
//
// 2026-08-08 codex session-init refactor: after splitting pending_agent_task into separate
// pending_agent_select + pending_task_select, each step extracts only one field.
// Reuses the fuzzy matching above in matchAgentInTeam / matchTaskInTeam (including label/name/
// suffix/substring fallbacks), ensuring that verbatim labels like "AgentName (xxxxxxxx)"
// passed down by the codex handler also hit.
//
// The legacy CB client path (asks agent+task in one shot) keeps using extractFromOptionText and does not
// touch these two new functions.

/**
 * Identify a single agent_id from plain-text answer only (codex single agent_select stage).
 *
 * Returns:
 *   - BYPASS_MARKER: the user explicitly expressed "skip / do not link"
 *   - agent_id: a candidate matched
 *   - null: unrecognized
 */
export function extractAgentOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: unwrap tool-result wrapper (see header of extractOpencodeAnswers).
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  // First try to match a real agent candidate; on miss, check whether it is the exact SKIP_LABEL text → BYPASS.
  // The SKIP_RE free-text fallback was removed (see the note at the top of the file); a bare "跳过" from a codex client now
  // returns null → the upper attemptCount >= maxRetries fallback bypasses.
  const matched = matchAgentInTeam(trimmed, team);
  if (matched) return matched;
  if (trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return null;
}

/**
 * Identify a single task_id from plain-text answer only (codex single task_select stage).
 *
 * Returns:
 *   - BYPASS_MARKER: the user explicitly expressed "skip / do not link" (here "do not link task" is hit by the defaultTaskId
 *     virtual entry via matchTaskInTeam and takes the return-task_id branch, never reaching the BYPASS branch)
 *   - task_id: a candidate matched
 *   - null: unrecognized
 */
export function extractTaskOnly(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string | typeof BYPASS_MARKER | null {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;
  // opencode: unwrap tool-result wrapper (see header of extractOpencodeAnswers).
  const opencodeAnswer = extractOpencodeAnswers(content);
  if (opencodeAnswer !== null) content = opencodeAnswer;
  const trimmed = content.trim();
  if (!trimmed) return null;
  // First try to match a real/virtual task entry (the virtual entry is injected at the head of fetchTeamsAndAgents,
  // after label="暂时跳过" matches, defaultTaskId is returned, consistent with the "skip task but keep
  // agent" contract, not treated as BYPASS). On miss, check whether it is the exact SKIP_LABEL text → BYPASS.
  // SKIP_RE free-text fallback was removed (see the note at the top of the file).
  const matched = matchTaskInTeam(trimmed, team);
  if (matched) return matched;
  if (trimmed.includes(SKIP_LABEL)) return BYPASS_MARKER;
  return null;
}

// ── Structured / LLM fallback ──────────────────────────────────────────────────

export function extractStructured(content: string): SessionInitData | null {
  const agentMatch = content.match(/agent\s*[:：=]\s*(\S+)/i);
  if (!agentMatch) return null;
  const agent_id = agentMatch[1].trim();
  if (!agent_id) return null;

  let task_id: string | undefined;
  const taskMatch = content.match(/task\s*[:：=]\s*(\S+)/i);
  if (taskMatch && taskMatch[1] !== "0" && taskMatch[1].toLowerCase() !== "skip") {
    task_id = taskMatch[1].trim();
  }
  return { agent_id, task_id };
}

// ── Resolvers ──────────────────────────────────────────────────────────────────

export function resolveAgent(
  rawAgentId: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): string {
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (team && /^\d+$/.test(rawAgentId)) {
    const num = parseInt(rawAgentId, 10);
    if (num > 0 && num <= team.agents.length) {
      return team.agents[num - 1].agent_id;
    }
  }
  return rawAgentId;
}

export function resolveTask(
  rawTaskId: string | undefined,
  cachedTeams: TeamOption[],
  agentHintId?: string,
  selectedTeamId?: string,
): string | undefined {
  if (!rawTaskId) return undefined;
  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (team && /^\d+$/.test(rawTaskId)) {
    const num = parseInt(rawTaskId, 10);
    if (num > 0 && num <= team.tasks.length) {
      return team.tasks[num - 1].task_id;
    }
  }
  return rawTaskId;
}
