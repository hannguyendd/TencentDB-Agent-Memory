/**
 * services/index.ts -- domain service facade
 *
 * Components uniformly import from @/services.
 * Team / Agent / Task have switched to backend path A (services/backendStore.ts,
 * which internally calls the meta endpoints of @/lib/teamApi);
 * the rest (accounts / user profile / api key / asset scope / user asset / agent template)
 * have no corresponding backend capability yet and still go through the local localStorage demo layer (split into separate files by responsibility), to be replaced one by one later.
 */

// ===== Types =====
export type {
  TeamMember,
  Team,
  Task,
  TaskStatus,
  TaskSourceType,
  Agent,
} from './backendStore';
export type { AgentTemplate } from './agent-template-store';
export type { AssetKind, AssetConfigScope, AssetScopeRecord } from './asset-scope-store';
export type { UserAssetKind, UserAsset } from './user-asset-store';
export type { MockAccount } from './account-store';

// ===== Team / Agent / Task service (path A, backend persistence)=====
export {
  readActiveTeamId,
  writeActiveTeamId,
  useTeams,
  useAgents,
  useTasks,
  readActiveTeamAgents,
  isTeamAdmin,
  isTeamMember,
  roleInTeam,
  canManageAsset,
  canEditTask,
  canDeleteTask,
  invalidateBackendCache,
  clearBackendCache,
  invalidateTeamCache,
  writeAgentUiMeta,
  createTaskAsync as createTask,
  deleteTaskAsync as deleteTask,
  updateTaskAsync as updateTask,
  updateTaskStatusAsync as updateTaskStatus,
} from './backendStore';

// ===== Agent template service =====
export {
  readAgentTemplates,
  createAgentTemplate,
  deleteAgentTemplate,
} from './agent-template-store';

// ===== Account service =====
export {
  findAccountByEmail,
  findAccountByUsername,
  verifyAccountCredentials,
  createAccount,
  batchCreateAccounts,
  changePassword,
  setAccountPassword,
  updateAccountEmail,
  getAllAccounts,
} from './account-store';

// ===== User display name service =====
export {
  useUserDisplayName,
  seedDisplayNameCache,
} from './user-profile-store';

// ===== API Key service (path A auxiliary REST, see userKeysApi in @/lib/teamApi, called directly by ApiKeyPanel)=====

// ===== Asset scope service =====
export {
  getAssetConfigScope,
  setAssetConfigScope,
  canManageAssetScope,
  useAssetConfigScopes,
} from './asset-scope-store';

// ===== User asset service =====
export {
  createUserAsset,
  updateUserAsset,
  deleteUserAsset,
  getUserAssetsByOwner,
  getTeamVisibleAssets,
} from './user-asset-store';

// ===== Permission helpers (global admin check, pure frontend auth state implementation, no backend concept)=====
export { isGlobalAdmin } from './permissions';

// ===== Role hook =====
export { useCurrentRole } from './useCurrentRole';
export type { TeamRole } from './useCurrentRole';
