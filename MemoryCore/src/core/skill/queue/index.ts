/**
 * src/core/skill/queue/index.ts
 *
 * **Interface-type barrel** of the Skill extraction module. The old job queues (LocalSkillTaskQueue /
 * RedisSkillTaskQueue / SkillExtractWorkerV2 / SkillExtractJob, etc.) were already deleted in the
 * 2026-07-17 skill_extract → direct-archive rework; the extraction pipeline now goes entirely through
 * SkillTriggerService under `src/core/skill/conversation-add/` +
 * SkillConversationExtractWorker + SkillAgentTaskQueue.
 *
 * This module keeps only the Worker/extractor interface-layer types (ConversationMessage /
 * ExtractedCandidate / ISkillExtractor / ExtractorLogger), for reuse by
 * conversation-add/extract-worker.ts and skill-extractor.ts.
 */

export type {
  ConversationMessage,
  ExtractedCandidate,
  ISkillExtractor,
  ExtractorLogger,
} from "./types.js";
