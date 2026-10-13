/**
 * SkillCoreSink — registers a fallback skill asset for the candidates extracted by SkillConversationExtractWorker.
 *
 * ⚠️ Semantic clarification (fully aligned with the fallback path of the old `/v3/skill/extract` synchronous branch):
 *   SkillExtractor internally runs a tool-calling review agent — the agent calls `SkillCore.create`
 *   directly through the create tool in `<skill_tools>` to persist the skill,
 *   and a candidate is only an "after-the-fact receipt" (carrying skill_id / name / action="create").
 *
 *   So the sink **should not** call SkillCore.create again, otherwise it would:
 *     1) conflict on the same name / same team → throw SKILL_NAME_DUPLICATE
 *     2) the candidate usually has no content either (the extractor persists directly with tool-call parameters,
 *        and the result payload keeps only a skill_id / name summary)
 *
 *   The sink only does fallback asset registration — in standalone mode SkillVersioning has no
 *   onSkillCreated hook attached (to avoid coupling core with metadata), so asset registration must be filled in here;
 *   in service mode buildSkillCore has already attached the hook, and calling ensureSkillAsset here is idempotent,
 *   serving as a double safeguard.
 */

import type { ExtractedCandidate, ExtractorLogger } from "../queue/types.js";
import type { SkillCandidatesSink } from "./extract-worker.js";

/** Aligned with the shape used by the gateway-side MetadataService (only ensureSkillAsset is used). */
export interface MetadataServiceLike {
  ensureSkillAsset(input: {
    skill_id: string;
    team_id: string;
    agent_id: string;
    name: string;
  }): Promise<unknown>;
}

export interface SkillCoreSinkOptions {
  /** Optional — registers the asset as a fallback when a metadata service is present. When missing the sink is a no-op. */
  metadata?: MetadataServiceLike;
  logger: ExtractorLogger;
}

/**
 * SkillCoreSink only does fallback asset registration and no longer creates skills.
 * The skill itself has already been persisted by SkillExtractor's tool-call review agent via SkillCore.create.
 */
export class SkillCoreSink implements SkillCandidatesSink {
  constructor(private readonly opts: SkillCoreSinkOptions) {}

  async applyCandidates(input: {
    task: {
      team_id: string;
      user_id: string;
      agent_id: string;
      task_ref_id?: string;
      session_id: string;
    };
    candidates: ExtractedCandidate[];
    workerId: string;
  }): Promise<void> {
    const { metadata, logger } = this.opts;
    const { task, candidates, workerId } = input;
    if (!candidates.length) return;
    if (!metadata) return; // no metadata → the sink is a no-op (asset registration can only rely on the hook)

    for (const c of candidates) {
      if (c.action !== "create") {
        // currently only create is assetized; patch/update need no re-registration of the asset (skill_id unchanged)
        continue;
      }
      const skillId = c.skill_id;
      const name = c.name;
      if (!skillId || !name) {
        logger.warn(
          `[skill-core-sink] worker=${workerId} candidate missing skill_id/name — skip asset register`,
        );
        continue;
      }
      try {
        await metadata.ensureSkillAsset({
          skill_id: skillId,
          team_id: task.team_id,
          agent_id: task.agent_id,
          name,
        });
      } catch (err) {
        // asset registration failure does not affect the main flow — the skill is already in the skills table,
        // the frontend control page may not show it, and ops can fill it in later
        logger.warn(
          `[skill-core-sink] worker=${workerId} ensureSkillAsset failed skill_id=${skillId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }
}
