/**
 * Skill module entry point — v2 redesign (2026-06-17)
 *
 * Design doc: docs/design/2026-06-17-skill-redesign-v2.md
 *
 * Single table with multiple versions (skill_id, version jointly unique); the DB is the authoritative
 * source for SKILL.md and the manifest; storage holds only resource bytes. Binding semantics are all handed up to the control plane, and the data plane records by the
 * (user_id, owner_agent_id, team_id, task_id, skill_id) 5-tuple identity.
 */

// types
export type {
  IdFields,
  SkillStatus,
  SkillManifestEntry,
  Skill,
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  ExtractMessage,
} from "./types.js";

// config parsing
export type {
  SkillConfigInput,
  ResolvedSkillConfig,
  SkillDegradation,
  SkillEnvProbe,
  SkillSimilarityResult,
  SkillProposeResult,
} from "./types.js";
export { resolveSkillConfig } from "./skill-config.js";
export type { ResolverLogger } from "./skill-config.js";

// SKILL.md format helpers
export {
  parseSkillFile,
  validateSkillFile,
  formatSkillFile,
} from "./skill-format.js";

// DDL constants
export {
  SKILLS_DDL,
  SKILL_FTS_DDL,
  SKILL_VEC_DDL_TEMPLATE,
  FTS_CONTENT_MAX,
} from "./skill-store-ddl.js";

// storage interface abstraction
export type {
  ISkillStore,
  SkillStoreCapabilities,
  SkillSearchResult,
  ExpiredVersionMeta,
} from "./skill-store.interface.js";

// data access layer
export {
  SqliteSkillStore,
  type SqliteSkillStoreOptions,
} from "../store/sqlite/skill-store.js";
export {
  SkillStoreError,
  IdempotentNoOpError,
  type SkillErrorCode as SkillStoreErrorCode,
} from "./skill-store.interface.js";

// resource layer
export {
  SkillResourceStore,
  SkillResourceError,
  type SkillResourcePayload,
  type SkillResourceReadResult,
  type ResourceErrorCode,
} from "./skill-resource-store.js";

// version orchestration
export {
  SkillVersioning,
  type SkillVersioningOptions,
  type AppendVersionContext,
  type AppendVersionMutation,
} from "./skill-versioning.js";

// permission utilities
export {
  SkillPermissionError,
  assertOwner,
  assertTeamMatch,
  assertVersionFresh,
  type SkillPermissionErrorCode,
} from "./skill-permission.js";

// core facade
export {
  SkillCore,
  SkillCoreError,
  type SkillCoreErrorCode,
  type SkillCoreOptions,
  type CreateInput,
  type UpdateInput,
  type PatchInput,
  type DeleteInput,
  type GetInput,
  type WriteFilesInput,
  type RemoveFilesInput,
  type ReadFileInput,
  type ListInput,
  type SearchInput,
  type ListVersionsInput,
} from "./skill-core.js";

// extraction pipeline
export {
  SkillExtractor,
  createExtractorAdapter,
  type ExtractorRunner,
  type ExtractorOptions,
  type ExtractInput,
  type ExtractResult,
} from "./skill-extractor.js";

export {
  createSkillTools,
  type ExtractedAction,
  type ExtractedSkillCandidate,
  type CreateSkillToolsOptions,
} from "./skill-tools.js";

// Listing prompt constants
export {
  SKILL_LISTING_HEADER,
  SKILL_LISTING_FOOTER,
  SKILLS_GUIDANCE,
} from "./prompts/skill-listing-prompt.js";

// extraction prompts
//   - SKILL_REVIEW_PROMPT       : used by default for real-time extraction (v2 lenient, introduced 2026-08-10)
//   - SKILL_REVIEW_PROMPT_STRICT: used for cold start / bulk import (v1 strict gate restored)
//     injected by the SkillExtractor constructor strictSystemPrompt, enabled only when extract()'s
//     input.mode==='strict'; fully backward compatible (old calls unaffected).
export { SKILL_REVIEW_PROMPT } from "./prompts/skill-review-prompt.js";
export { SKILL_REVIEW_PROMPT_STRICT } from "./prompts/skill-review-prompt-strict.js";

// ExtractorLLMRunner shared by worker / dedupe in the extraction pipeline (shape-compatible with the v2 ExtractorRunner).
export type { ExtractorLLMRunner } from "./types.js";
