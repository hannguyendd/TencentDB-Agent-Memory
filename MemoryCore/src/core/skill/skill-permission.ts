/**
 * skill-permission — pure permission-check functions
 *
 * Three assertions:
 *   - assertOwner: whether the agent is the owner of the head
 *   - assertTeamMatch: whether the row belongs to the requested team (mismatch → 404, not exposing existence)
 *   - assertVersionFresh: optimistic-lock check
 *
 * Error codes are aligned with design doc §3.6.
 */

import type { Skill } from "./types.js";

export type SkillPermissionErrorCode =
  | "SKILL_NOT_OWNER"     // 40301
  | "SKILL_TEAM_MISMATCH" // 40302 (externally behaves the same as NOT_FOUND, avoiding an existence side channel)
  | "SKILL_NOT_FOUND"     // 40401
  | "SKILL_VERSION_STALE"; // 40901

export class SkillPermissionError extends Error {
  constructor(public readonly code: SkillPermissionErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillPermissionError";
  }
}

/**
 * The (teamId, agentId) pair must match headRow; otherwise throws 40301.
 *
 * Only team_id + agent_id uniquely determines an agent's ownership —
 * the same agent_id value may appear under different teams, so checking agent_id alone is not safe enough.
 */
export function assertOwner(headRow: Skill, agentId: string, teamId?: string): void {
  if (teamId && headRow.team_id !== teamId) {
    throw new SkillPermissionError(
      "SKILL_NOT_OWNER",
      `team ${teamId} does not match (actual=${headRow.team_id})`,
    );
  }
  if (headRow.owner_agent_id !== agentId) {
    throw new SkillPermissionError(
      "SKILL_NOT_OWNER",
      `agent ${agentId} is not the owner (owner=${headRow.owner_agent_id})`,
    );
  }
}

/**
 * row.team_id must equal the requested teamId; a mismatch is handled as NOT_FOUND (not exposing existence).
 */
export function assertTeamMatch(row: Skill | null, teamId: string): asserts row is Skill {
  if (!row || row.team_id !== teamId) {
    throw new SkillPermissionError("SKILL_NOT_FOUND");
  }
}

/**
 * Optimistic lock: expected_version is required and must exactly equal head.version.
 * On mismatch throws SKILL_VERSION_STALE, rejecting the write to prevent concurrent overwrites.
 */
export function assertVersionFresh(headRow: Skill, expected: number): void {
  if (expected !== headRow.version) {
    throw new SkillPermissionError(
      "SKILL_VERSION_STALE",
      `expected version ${expected}, head is ${headRow.version}`,
    );
  }
}
