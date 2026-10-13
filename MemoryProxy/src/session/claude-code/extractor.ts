/**
 * Claude Code Session Init — Extractor.
 *
 * Parses the user's reply from the `AskUserQuestion` form.
 * Claude Code user selections arrive in `role: "tool"` messages as a JSON tool_result.
 *
 * Supported reply formats:
 *   1. AskUserQuestion tool_result: `{ answers: { "q": "label" } }`
 *   2. multi_question_result envelope
 *   3. Plain-text label (the string the CLI returns after the user picks an option)
 *
 * Contains no CodeBuddy XML parsing logic.
 */

import type { SessionInitData, TeamOption } from "../types.js";
import { SKIP_LABEL, MORE_LABEL, ASSET_CONFIRM_YES, ASSET_CONFIRM_NO } from "./form.js";

// ── Markers ────────────────────────────────────────────────────────────────────

// SKIP_RE (the `/跳过|不关联|skip/i` free-text regex) was removed on 2026-09-21: it historically
// served as a fallback path for "free-text user reply -> BYPASS", but the CC
// form for the team/agent/task stages **no longer offers an explicit skip button** (the only entry is asset_confirm's
// ASSET_CONFIRM_NO), so this fallback had no legitimate use case and caused false positives. After removal the contract is:
// the extractor only recognizes the exact SKIP_LABEL text; any match failure returns null -> the upper layer's
// attemptCount >= maxRetries fallback takes over.
export const BYPASS_MARKER = "__bypass__" as const;
export const MORE_MARKER = "__more__" as const;

/**
 * Extracts the asset_confirm choice from the user's reply.
 * Returns true = yes (associate assets), false = no (bypass), null = not recognized.
 *
 * Format compatibility:
 *   1. Exact option: "Yes, associate team assets" / "No, do not associate this time"
 *   2. Q&A format: "Your questions have been answered: \"Q?\"=\"A\"."
 *   3. "Chat about this" / free text -> degrade to null (bypass)
 */
export function extractAssetConfirm(content: string): boolean | null {
  const answer = extractAnswerFromJson(content);
  if (!answer) return null;

  // First check for rejection / skip / free text (Chat about this / declined / rejected)
  // Chinese "non-answer" patterns added: the user may have typed something unrelated to the question
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions|declined/i.test(answer)) {
    return null;
  }

  // Claude Code's return format may include the full Q&A context, e.g.:
  // "Your questions have been answered: \"Question?\"=\"Answer\"."
  // Take the quoted content after the last = as the actual answer
  let answerOnly = answer;
  const eqMatch = answer.match(/="([^"]+)"[^"]*$/);
  if (eqMatch) {
    answerOnly = eqMatch[1];
  }

  // Safety valve: if the extracted text exceeds 80 characters, it is most likely not a pure user answer but contains the full Q&A text.
  // In that case skip the loose regex, to avoid misreading "whether to associate" in the question as "yes"
  // (only an exact match on ASSET_CONFIRM_YES / ASSET_CONFIRM_NO may pass)
  const allowLoosePattern = answerOnly.length <= 80;

  // Exact match: the full option text
  if (answerOnly.includes(ASSET_CONFIRM_YES)) {
    return true;
  }
  if (answerOnly.includes(ASSET_CONFIRM_NO)) {
    return false;
  }

  if (allowLoosePattern) {
    // Loose "yes" match: must start with "是" or "确认" (yes / confirm), avoiding false matches on "是否", "不是", etc.
    if (/^(?:是|确认|yes|confirm)[，,\s]/i.test(answerOnly.trim())) {
      return true;
    }
    // Loose "no" match
    if (/^(?:否|不[，,\s]|跳过|skip|no[，,\s])/i.test(answerOnly.trim())) {
      return false;
    }
  }

  return null;
}

// ── JSON parsing helpers ──────────────────────────────────────────────────────

/**
 * Extracts the answer text from a Claude Code tool_result JSON.
 * Supported formats:
 *   - `{ answers: { "q": "label" } }` (standard AskUserQuestion)
 *   - `{ type: "multi_question_result", questions: [...] }`
 *   - Plain-text string (free user input)
 */
function extractAnswerFromJson(content: string): string | null {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === "string") return parsed.trim() || null;
    if (typeof parsed !== "object" || parsed === null) return null;

    // AskUserQuestion tool_result: { answers: { "q": "label" } }
    if (parsed.answers && typeof parsed.answers === "object") {
      const answers = parsed.answers as Record<string, string>;
      for (const val of Object.values(answers)) {
        if (typeof val === "string" && val.trim()) {
          return val.trim();
        }
      }
    }

    // multi_question_result envelope
    const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
    if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
      for (const q of mqr.questions) {
        if (!q || typeof q !== "object") continue;
        const qo = q as Record<string, unknown>;
        const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
        if (typeof cand === "string" && cand.trim()) return cand.trim();
        if (Array.isArray(cand)) {
          const f = cand.find((x) => typeof x === "string" && x.trim());
          if (typeof f === "string") return f.trim();
        }
      }
    }

    return null;
  } catch {
    // Not JSON — Claude Code tool_results are often in a concatenated format:
    //   Your questions have been answered: "<question>"="<answer>".
    // Only take the answer inside ="..."; this way words like "跳过 / 可跳过" (skip / skippable) in the question text
    // do not pollute downstream SKIP_RE matching (regression for the session1.json bug).
    const eq = content.match(/="([^"]+)"[^"]*$/);
    if (eq) return eq[1].trim() || null;
    return content.trim() || null;
  }
}

/**
 * Extracts the agent and task answers from JSON (round 2, multi-question scenario).
 */
function extractAgentTaskFromJson(content: string): { agentText: string | null; taskText: string | null } {
  let agentText: string | null = null;
  let taskText: string | null = null;

  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null) {
      const raw = content.trim();
      const eq = raw.match(/="([^"]+)"[^"]*$/);
      return { agentText: (eq ? eq[1].trim() : raw) || null, taskText: null };
    }

    // AskUserQuestion: { answers: { "q": "label" } }
    if (parsed.answers && typeof parsed.answers === "object") {
      const answers = parsed.answers as Record<string, string>;
      for (const val of Object.values(answers)) {
        if (typeof val === "string" && val.trim()) {
          // The CC form's round 2 has only 1 question (agent); the first non-empty answer is the agent
          if (!agentText) agentText = val.trim();
          break;
        }
      }
    }

    // multi_question_result envelope
    if (!agentText && !taskText) {
      const mqr = (parsed.result ?? parsed) as Record<string, unknown> | undefined;
      if (mqr && mqr.type === "multi_question_result" && Array.isArray(mqr.questions)) {
        for (const q of mqr.questions) {
          if (!q || typeof q !== "object") continue;
          const qo = q as Record<string, unknown>;
          const id = typeof qo.id === "string" ? qo.id.toLowerCase() : "";
          const cand = qo.answer ?? qo.answers ?? qo.selected ?? qo.selectedOption ?? qo.value;
          let val: string | null = null;
          if (typeof cand === "string") val = cand.trim() || null;
          else if (Array.isArray(cand)) {
            const f = cand.find((x) => typeof x === "string" && x.trim());
            if (typeof f === "string") val = f.trim();
          }
          if (!val) continue;
          if (id === "agent" && !agentText) agentText = val;
          else if (id === "task" && !taskText) taskText = val;
        }
      }
    }
  } catch {
    // Not JSON — compatible with Claude Code's concatenated format `…"question"="answer".`
    const raw = content.trim();
    const eq = raw.match(/="([^"]+)"[^"]*$/);
    agentText = (eq ? eq[1].trim() : raw) || null;
  }

  return { agentText, taskText };
}

// ── Team matching ──────────────────────────────────────────────────────────────

/**
 * Round 1 extraction: identify the selected team_id from the user's reply.
 * Claude Code: the user's selection is in a `role: "tool"` message, handled via JSON parsing.
 *
 * Return values (aligned with the three-tier approach of extractTaskFromOptionText):
 *   - team_id string: matched a real team
 *   - MORE_MARKER: the user clicked "More →"; the caller pages forward (team pagination added 2026-09-03)
 *   - BYPASS_MARKER: the user chose SKIP / declined
 *   - null: not recognized
 */
export function extractTeamFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
): string | typeof MORE_MARKER | typeof BYPASS_MARKER | null {
  if (cachedTeams.length === 0) return null;

  // First check for rejection / skip (Chat about this / declined)
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return null;
  }

  const teamText = extractAnswerFromJson(content);

  // Detect "do not associate this time" -> bypass (only the exact SKIP_LABEL text is recognized; the SKIP_RE free-text
  // fallback has been removed, see the note at the top of the file)
  if (teamText && teamText.includes(SKIP_LABEL)) {
    return BYPASS_MARKER;
  }

  // Detect "More →" -> page forward (consistent with extractFromOptionText / extractTaskFromOptionText)
  if (teamText && teamText.includes(MORE_LABEL)) {
    return MORE_MARKER;
  }

  // Matching strategy
  const hay = teamText ?? content;
  const trimmed = hay.trim();

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
 * task_select stage extraction: parse only the labels in answers, not the full tool_result text.
 * The old path of extractFromOptionText is no longer reused here -- it passed the raw tool_result
 * as a fallback to matchTaskInTeam, and because the question text ("...(skippable):") contains
 * "skip" (跳过), it misjudged a task the user explicitly chose as bypass (historical bug).
 *
 * Return values:
 *   - task_id string: matched;
 *   - MORE_MARKER: the user clicked "More →"; the caller pages forward;
 *   - BYPASS_MARKER: declined / empty reply / explicit skip from an older form;
 *   - null: an answer was identified but matches no team.tasks (the caller treats it as unrecognized -> bypass).
 *
 * The defaultTaskId fallback association is implemented by injection at the head of fetchTeamsAndAgents -- when the user picks the "do not
 * associate a task this time" label, matchTaskInTeam hits the virtual entry and returns defaultTaskId, so no
 * separate branch is needed here.
 */
export function extractTaskFromOptionText(
  content: string,
  team: import("../types.js").TeamOption | undefined,
): string | typeof MORE_MARKER | typeof BYPASS_MARKER | null {
  // declined / rejected -> bypass (consistent with the other stages)
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return BYPASS_MARKER;
  }
  if (!team) return BYPASS_MARKER;

  const answer = extractAnswerFromJson(content);
  if (!answer) return BYPASS_MARKER;

  // Page forward
  if (answer.includes(MORE_LABEL)) return MORE_MARKER;

  // Try normal matching first -- the label of the defaultTaskId virtual entry is "Skip for now", which hits
  // matchTaskInTeam and returns defaultTaskId (not counted as BYPASS). The SKIP_RE free-text fallback
  // has been removed (see the note at the top of the file); a miss always returns null, left to the upper layer's attemptCount fallback.
  const taskId = matchTaskInTeam(answer, team);
  if (taskId) return taskId;

  return null;
}

/**
 * Round 2 extraction: identify agent + task from the user's reply.
 * Claude Code: handled via JSON parsing. Matches only within the already selected team.
 */
export function extractFromOptionText(
  content: string,
  cachedTeams: TeamOption[],
  selectedTeamId?: string,
): SessionInitData | null {
  // First check for rejection / skip (Chat about this / declined)
  if (/declined to answer|doesn't want to proceed|tool use was rejected|clarify these questions/i.test(content)) {
    return null;
  }

  const team = selectedTeamId
    ? cachedTeams.find((t) => t.team_id === selectedTeamId)
    : cachedTeams.length === 1
      ? cachedTeams[0]
      : null;
  if (!team) return null;

  const { agentText, taskText } = extractAgentTaskFromJson(content);

  // Detect "More →" -> page forward
  if (agentText && agentText.includes(MORE_LABEL)) {
    return { agent_id: MORE_MARKER };
  }

  // Detect "do not associate this time" -> bypass (only the exact SKIP_LABEL text is recognized; the SKIP_RE free-text
  // fallback has been removed, see the note at the top of the file)
  if (agentText && agentText.includes(SKIP_LABEL)) {
    return { agent_id: BYPASS_MARKER };
  }

  // Resolve agent
  let agentId: string | null = null;
  if (agentText) agentId = matchAgentInTeam(agentText, team);
  if (!agentId) agentId = matchAgentInTeam(content, team);
  if (!agentId) return null;

  // Resolve task -- the SKIP_RE free-text fallback has been removed (see the note at the top of the file), so
  // matchTaskInTeam is called unconditionally; a miss leaves taskId=undefined and uses the default task logic.
  let taskId: string | undefined;
  const taskHay = taskText ?? content;
  taskId = matchTaskInTeam(taskHay, team);

  return { agent_id: agentId, task_id: taskId };
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
