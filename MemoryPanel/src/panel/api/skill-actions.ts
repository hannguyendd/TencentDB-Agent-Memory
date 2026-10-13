/**
 * Action list for the kernel /v3/skill/* data plane (14 actions, all POST).
 *
 * Reference doc: tdai-memory-openclaw-plugin/docs/skill-api-for-frontend.md
 *
 * Differences from /v3/meta/*:
 *   - The skill data plane has its own storage (skill_id prefix skl-); readable within the team, writable by the owner agent;
 *   - Identity fields (user_id / team_id / agent_id / task_id) go in the body, not headers;
 *   - Pagination uses nested pagination.{limit,offset} rather than top-level limit/offset, so meta's
 *     sanitizeBody logic is not needed; the body can be passed through as-is.
 */

/** Read operations (agent_id optional); used here only for documentation, passthrough does not distinguish. */
export const SKILL_LIST_ACTIONS = new Set(['list', 'search', 'versions']);

export const SKILL_ACTIONS = [
  'create',
  'update',
  'patch',
  'delete',
  'get',
  'list',
  'search',
  'versions',
  'files/write',
  'files/remove',
  'files/read',
  'listing',
  'extract',
  'export',
  'conversation/add',
] as const;

export type SkillAction = (typeof SKILL_ACTIONS)[number];

export const ALLOWED_SKILL_ACTIONS = new Set<string>(SKILL_ACTIONS);

export function isAllowedSkillAction(action: string): action is SkillAction {
  return ALLOWED_SKILL_ACTIONS.has(action);
}
