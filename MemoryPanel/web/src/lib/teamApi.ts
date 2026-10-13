/**
 * teamApi.ts — Control API barrel re-export。
 *
 * The original 1400+ line file has been split by business domain into lib/api/:
 *   - api/base.ts          infrastructure (ApiError / request / metaPost / metaListAll / ...)
 *   - api/types.ts         cross-module shared types
 *   - api/meta-instances   pick an instance before login
 *   - api/auth.ts          login liveness check + environment binding
 *   - api/teams.ts         Team + Member
 *   - api/agents.ts        Agent
 *   - api/tasks.ts         Task + ParticipationLog
 *   - api/users.ts         User + UserKey + UserConfig
 *   - api/assets.ts        Asset
 *   - api/skills.ts        Skill data plane
 *   - api/chat-memory.ts   Chat Memory
 *
 * External consumers can keep using `import { xxx } from '@/lib/teamApi'` without changing paths.
 * New code should import directly from `@/lib/api/xxx` as needed to reduce bundle size.
 */

// ── Infrastructure ──
export { ApiError, onUnauthorized, clearSessionCache, PANEL_CAPABILITIES } from './api/base';

// ── Meta Instances ──
export { metaInstancesApi, type MetadataInstance } from './api/meta-instances';

// ── Auth + Environment Bindings ──
export {
  authVerifyApi,
  authMethodsApi,
  userKeyLoginApi,
  environmentBindingsApi,
  type AuthMethod,
  type EnvironmentBinding,
} from './api/auth';

// ── Teams + Members ──
export { teamsApi, membersApi } from './api/teams';

// ── Agents ──
export {
  agentsApi,
  type AgentTemplateConfig,
  type AgentTemplateAssetIds,
} from './api/agents';

// ── Tasks + Participation Logs ──
export {
  tasksApi,
  participationLogsApi,
  type TaskStatus,
  type TaskSourceType,
  type BackendTask,
  type BackendTaskAgent,
  type BackendTaskWithAgents,
  type ParticipationLogEntity,
} from './api/tasks';

// ── Users + UserKeys + UserConfig ──
export {
  usersApi,
  userKeysApi,
  userConfigApi,
  type CreateUserResult,
  type UserKey,
  type AssetCapabilityKey,
  type UserConfigItem,
  type UserConfigView,
  type AssetCapabilityConfig,
} from './api/users';

// ── Assets ──
export { assetsApi } from './api/assets';

// ── Skills ──
export {
  skillApi,
  type SkillSummary,
  type SkillManifestEntry,
  type SkillDetail,
  type SkillResourcePayload,
  type SkillFileContent,
} from './api/skills';

// ── Chat Memory ──
export {
  chatMemoryApi,
  type ChatMemoryBlock,
  type ChatMemoryLayerItem,
  type ChatMemorySearchHit,
} from './api/chat-memory';

// ── Shared types (passed through from types.ts) ──
export type {
  MetaEnvelope,
  PaginatedResult,
  PublicUser,
  Team,
  TeamMember,
  Agent,
  AssetType,
  AssetStatus,
  Asset,
  AgentAssetView,
  FixedAssetBinding,
} from './api/types';
