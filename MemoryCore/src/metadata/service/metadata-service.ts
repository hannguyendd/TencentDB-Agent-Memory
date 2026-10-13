/**
 * MetadataService — metadata business orchestration layer.
 *
 * Corresponds to design doc §2 / §7 / §10. Layers business constraints on top of IMetadataStore:
 *   - createAgent/createTask/createAsset verify the team exists
 *   - createTask linkAgents verifies agents are in the same team
 *   - setAgentFixedAssets uses canBindAsset to validate visibility
 *   - listAgentFixedAssetsWithDetail aggregates agent + details + (optional) visibility filtering + touchUsage
 *   - checkAssetPermission lazily loads ACLs (no table lookup when role defaults cover it)
 *   - user_key generation/refresh
 *
 * Unaware of the concrete backend (SQLite / MongoDB), keeping storage swappable.
 */

import { DuplicateUserKeyError, type IMetadataStore } from "../store/interface.js";
import {
  checkPermission,
  canBindAsset,
  roleDefaultCovers,
  type PermCheckResult,
  type PermCheckLogger,
} from "./permission-checker.js";
import {
  maskUserKey, maskKeyValue, isUserKeyExpired, DEFAULT_MAX_ACTIVE_USER_KEYS,
} from "../utils/user-key.js";
import {
  lookupMemorySystemUser,
  isMemorySystemUserKey,
  toMemorySystemVerifyUser,
  type MemorySystemUserConfig,
} from "../system-user.js";
import { resolveUserId } from "./resolve-user-id.js";
import type { V3AuthContext } from "../router/auth.js";
import { DEFAULT_INSTANCE_ID, DEFAULT_AUTH_PROVIDER } from "../constants.js";
import {
  canManageUsers,
  canViewUser,
  filterVisibleUsers,
  isSystemAdminUser,
  toPublicUser,
} from "./user-visibility.js";
import type {
  UserEntity,
  UserPublic,
  UserKeyEntity,
  UserKeyPublic,
  UserKeyCreated,
  TeamEntity,
  TeamMemberEntity,
  TeamMemberView,
  AgentEntity,
  TaskEntity,
  TaskAgentEntity,
  ParticipationLogEntity,
  AppendParticipationLogInput,
  ParticipationLogFilter,
  AssetEntity,
  FixedAssetBindingEntity,
  AgentFixedAssetSummary,
  AgentFixedAssetSummaryResult,
  FixedAssetTypeCounts,
  SummarizeAgentFixedAssetsParams,
  AclEntity,
  CreateUserInput,
  InitAdminInput,
  InitAdminResult,
  CreateUserApiResult,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  AssetFilter,
  BatchDeleteResult,
  AssetType,
  AssetVisibility,
  AssetStatus,
  InjectionMode,
  Permission,
  UserType,
  PaginatedResult,
  PaginationParams,
  InstanceUserListFilter,
  UserListFilter,
  InstanceUpstreamConfigEntity,
  InstanceUpstreamConfigFilter,
  CreateInstanceUpstreamGroupInput,
  UpdateInstanceUpstreamGroupInput,
  ToggleInstanceUpstreamGroupInput,
  DeleteInstanceUpstreamGroupInput,
  SupportedAgent,
  GroupType,
  UpstreamMode,
} from "../types.js";
import {
  DEFAULT_GROUP_NAME,
  EXTRACTION_GROUP_NAME,
  InstanceUpstreamWriteConflictError,
} from "../types.js";
import { formatListResult, paginateArray, resolvePagination, wrapPaginated, DEFAULT_PAGINATION } from "../pagination.js";
import { generateId, ID_PREFIX } from "../utils/id-generator.js";
import { buildChatMemoryAssetId, resolveChatMemoryAgentId } from "../utils/chat-memory-asset.js";

// ── Default Agent / Team constants ──

const DEFAULT_TEAM_NAME = "default-team";
const DEFAULT_TEAM_DESCRIPTION = "Default team created automatically at system initialization, used to hold the default assistant";

const DEFAULT_AGENT_NAME = "default-agent";
const DEFAULT_AGENT_DESCRIPTION = "Default assistant that can handle general development tasks and day-to-day collaboration.";

// The prompt concatenation format is exactly the same as when the frontend creates an Agent manually:
// [card.rolePrompt, card.rulesPrompt].filter(Boolean).join('\n\n')
const DEFAULT_AGENT_ROLE_PROMPT = "";
const DEFAULT_AGENT_RULES_PROMPT = "";
const DEFAULT_AGENT_PROMPT = [DEFAULT_AGENT_ROLE_PROMPT, DEFAULT_AGENT_RULES_PROMPT]
  .filter(Boolean)
  .join("\n\n");

// metadata_json stores the split role_prompt / rules_prompt,
// consistent with the "ui" namespace format of the frontend's writeAgentUiMeta / readAgentUiMeta,
// so that the Agent detail page shows the "role prompt" and the "fixed rules prompt" separately.
const DEFAULT_AGENT_METADATA_JSON = JSON.stringify({
  ui: {
    role_prompt: DEFAULT_AGENT_ROLE_PROMPT,
    rules_prompt: DEFAULT_AGENT_RULES_PROMPT,
  },
});

/** Business validation error, carrying a code that can be mapped to an HTTP status. */
export class MetadataError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /**
     * Optional: structured detail, carried into the envelope response for the frontend to render
     * (e.g. the conflict_groups list of AGENTS_OVERLAP, the rejected_fields of DEFAULT_GROUP_IMMUTABLE_FIELDS).
     */
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MetadataError";
  }
}

/**
 * Clear the chat_memory content of a (team, agent) (L0/L1/L2/L3 + vectors + files).
 *
 * Implemented and injected at the gateway assembly point (see MetadataService.setChatMemoryContentCleaner),
 * because the content lives in IMemoryStore / StorageAdapter, not in the metadata store.
 */
export type ChatMemoryContentCleaner = (params: {
  teamId: string;
  agentId: string;
}) => Promise<void>;

/** Detect unique constraint violation (SQLite UNIQUE or MongoDB E11000) on a specific column. */
function isUniqueViolation(err: unknown, column?: string): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (/UNIQUE constraint failed/.test(msg)) {
    return column ? msg.includes(column) : true;
  }
  if ((err as any).code === 11000) {
    if (!column) return true;
    const kp = (err as any).keyPattern;
    return kp ? column in kp : msg.includes(column);
  }
  return false;
}

export interface AgentBasicData {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  prompt: string | null;
  visibility: AssetVisibility;
  status: string;
}

export interface AgentAssetView {
  asset_id: string;
  asset_type: AssetType;
  name: string;
  description: string | null;
  status: AssetStatus;
  visibility: AssetVisibility;
  injection_mode: InjectionMode;
  priority: number;
  created_at: string;
}

export interface ListWithDetailParams {
  agent_id: string;
  apply_visibility_filter?: boolean;
  touch_usage?: boolean;
  limit?: number;
  offset?: number;
  /** Optional type filter: only return asset_types that match the list; omitted / empty array = no filtering. */
  asset_types?: Array<"skill" | "llm_wiki" | "code_graph" | "chat_memory">;
}

export interface AgentFixedAssetDetailResult {
  agent: AgentBasicData;
  items: AgentAssetView[];
  total: number;
  limit: number;
  offset: number;
}

export interface CheckPermissionParams {
  user_id?: string;
  user_key?: string;
  asset_id: string;
  action: Permission;
  agent_id?: string;
}

export interface ListAccessibleAssetsParams {
  user_id?: string;
  user_key?: string;
  team_id?: string;
  action?: Permission;
  asset_type?: AssetType;
  agent_id?: string;
  /**
   * Optional visibility allowlist, for secondary filtering after the permission decision.
   * Example: `["team"]` = only return team-visible items (used by the control page's "Team assets" tab);
   * omitted = return everything accessible (including one's own private).
   * Purpose: so the frontend never receives unneeded data in the HTTP response (security + smaller payload).
   */
  visibility?: AssetEntity["visibility"] | AssetEntity["visibility"][];
  limit?: number;
  offset?: number;
}

const FILTERED_STATUSES: AssetStatus[] = ["archived", "deprecated", "failed"];

export interface MetadataQuotaLimits {
  maxUsersPerInstance: number;
  maxTeamsPerInstance: number;
}

export const DEFAULT_METADATA_QUOTA_LIMITS: MetadataQuotaLimits = {
  maxUsersPerInstance: 500,
  maxTeamsPerInstance: 100,
};

export class MetadataService {
  private readonly quota: MetadataQuotaLimits;
  private readonly memorySystemUser?: MemorySystemUserConfig;
  private _configParams?: import("./config-param-service.js").IConfigParamService;

  /**
   * In-process LRU cache: the set of chat_memory asset ids already confirmed (existing in the store).
   *
   * A hit lets us skip the three DB round trips of getAssetById + createAsset + addAgentFixedAsset.
   * A miss goes through the full ensure flow and writes to the cache on success. Across processes/pods each maintains its own
   * LRU -- consistency is guaranteed by the store primary key constraint.
   *
   * Uses the Map's insertion order + evicts the oldest entry at the limit. It is not a strict LRU (no touch),
   * but sufficient for this "write once, hit afterwards" scenario: once confirmed to exist, the entry either keeps
   * hitting or gets pushed out by a newer team+agent and goes through the DB once more -- the cost of a cold eviction is just one
   * database query. maxSize is controlled by CHAT_MEMORY_ENSURE_CACHE_SIZE.
   */
  private readonly ensuredChatMemoryAssets = new Map<string, true>();
  private static readonly CHAT_MEMORY_ENSURE_CACHE_SIZE = 4096;

  /**
   * In-process LRU for skill asset registration: key = skill_id (i.e. asset_id).
   * Same semantics as ensuredChatMemoryAssets, short-circuiting repeated create+bind in ensureSkillAsset.
   */
  private readonly ensuredSkillAssets = new Map<string, true>();
  private static readonly SKILL_ENSURE_CACHE_SIZE = 4096;

  /** chat_memory content cleaner injected by the gateway; when not injected, archiving only deletes the asset and does not clear content. */
  private _chatMemoryContentCleaner?: ChatMemoryContentCleaner;

  constructor(
    private readonly store: IMetadataStore,
    private readonly instanceId: string = DEFAULT_INSTANCE_ID,
    private readonly logger: PermCheckLogger = { debug: () => {} },
    quotaLimits?: Partial<MetadataQuotaLimits>,
    memorySystemUser?: MemorySystemUserConfig,
  ) {
    this.quota = { ...DEFAULT_METADATA_QUOTA_LIMITS, ...quotaLimits };
    this.memorySystemUser = memorySystemUser;
  }

  get scopedInstanceId(): string {
    return this.instanceId;
  }

  get configParams(): import("./config-param-service.js").IConfigParamService {
    if (!this._configParams) {
      throw new Error("ConfigParamService not initialized. Call setConfigParamService() after store.init().");
    }
    return this._configParams;
  }

  setConfigParamService(svc: import("./config-param-service.js").IConfigParamService): void {
    this._configParams = svc;
  }

  /**
   * Inject the "chat_memory content cleaner".
   *
   * Why an optional hook instead of depending on the store directly: the metadata layer only holds IMetadataStore
   * (metadata) and cannot reach IMemoryStore / StorageAdapter (L0–L3 content). When archiving an
   * Agent, its memory content must be deleted too, so the cleanup capability has to be injected from the gateway assembly point
   * -- the same pattern as setConfigParamService, keeping the dependency direction from reversing.
   *
   * When not injected, archiveAgent degrades to the original behavior (only deletes the asset, does not clear content), so
   * scenarios that do not wire this hook, such as unit tests / migration scripts, are unaffected.
   */
  setChatMemoryContentCleaner(cleaner: ChatMemoryContentCleaner): void {
    this._chatMemoryContentCleaner = cleaner;
  }

  /** The static memory key is only for the auth/verify body and cannot be used for Header auth. */
  isConfiguredMemorySystemUserKey(userKey: string): boolean {
    return isMemorySystemUserKey(userKey, this.memorySystemUser);
  }

  private pag(input: { limit?: number; offset?: number }): PaginationParams {
    return resolvePagination(input);
  }

  private async allAclRecords(assetId: string): Promise<AclEntity[]> {
    const out: AclEntity[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const page = await this.store.listAclByAsset(assetId, { limit, offset });
      out.push(...page.items);
      if (offset + page.items.length >= page.total) break;
      offset += limit;
    }
    return out;
  }

  /** internal: list users by instance with pagination (including system_admin, not sanitized). */
  async listUsersByInstance(
    instanceId: string,
    pagination: PaginationParams,
    filter?: InstanceUserListFilter,
  ): Promise<PaginatedResult<UserEntity>> {
    void instanceId;
    const page = await this.store.listUsers(pagination, filter);
    return formatListResult(page, pagination);
  }

  /** Validate that the user exists, otherwise throw not_found. */
  private async requireUser(userId: string): Promise<UserEntity> {
    const user = await this.getUserById(userId);
    if (!user) throw new MetadataError("user_not_found", `user not found: ${userId}`);
    return user;
  }

  get rawStore(): IMetadataStore {
    return this.store;
  }

  private async assertUserQuota(): Promise<void> {
    const count = await this.store.countUsers();
    const limit = this._configParams
      ? await this._configParams.getEffectiveInt("quota", "max_users_per_instance")
      : this.quota.maxUsersPerInstance;
    if (count >= limit) {
      throw new MetadataError(
        "user_limit_exceeded",
        `user limit ${limit} reached for instance ${this.instanceId} (current: ${count})`,
      );
    }
  }

  private async assertTeamQuota(): Promise<void> {
    const count = await this.store.countTeams();
    const limit = this._configParams
      ? await this._configParams.getEffectiveInt("quota", "max_teams_per_instance")
      : this.quota.maxTeamsPerInstance;
    if (count >= limit) {
      throw new MetadataError(
        "team_limit_exceeded",
        `team limit ${limit} reached for instance ${this.instanceId} (current: ${count})`,
      );
    }
  }

  // ============================================================
  // User (including user_key generation/refresh)
  // ============================================================
  async initAdminUser(input: InitAdminInput): Promise<InitAdminResult> {
    if ((await this.store.countUsers()) > 0) {
      throw new MetadataError("already_initialized", "system already has users; init-admin requires empty database");
    }
    if ((await this.store.countSystemAdmins()) > 0) {
      throw new MetadataError("already_initialized", "system_admin already exists");
    }

    // Core operation: create the admin user
    const created = await this.createUserWithType(
      { username: input.username, default_key_value: input.user_key },
      "system_admin",
    );

    // Auxiliary operation: automatically create the default Team and Agent (failure does not block the core flow)
    try {
      const team = await this.createTeam({
        name: DEFAULT_TEAM_NAME,
        description: DEFAULT_TEAM_DESCRIPTION,
        owner_user_id: created.user_id,
      });

      try {
        const agentName = `${DEFAULT_AGENT_NAME}-${input.username}`;
        await this.createAgent({
          team_id: team.team_id,
          owner_user_id: created.user_id,
          name: agentName,
          description: DEFAULT_AGENT_DESCRIPTION,
          prompt: DEFAULT_AGENT_PROMPT,
          metadata_json: DEFAULT_AGENT_METADATA_JSON,
          visibility: "team",
          status: "active",
        });
      } catch (err) {
        console.warn(
          `[init-admin] Failed to create default Agent, skipped (user=${created.user_id})`,
          err instanceof Error ? err.message : err,
        );
      }
    } catch (err) {
      console.warn(
        `[init-admin] Failed to create default Team, skipped (user=${created.user_id})`,
        err instanceof Error ? err.message : err,
      );
    }

    return { user_id: created.user_id, user_key: created.default_user_key };
  }

  async createNormalUser(input: CreateUserInput): Promise<CreateUserApiResult> {
    return this.createUserWithType(input, "normal");
  }

  /**
   * Only for /v3/meta/user/create-with-key: lets system_admin explicitly specify user_key when creating an account.
   *
   * Two layers of dedupe:
   *   1. Pre-check getUserByKey: fail fast on the normal path, without entering a transaction
   *   2. store-layer UNIQUE constraint (DuplicateUserKeyError): TOCTOU / concurrency backstop
   *
   * The router layer must first call assertCanManageUsers for authorization.
   */
  async createNormalUserWithKey(input: {
    username: string;
    user_key: string;
    /** Passed when creating an account via external auth (e.g. WOA employee ID), used to determine whether it is a first login next time. */
    external_id?: string;
    /** External auth system identifier (e.g. woa); same domain as external_id, falling back to local by default. */
    auth_provider?: string;
    display_name?: string;
    email?: string;
  }): Promise<CreateUserApiResult> {
    const existing = await this.store.getUserByKey(input.user_key);
    if (existing) {
      throw new MetadataError("duplicate_user_key", "user_key already exists");
    }
    try {
      return await this.createUserWithType(
        {
          username: input.username,
          default_key_value: input.user_key,
          external_id: input.external_id,
          auth_provider: input.auth_provider,
          display_name: input.display_name,
          email: input.email,
        },
        "normal",
      );
    } catch (err) {
      if (err instanceof DuplicateUserKeyError) {
        throw new MetadataError("duplicate_user_key", "user_key already exists");
      }
      throw err;
    }
  }

  /** Fill in defaults when auth_provider / external_id are not passed (local / user_id). */
  private resolveCreateUserInput(
    input: CreateUserInput,
  ): CreateUserInput & { auth_provider: string; external_id: string } {
    // Explicitly carrying external_id = external-auth account creation: even if the caller omits auth_provider, it must land
    // in the external domain, the same domain read by find-by-external.
    // Otherwise it would be "written into the local domain but queried in the external domain", and the next login would be misjudged as first.
    const externalId = input.external_id?.trim();
    const authProvider = input.auth_provider?.trim() || DEFAULT_AUTH_PROVIDER;
    if (externalId) {
      return { ...input, auth_provider: authProvider, external_id: externalId };
    }
    const userId = input.user_id ?? generateId(ID_PREFIX.user);
    return { ...input, auth_provider: authProvider, user_id: userId, external_id: userId };
  }

  private async createUserWithType(input: CreateUserInput, userType: UserType): Promise<CreateUserApiResult> {
    const resolved = this.resolveCreateUserInput(input);
    await this.assertUserQuota();
    const user = await this.store.createUser({
      ...resolved,
      password: null,
      user_type: userType,
    });
    const defaultKey = await this.store.getDefaultUserKey(user.user_id);
    if (!defaultKey) {
      throw new MetadataError("internal_error", "default user key not created");
    }
    return {
      user_id: user.user_id,
      user_type: user.user_type,
      created_at: user.created_at,
      default_user_key: defaultKey.key_value,
    };
  }

  async getUserForCaller(userId: string, ctx: V3AuthContext): Promise<UserPublic> {
    const user = await this.getUserById(userId);
    if (!user || !canViewUser(user, ctx)) {
      throw new MetadataError("user_not_found", `user not found: ${userId}`);
    }
    return toPublicUser(user, ctx);
  }

  async getUserById(userId: string): Promise<UserEntity | null> {
    return this.store.getUserById(userId);
  }

  async getUserByKey(userKey: string): Promise<UserEntity | null> {
    return this.store.getUserByKey(userKey);
  }

  async getUserByExternalId(authProvider: string, externalId: string): Promise<UserEntity | null> {
    return this.store.getUserByExternalId(authProvider, externalId);
  }

  /**
   * After external auth (e.g. WOA) login, determine whether it is the first time: reverse look up the user by (auth_provider, external_id).
   *
   * Reuses core's existing meta_users.external_id field (introduced by origin, originally meant for Taihu OAuth2's
   * sub/employee ID, with semantics consistent with this requirement), without creating a new association table.
   *
   * Note: for accounts without a bound external identity, their external_id is filled by resolveCreateUserInput as the
   * user_id (`usr-xxx`), which differs from the employee-ID format, so it will not be hit by mistake.
   */
  async findUserByExternalId(
    externalId: string,
    authProvider?: string,
  ): Promise<UserEntity | null> {
    const provider = authProvider?.trim() || DEFAULT_AUTH_PROVIDER;
    return this.store.getUserByExternalId(provider, externalId);
  }

  /**
   * Bind the external auth unique identifier to an **existing** account (onboarding existing accounts to external auth).
   *
   * Only writes external_id, **does not change auth_provider** -- existing accounts originally log in with user_key,
   * and after binding they can still log in with the original user_key; external auth is just an added entry point.
   *
   * Conflict: throws when the external_id is already bound to **another** user, to avoid one external identity mapping to multiple accounts.
   * Idempotent: binding the same external_id to the same user again returns directly.
   */
  async bindExternalIdToUser(
    userId: string,
    externalId: string,
    authProvider?: string,
    displayName?: string,
  ): Promise<UserEntity> {
    const provider = authProvider?.trim() || DEFAULT_AUTH_PROVIDER;
    // First confirm the target account exists, to avoid binding an external identity to a nonexistent user.
    const user = await this.requireUser(userId);

    const existing = await this.store.getUserByExternalId(provider, externalId);
    if (existing && existing.user_id !== userId) {
      throw new MetadataError(
        "external_id_already_bound",
        `external_id is already bound to another user: ${existing.user_id}`,
      );
    }

    // Before binding, remove the possible false collision from the "unbound placeholder external_id" (= user_id):
    // if the target account currently holds the placeholder value and the external_id to bind happens to equal it (an extreme scenario),
    // the existing check above would hit itself and return early, so always go through one write.
    const patch: Partial<UserEntity> = {
      external_id: externalId,
      auth_provider: provider,
    };
    // The display name is only filled in when "it has a value and the target account's is currently empty":
    // it does not overwrite a manually changed name, nor write the IdP's empty value over an existing name.
    const incomingName = displayName?.trim();
    if (incomingName && !user.display_name) patch.display_name = incomingName;

    if (existing && existing.user_id === userId && !patch.display_name) return user;

    const updated = await this.store.updateUser(userId, patch);
    if (!updated) throw new MetadataError("user_not_found", `user not found: ${userId}`);
    return updated;
  }

  async deleteUsersForCaller(userIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    if (!canManageUsers(ctx)) {
      throw new MetadataError("permission_denied", "user management requires system admin");
    }
    let deletingSystemAdmins = 0;
    for (const id of userIds) {
      const u = await this.getUserById(id);
      if (u && isSystemAdminUser(u)) deletingSystemAdmins++;
    }
    const totalAdmins = await this.store.countSystemAdmins();
    if (totalAdmins > 0 && totalAdmins - deletingSystemAdmins < 1) {
      throw new MetadataError("last_system_admin", "cannot delete the last system_admin user");
    }
    return this.deleteUsers(userIds);
  }

  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteUsers(userIds);
  }

  async listUsersForCaller(
    input: { team_id?: string } & UserListFilter,
    ctx: V3AuthContext,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<UserPublic>> {
    const filtersPresent = !!(input.user_ids?.length || input.username);
    const storeFilter = this.buildUserListStoreFilter(input);

    if (!input.team_id) {
      if (!ctx.isSystemAdmin) {
        throw new MetadataError("missing_team_id", "team_id is required for non-system-admin callers");
      }
      const page = await this.store.listUsers(pagination, storeFilter);
      const items = filterVisibleUsers(page.items, ctx);
      return formatListResult({ items, total: page.total }, pagination);
    }

    const teamId = input.team_id;

    if (ctx.isSystemAdmin) {
      const page = await this.store.listUsersByTeam(teamId, pagination, storeFilter);
      const items = filterVisibleUsers(page.items, ctx);
      return formatListResult({ items, total: page.total }, pagination);
    }

    if (!ctx.userId) {
      throw new MetadataError("permission_denied", "authentication required");
    }

    const member = await this.store.getTeamMember(teamId, ctx.userId);
    if (!member || member.status !== "active") {
      throw new MetadataError("permission_denied", "not a team member");
    }

    const isTeamAdmin = member.role === "admin";
    if (isTeamAdmin) {
      const page = await this.store.listUsersByTeam(teamId, pagination, storeFilter);
      const items = filterVisibleUsers(page.items, ctx, { allowTeamPeers: true });
      return formatListResult({ items, total: page.total }, pagination);
    }

    if (filtersPresent) {
      throw new MetadataError("filter_not_allowed", "filters are not allowed for normal team members");
    }

    const self = await this.store.getUserById(ctx.userId);
    if (!self) {
      throw new MetadataError("user_not_found", `user not found: ${ctx.userId}`);
    }
    const visible = filterVisibleUsers([self], ctx);
    if (pagination.offset > 0) {
      return wrapPaginated([], 1, pagination);
    }
    return wrapPaginated(visible, 1, pagination);
  }

  private buildUserListStoreFilter(input: UserListFilter): InstanceUserListFilter | undefined {
    const filter: InstanceUserListFilter = {};
    if (input.user_ids?.length) filter.user_ids = input.user_ids;
    if (input.username) filter.username = input.username;
    return Object.keys(filter).length ? filter : undefined;
  }

  /** @deprecated Use listUsersForCaller */
  async listUsersByTeamForCaller(
    teamId: string,
    ctx: V3AuthContext,
    pagination: PaginationParams,
  ): Promise<PaginatedResult<UserPublic>> {
    return this.listUsersForCaller({ team_id: teamId }, ctx, pagination);
  }

  async listUsersByTeam(teamId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<UserEntity>> {
    const page = await this.store.listUsersByTeam(teamId, pagination);
    return formatListResult(page, pagination);
  }

  assertCanManageUsers(ctx: V3AuthContext): void {
    if (!canManageUsers(ctx)) {
      throw new MetadataError("permission_denied", "user management requires system admin");
    }
  }

  canManageUserScope(userId: string, ctx: V3AuthContext): boolean {
    return ctx.isAdmin || ctx.isSystemAdmin || ctx.userId === userId;
  }

  assertUserScope(userId: string, callerUserId?: string, isAdmin = false, isSystemAdmin = false): void {
    if (isAdmin || isSystemAdmin || userId === callerUserId) return;
    throw new MetadataError("permission_denied", "cannot access another user's keys");
  }

  assertCallerIsOwner(targetUserId: string, callerId: string): void {
    if (targetUserId !== callerId) {
      throw new MetadataError("permission_denied", "user_id does not match caller");
    }
  }

  async verifyAuthForCaller(userKey: string, ctx: V3AuthContext): Promise<{ valid: boolean; user: UserPublic | null }> {
    const user = await this.verifyAuth(userKey);
    if (!user) return { valid: false, user: null };
    const visibilityCtx: V3AuthContext = ctx.userId
      ? ctx
      : {
          token: userKey,
          userId: user.user_id,
          isAdmin: false,
          isSystemAdmin: user.user_type === "system_admin",
        };
    if (!canViewUser(user, visibilityCtx)) {
      return { valid: true, user: null };
    }
    if (this.memorySystemUser && user.user_id === this.memorySystemUser.userId) {
      return {
        valid: true,
        user: {
          user_id: user.user_id,
          user_type: user.user_type,
          username: user.username,
          created_at: user.created_at,
        },
      };
    }
    return { valid: true, user: toPublicUser(user, visibilityCtx) };
  }

  /** Validate the user_key and return the corresponding user (returns null if invalid). */
  async verifyAuth(userKey: string): Promise<UserEntity | null> {
    if (!userKey) return null;
    const configured = lookupMemorySystemUser(userKey, this.instanceId, this.memorySystemUser);
    if (configured) return configured;
    return this.store.getUserByKey(userKey);
  }

  toPublicUserKey(entity: UserKeyEntity): UserKeyPublic {
    return {
      key_id: entity.key_id,
      user_id: entity.user_id,
      key_prefix: maskUserKey(entity.key_value),
      name: entity.name ?? null,
      status: entity.status,
      is_default: entity.is_default,
      last_used_at: entity.last_used_at ?? null,
      expires_at: entity.expires_at ?? null,
      created_at: entity.created_at,
      revoked_at: entity.revoked_at ?? null,
    };
  }

  async createUserKey(
    userId: string,
    input: { name?: string | null; expires_at?: string | null },
  ): Promise<UserKeyCreated> {
    await this.requireUser(userId);

    const active = await this.store.countActiveUserKeys(userId);
    if (active >= this.maxActiveUserKeys) {
      throw new MetadataError("key_limit_exceeded", `active user key limit ${this.maxActiveUserKeys} reached`);
    }

    const entity = await this.store.createUserKey({
      user_id: userId,
      name: input.name,
      expires_at: input.expires_at,
      is_default: false,
    });
    return { ...this.toPublicUserKey(entity), key_value: entity.key_value };
  }

  async listUserKeys(userId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<UserKeyPublic>> {
    await this.requireUser(userId);
    const page = await this.store.listUserKeys(userId, pagination);
    const items = page.items.map((k) => this.toPublicUserKey(k));
    return formatListResult({ items, total: page.total }, pagination);
  }

  async getUserKey(keyId: string): Promise<UserKeyPublic> {
    const entity = await this.store.getUserKeyById(keyId);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    return this.toPublicUserKey(entity);
  }

  /** Verify the caller has access to the key (themselves, system_admin or bootstrap), returning the sanitized detail. */
  async getUserKeyForCaller(
    keyId: string,
    callerUserId?: string,
    isAdmin = false,
    isSystemAdmin = false,
  ): Promise<UserKeyPublic> {
    const entity = await this.store.getUserKeyById(keyId);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    const owner = await this.getUserById(entity.user_id);
    if (!owner) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }
    if (!isAdmin && !isSystemAdmin && entity.user_id !== callerUserId) {
      throw new MetadataError("permission_denied", "cannot access another user's key");
    }
    if (isSystemAdminUser(owner) && !isAdmin && callerUserId !== owner.user_id) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }
    return this.toPublicUserKey(entity);
  }

  async revokeUserKey(keyId: string): Promise<void> {
    const entity = await this.store.getUserKeyById(keyId);
    if (!entity) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    if (!(await this.getUserById(entity.user_id))) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }

    const active = await this.store.countActiveUserKeys(entity.user_id);
    if (active <= 1) {
      throw new MetadataError("last_key_cannot_revoke", "cannot revoke the last active user key");
    }

    console.info(
      `[META] revokeUserKey: user_id=${entity.user_id} key_id=${entity.key_id} key_prefix=${maskUserKey(entity.key_value)}`,
    );
    await this.store.revokeUserKey(keyId, { promoteNextDefault: true });
  }

  async updateUserKey(
    keyId: string,
    patch: { name?: string | null; expires_at?: string | null },
  ): Promise<UserKeyPublic> {
    const existing = await this.store.getUserKeyById(keyId);
    if (!existing) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    if (!(await this.getUserById(existing.user_id))) {
      throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    }

    const updated = await this.store.updateUserKey(keyId, patch);
    if (!updated) throw new MetadataError("user_key_not_found", `user key not found: ${keyId}`);
    return this.toPublicUserKey(updated);
  }

  private get maxActiveUserKeys(): number {
    const fromEnv = Number(process.env.TDAI_USER_KEY_MAX_ACTIVE);
    return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_MAX_ACTIVE_USER_KEYS;
  }

  // ============================================================
  // Team
  // ============================================================
  async createTeam(input: CreateTeamInput): Promise<TeamEntity> {
    await this.assertTeamQuota();
    return this.store.createTeam(input);
  }

  async getTeamById(teamId: string): Promise<TeamEntity | null> {
    return this.store.getTeamById(teamId);
  }

  async updateTeam(teamId: string, patch: Partial<TeamEntity>): Promise<TeamEntity> {
    if (!(await this.getTeamById(teamId))) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    const updated = await this.store.updateTeam(teamId, patch);
    if (!updated) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    return updated;
  }

  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteTeams(teamIds);
  }

  async listTeamsByUser(userId: string, pagination: PaginationParams = DEFAULT_PAGINATION, filter?: { name?: string }): Promise<PaginatedResult<TeamEntity>> {
    const page = await this.store.listTeamsByUser(userId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  // ============================================================
  // TeamMember
  // ============================================================
  async addTeamMember(input: AddTeamMemberInput): Promise<TeamMemberEntity> {
    const team = await this.getTeamById(input.team_id);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${input.team_id}`);
    const reqRole = input.role ?? "member";
    // owner is fixed as admin by createTeam; downgrading via add upsert is forbidden, otherwise
    // "still the owner but role≠admin" would occur -- the panel treats them as admin while team-member/add returns 403.
    if (input.user_id === team.owner_user_id && reqRole !== "admin") {
      throw new MetadataError("permission_denied", "cannot demote team owner");
    }
    const existing = await this.store.getTeamMember(input.team_id, input.user_id);
    if (existing?.status === "active" && existing.role === reqRole) {
      throw new MetadataError(
        "member_already_exists",
        `member already exists: ${input.team_id}/${input.user_id}`,
      );
    }

    // Core operation: add the user to the Team
    const result = await this.store.addTeamMember({ ...input, role: reqRole });

    return result;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.store.removeTeamMember(teamId, userId);
  }

  async listTeamMembers(teamId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<TeamMemberEntity>> {
    const page = await this.store.listTeamMembers(teamId, pagination);
    return formatListResult(page, pagination);
  }

  async getTeamMember(teamId: string, userId: string): Promise<TeamMemberEntity | null> {
    return this.store.getTeamMember(teamId, userId);
  }

  // ============================================================
  // Agent (verify team exists)
  // ============================================================
  async createAgent(input: CreateAgentInput): Promise<AgentEntity> {
    await this.assertTeamExists(input.team_id);
    const agent = await this.store.createAgent(input);
    // Outside the same transaction boundary that creates the agent, immediately mint the agent's chat_memory asset +
    // bind it to fixed_assets. Avoids Bug 2: on the first conversation the asset does not exist yet →
    // the first session prewarm of profile-memory-injector falls back to tools-only,
    // and under the session_init cache policy L3 can never be read within that session.
    //
    // Idempotent: ensureChatMemoryAsset internally no-ops on an existing asset / existing binding.
    // Failure is non-fatal: the agent was created successfully and chat_memory is just "prepared earlier";
    // even if it fails here, the /conversation/add path will retry ensure, so only log a warn here.
    try {
      await this.ensureChatMemoryAsset({
        team_id: agent.team_id,
        agent_id: agent.agent_id,
      });
    } catch (err) {
      // There is no dedicated warn logger here (the service layer only has PermCheckLogger.debug),
      // use console.warn, consistent with the same kind of catch in v2-router.handleConversationAdd.
      console.warn(
        `[META] createAgent: ensureChatMemoryAsset failed (agent=${agent.agent_id} team=${agent.team_id}): ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }
    return agent;
  }

  async getAgentById(agentId: string): Promise<AgentEntity | null> {
    return this.store.getAgentById(agentId);
  }

  async updateAgent(agentId: string, patch: Partial<AgentEntity>): Promise<AgentEntity> {
    if (!(await this.getAgentById(agentId))) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const updated = await this.store.updateAgent(agentId, patch);
    if (!updated) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    return updated;
  }

  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteAgents(agentIds);
  }

  async listAgentsByTeam(
    teamId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: AgentFilter,
  ): Promise<PaginatedResult<AgentEntity>> {
    const page = await this.store.listAgentsByTeam(teamId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  async listAgentsByOwner(
    userId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: AgentFilter,
  ): Promise<PaginatedResult<AgentEntity>> {
    const page = await this.store.listAgentsByOwner(userId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  /**
   * Archive (soft close) an agent.
   *
   * The order is critical -- **clear the content first, then delete the asset**:
   *   1. status → inactive
   *   2. Clear the agent's chat_memory content (L0/L1/L2/L3 + vectors + files)
   *   3. Delete its own chat_memory asset record (and cascade-clear the borrowed bindings of other agents)
   *
   * If the order is reversed (delete the asset first, then clear the content), once the asset record is gone, (team, agent) can no longer be located from
   * asset_id, and the content becomes **permanently unreachable orphan data**
   * left in the database -- which is exactly the problem this fix addresses.
   *
   * When content cleanup fails, **abort the archive** and throw upward: better to let the caller retry than to leave
   * the inconsistent state "asset deleted, content still there". When no cleaner is injected (unit tests / migration
   * scripts), step 2 is skipped, degrading to the original behavior.
   */
  async archiveAgent(agentId: string): Promise<AgentEntity> {
    const existing = await this.getAgentById(agentId);
    if (!existing) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const archived = await this.updateAgent(agentId, { status: "inactive" });

    if (this._chatMemoryContentCleaner) {
      await this._chatMemoryContentCleaner({
        teamId: existing.team_id,
        agentId: existing.agent_id,
      });
    }

    const selfMemoryAssetId = buildChatMemoryAssetId(existing.team_id, existing.agent_id);
    await this.store.deleteAssets([selfMemoryAssetId]);
    return archived;
  }

  // ============================================================
  // Task (verify team exists + linked agents in the same team)
  // ============================================================
  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    await this.assertTeamExists(input.team_id);
    for (const link of input.linked_agents ?? []) {
      const agent = await this.getAgentById(link.agent_id);
      if (!agent) {
        throw new MetadataError("agent_not_found", `agent not found: ${link.agent_id}`);
      }
      if (agent.team_id !== input.team_id) {
        throw new MetadataError(
          "agent_team_mismatch",
          `agent ${link.agent_id} not in team ${input.team_id}`,
        );
      }
    }
    return this.store.createTask(input);
  }

  async getTaskById(taskId: string): Promise<TaskEntity | null> {
    return this.store.getTaskById(taskId);
  }

  async updateTask(taskId: string, patch: Partial<TaskEntity>): Promise<TaskEntity> {
    if (!(await this.getTaskById(taskId))) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    const updated = await this.store.updateTask(taskId, patch);
    if (!updated) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    return updated;
  }

  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    return this.store.deleteTasks(taskIds);
  }

  async listTasksByTeam(
    teamId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: TaskFilter,
  ): Promise<PaginatedResult<TaskEntity>> {
    const page = await this.store.listTasksByTeam(teamId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  async listTasks(filter: TaskFilter, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<TaskEntity>> {
    const page = await this.store.listTasks(filter, pagination);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  /** Archive (soft close) a task: status → completed. */
  async archiveTask(taskId: string): Promise<TaskEntity> {
    return this.updateTask(taskId, { status: "completed" });
  }

  // ============================================================
  // TaskAgent
  // ============================================================
  async linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): Promise<TaskAgentEntity> {
    const task = await this.getTaskById(taskId);
    if (!task) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    if (agent.team_id !== task.team_id) {
      throw new MetadataError("agent_team_mismatch", `agent ${agentId} not in team ${task.team_id}`);
    }
    return this.store.linkTaskAgent(taskId, agentId, roleInTask);
  }

  async unlinkTaskAgent(taskId: string, agentId: string): Promise<void> {
    if (!(await this.getTaskById(taskId))) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    await this.store.unlinkTaskAgent(taskId, agentId);
  }

  async listTaskAgents(taskId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<TaskAgentEntity>> {
    const page = await this.store.listTaskAgents(taskId, pagination);
    return formatListResult(page, pagination);
  }

  // ============================================================
  // ParticipationLog
  // ============================================================
  async appendParticipationLog(input: AppendParticipationLogInput): Promise<ParticipationLogEntity> {
    await this.assertParticipationContext(input.team_id, input.task_id, input.agent_id, input.user_id);
    return this.store.appendParticipationLog(input);
  }

  async listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<ParticipationLogEntity>> {
    const page = await this.store.listParticipationLogs(filter, pagination);
    return formatListResult(page, pagination);
  }

  private async assertParticipationContext(
    teamId: string,
    taskId: string,
    agentId: string,
    userId: string,
  ): Promise<void> {
    await this.assertTeamExists(teamId);
    const task = await this.getTaskById(taskId);
    if (!task) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    if (task.team_id !== teamId) {
      throw new MetadataError("permission_denied", `task ${taskId} not in team ${teamId}`);
    }
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    // if (agent.team_id !== teamId) {
    //   throw new MetadataError("agent_team_mismatch", `agent ${agentId} not in team ${teamId}`);
    // }
    const member = await this.getTeamMember(teamId, userId);
    if (!member || member.status !== "active") {
      throw new MetadataError("member_not_found", `member not found: ${teamId}/${userId}`);
    }
    // const links = await this.store.listTaskAgents(taskId, { limit: 1000, offset: 0 });
    // if (!links.items.some((l) => l.agent_id === agentId)) {
    //   throw new MetadataError("task_agent_not_linked", `task ${taskId} not linked to agent ${agentId}`);
    // }
  }

  // ============================================================
  // Asset (main table only)
  // ============================================================
  async createAsset(input: CreateAssetInput): Promise<AssetEntity> {
    await this.assertTeamExists(input.team_id);
    return this.store.createAsset(input);
  }

  async getAssetById(assetId: string): Promise<AssetEntity | null> {
    return this.store.getAssetById(assetId);
  }

  async updateAsset(assetId: string, patch: Partial<AssetEntity>): Promise<AssetEntity> {
    if (!(await this.getAssetById(assetId))) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    const updated = await this.store.updateAsset(assetId, patch);
    if (!updated) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    return updated;
  }

  async deleteAssets(assetIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.store.deleteAssets(assetIds);
    // Clear the ensure cache, to avoid the short path misjudging "still exists" after deletion
    for (const id of result.deleted_ids) {
      this.ensuredSkillAssets.delete(id);
      this.ensuredChatMemoryAssets.delete(id);
    }
    return result;
  }

  async listAssetsByTeam(
    teamId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
    filter?: AssetFilter,
  ): Promise<PaginatedResult<AssetEntity>> {
    const page = await this.store.listAssetsByTeam(teamId, pagination, filter);
    const items = page.items;
    return formatListResult({ items, total: page.total }, pagination);
  }

  /**
   * Caller-perspective read for asset/get (horizontal privilege escalation fix):
   *   - system_admin exempt (admin-plane troubleshooting channel, same style as the isSystemAdmin special case of user/list);
   *   - the owner can always read (including archived, preserving the original admin-view behavior);
   *   - other callers go through checkAssetPermission (visibility → ACL);
   *   - no access returns null (the route layer maps it to 404, without leaking asset existence).
   */
  async getAssetForCaller(assetId: string, ctx: V3AuthContext): Promise<AssetEntity | null> {
    const asset = await this.getAssetById(assetId);
    if (!asset) return null;
    if (ctx.isSystemAdmin) return asset;
    if (!ctx.userId) return null;
    if (asset.owner_user_id === ctx.userId) return asset;
    const perm = await this.checkAssetPermission({ user_id: ctx.userId, asset_id: assetId, action: "read" });
    return perm.allowed ? asset : null;
  }

  /**
   * Caller-perspective read for asset/list (horizontal privilege escalation fix):
   *   - system_admin: the full admin-plane set (original listAssetsByTeam semantics preserved);
   *   - team members: the owner's assets are always visible, the rest go item by item through checkAssetPermission (same decision source as list-accessible);
   *   - non-team members / unresolved callers: empty page (no error, to avoid leaking team information).
   * Permission filtering is done before pagination, ensuring total is accurate.
   */
  async listAssetsForCaller(
    params: { team_id: string } & AssetFilter & PaginationParams,
    ctx: V3AuthContext,
  ): Promise<PaginatedResult<AssetEntity>> {
    const pagination = this.pag(params);
    const { team_id, limit: _limit, offset: _offset, ...filter } = params;
    if (ctx.isSystemAdmin) {
      return this.listAssetsByTeam(team_id, pagination, filter);
    }
    if (!ctx.userId) return paginateArray([], pagination);
    const member = await this.store.getTeamMember(team_id, ctx.userId);
    if (!member || member.status !== "active") return paginateArray([], pagination);

    const result: AssetEntity[] = [];
    let offset = 0;
    const limit = 100;
    while (true) {
      const page = await this.store.listAssetsByTeam(team_id, { limit, offset }, filter);
      for (const asset of page.items) {
        if (asset.owner_user_id === ctx.userId) {
          result.push(asset);
          continue;
        }
        const perm = await this.checkAssetPermission({
          user_id: ctx.userId,
          asset_id: asset.asset_id,
          action: "read",
        });
        if (perm.allowed) result.push(asset);
      }
      if (offset + page.items.length >= page.total) break;
      offset += limit;
    }
    return paginateArray(result, pagination);
  }

  async touchAssetUsage(assetId: string): Promise<void> {
    if (!(await this.getAssetById(assetId))) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    await this.store.touchAssetUsage(assetId);
  }

  async listAgentFixedAssets(
    agentId: string,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<FixedAssetBindingEntity>> {
    const page = await this.store.listAgentFixedAssets(agentId, pagination);
    return formatListResult(page, pagination);
  }

  /**
   * Fixed-asset allocation summary for multiple agents. Missing agent / type is filled with 0; items order matches the requested agent_ids.
   * Optional asset_id: only count rows bound to that asset (used for bound_agent_count).
   */
  async summarizeAgentFixedAssetsByAgents(
    params: SummarizeAgentFixedAssetsParams,
  ): Promise<AgentFixedAssetSummaryResult> {
    const agentIds = [...new Set(params.agent_ids.filter((id) => id.length > 0))];
    if (agentIds.length === 0) {
      return { items: [], total: 0 };
    }

    const emptyCounts = (): FixedAssetTypeCounts => ({
      skill: 0,
      code_graph: 0,
      llm_wiki: 0,
      chat_memory: 0,
    });

    const rows = await this.store.summarizeAgentFixedAssetsByAgents(agentIds, {
      assetId: params.asset_id,
    });

    const byAgent = new Map<string, FixedAssetTypeCounts>();
    const totals = new Map<string, number>();
    for (const id of agentIds) {
      byAgent.set(id, emptyCounts());
      totals.set(id, 0);
    }
    for (const row of rows) {
      const counts = byAgent.get(row.agent_id);
      if (!counts) continue;
      if (row.asset_type in counts) {
        counts[row.asset_type] = row.cnt;
      }
      totals.set(row.agent_id, (totals.get(row.agent_id) ?? 0) + row.cnt);
    }

    const items: AgentFixedAssetSummary[] = agentIds.map((agent_id) => ({
      agent_id,
      counts: byAgent.get(agent_id) ?? emptyCounts(),
      total: totals.get(agent_id) ?? 0,
    }));

    return { items, total: items.length };
  }

  // ============================================================
  // AgentFixedAsset (canBindAsset validation + detail aggregation)
  // ============================================================
  async setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): Promise<void> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);

    for (const b of bindings) {
      const asset = await this.getAssetById(b.asset_id);
      if (!asset) {
        throw new MetadataError("asset_not_found", `asset not found: ${b.asset_id}`);
      }
      if (!canBindAsset(agent, asset)) {
        throw new MetadataError(
          "asset_not_bindable",
          `asset ${b.asset_id} (visibility=${asset.visibility}) cannot bind to agent ${agentId}`,
        );
      }
    }
    await this.store.setAgentFixedAssets(agentId, bindings);
  }

  /**
   * Append one agent binding (keeping existing bindings). Used for incremental scenarios such as automatically registering chat_memory assets
   * ; unlike the full replace of setAgentFixedAssets.
   *
   * Validation: agent / asset must both be in the current instance; canBindAsset must pass.
   * Idempotent: the store layer relies on the (agent_id, asset_id) unique constraint; repeated calls have no side effects.
   */
  async addAgentFixedAsset(agentId: string, b: FixedAssetBindingInput): Promise<void> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const asset = await this.getAssetById(b.asset_id);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${b.asset_id}`);
    if (!canBindAsset(agent, asset)) {
      throw new MetadataError(
        "asset_not_bindable",
        `asset ${b.asset_id} (visibility=${asset.visibility}) cannot bind to agent ${agentId}`,
      );
    }
    await this.store.addAgentFixedAsset(agentId, b);
  }

  /**
   * Idempotently ensure the chat_memory asset for (team, agent) exists and is bound to the agent.
   *
   * On the first call it synchronously completes three things (strict order):
   *   1. createAsset({asset_type:'chat_memory', visibility:'private',
   *      owner_user_id: agent.owner_user_id})
   *   2. store.addAgentFixedAsset(agent, {asset_id, injection_mode:'summary'})
   *   3. Write to the in-process LRU cache; later requests for the same (team, agent) short-circuit directly
   *
   * Idempotency guarantees:
   *   - asset_id = chat_memory-{team}-{agent} is stable and deterministic
   *   - meta_assets.asset_id is the primary key → on a concurrent create conflict, read back
   *   - meta_agent_fixed_assets (agent_id, asset_id) is unique → repeated
   *     addAgentFixedAsset is absorbed into a no-op by the store layer
   *
   * Failure policy: this method **throws** (agent_not_found / team_mismatch / DB failure).
   * The caller (handleConversationAdd in v2-router) is responsible for catch + only logging a warn,
   * without blocking the main conversation write flow.
   */
  async ensureChatMemoryAsset(params: {
    team_id: string;
    agent_id: string;
  }): Promise<AssetEntity> {
    const assetId = buildChatMemoryAssetId(params.team_id, params.agent_id);

    // 1. Cache short-circuit: already confirmed to exist, return a lightweight placeholder directly (only go back to the store if the caller needs the entity)
    //    In practice callers do not consume the return value (fire-and-forget), so on a cache hit the store is not queried.
    if (this.ensuredChatMemoryAssets.has(assetId)) {
      const cached = await this.getAssetById(assetId);
      if (cached) return cached;
      // The cache is stale (deleted externally) -- clear it and start over
      this.ensuredChatMemoryAssets.delete(assetId);
    }

    // 2. Get the agent, take owner + team for create + canBindAsset
    //    Fetching the agent first is so that team_mismatch can be validated on every path, and the subsequent bind
    //    needs owner_user_id as created_by.
    const agent = await this.getAgentById(params.agent_id);
    if (!agent) {
      throw new MetadataError(
        "agent_not_found",
        `cannot ensure chat_memory asset: agent ${params.agent_id} not found`,
      );
    }
    if (agent.team_id !== params.team_id) {
      throw new MetadataError(
        "team_mismatch",
        `cannot ensure chat_memory asset: agent ${params.agent_id} belongs to team ` +
        `${agent.team_id}, not ${params.team_id}`,
      );
    }

    // 3. Get or create the asset: first check whether it is already in the store (cold start / already created by another pod), otherwise create it.
    //    A primary key conflict on createAsset = a concurrent race, read back as a safety net.
    let asset = await this.getAssetById(assetId);
    if (!asset) {
      try {
        asset = await this.createAsset({
          asset_id: assetId,
          team_id: params.team_id,
          asset_type: "chat_memory",
          name: `Memory of ${agent.name}`,
          owner_user_id: agent.owner_user_id,
          source_type: "auto",
          visibility: "private",
          status: "active",
        });
      } catch (err) {
        const raced = await this.getAssetById(assetId);
        if (raced) {
          asset = raced;
        } else {
          throw err;
        }
      }
    }

    // 4. Whether the asset is newly created or already existed, **idempotently** add the binding once more.
    //    The previous attempt may have completed only create and failed at the bind stage; bind has a UNIQUE constraint, so repeated
    //    calls have no side effects. Here we call the store directly, skipping the repeated validation of addAgentFixedAsset
    //    -- we already checked agent / asset above.
    await this.store.addAgentFixedAsset(params.agent_id, {
      asset_id: assetId,
      asset_type: "chat_memory",
      injection_mode: "summary",
      priority: 50,
      created_by: agent.owner_user_id,
    });

    this.rememberEnsuredChatMemoryAsset(assetId);
    return asset;
  }

  /** LRU-ish bookkeeping: evict the earliest-written entry when the limit is reached. */
  private rememberEnsuredChatMemoryAsset(assetId: string): void {
    if (this.ensuredChatMemoryAssets.has(assetId)) return;
    if (this.ensuredChatMemoryAssets.size >= MetadataService.CHAT_MEMORY_ENSURE_CACHE_SIZE) {
      const oldest = this.ensuredChatMemoryAssets.keys().next().value;
      if (oldest !== undefined) this.ensuredChatMemoryAssets.delete(oldest);
    }
    this.ensuredChatMemoryAssets.set(assetId, true);
  }

  //  ============================================================
  //  Skill Asset — same ensure pattern
  //  ============================================================

  /**
   * Register a skill asset and bind it to the agent. Same 5-step structure as ensureChatMemoryAsset:
   *
   *   1. LRU short-circuit (key = skill_id, i.e. asset_id)
   *   2. Look up the agent to get owner + validate team
   *   3. Idempotent createAsset (asset_id = skill_id)
   *   4. Idempotent addAgentFixedAsset (injection_mode = reference)
   *   5. Record into the LRU
   *
   * Idempotency guarantees:
   *   - asset_id is the external skill_id (generated by the core layer as skl-xxxx), stable and unique
   *   - meta_assets.asset_id primary key → read back on a concurrent create conflict
   *   - meta_agent_fixed_assets (agent_id, asset_id) UNIQUE → bind is idempotent
   *
   * Failure policy:
   *   - v1 creation path (onSkillCreated context): throw to abort create,
   *     avoiding the non-self-healing state "skill is persisted but the frontend cannot see it"
   *   - read-time self-healing path (onSkillAccessed context): the caller does try/catch,
   *     without affecting the skill return
   */
  async ensureSkillAsset(params: {
    skill_id: string;
    team_id: string;
    agent_id: string;
    name: string;
  }): Promise<AssetEntity> {
    const assetId = params.skill_id; // skill_id === asset_id (convention)

    // 1. LRU short-circuit
    if (this.ensuredSkillAssets.has(assetId)) {
      const cached = await this.getAssetById(assetId);
      if (cached) return cached;
      this.ensuredSkillAssets.delete(assetId);
    }

    // 2. Get the agent to take the owner + validate team
    const agent = await this.getAgentById(params.agent_id);
    if (!agent) {
      throw new MetadataError(
        "agent_not_found",
        `cannot ensure skill asset: agent ${params.agent_id} not found`,
      );
    }
    if (agent.team_id !== params.team_id) {
      throw new MetadataError(
        "team_mismatch",
        `cannot ensure skill asset: agent ${params.agent_id} belongs to team ` +
        `${agent.team_id}, not ${params.team_id}`,
      );
    }

    // 3. Idempotent createAsset
    //
    // Default visibility = "private" (changed 2026-07):
    //   - A newly created skill is by default visible only to the owner and team admins (strictly private).
    //   - To let everyone in the team read it → the user explicitly switches it to "shared" on the control page (asset/update visibility=team).
    //   - To let specific users/agents read it → use acl/grant + visibility=restricted.
    //
    // Why not "team": Skill content often contains internal knowledge, scripts, credential notes, etc.,
    // and "visible to the whole team by default" is not safe enough for privacy-sensitive scenarios (e.g. a skill for personal debugging).
    // The mental model of private → actively share is more intuitive.
    let asset = await this.getAssetById(assetId);
    if (!asset) {
      try {
        asset = await this.createAsset({
          asset_id: assetId,
          team_id: params.team_id,
          asset_type: "skill",
          name: params.name,
          owner_user_id: agent.owner_user_id,
          source_type: "extracted",
          visibility: "private",
          status: "active",
        });
      } catch (err) {
        const raced = await this.getAssetById(assetId);
        if (raced) {
          asset = raced;
        } else {
          throw err;
        }
      }
    }

    // 4. Idempotent addAgentFixedAsset
    await this.store.addAgentFixedAsset(params.agent_id, {
      asset_id: assetId,
      asset_type: "skill",
      injection_mode: "reference",
      priority: 50,
      created_by: agent.owner_user_id,
    });

    this.rememberEnsuredSkillAsset(assetId);
    return asset;
  }

  /** LRU-ish bookkeeping: evict the earliest-written entry when the limit is reached. */
  private rememberEnsuredSkillAsset(assetId: string): void {
    if (this.ensuredSkillAssets.has(assetId)) return;
    if (this.ensuredSkillAssets.size >= MetadataService.SKILL_ENSURE_CACHE_SIZE) {
      const oldest = this.ensuredSkillAssets.keys().next().value;
      if (oldest !== undefined) this.ensuredSkillAssets.delete(oldest);
    }
    this.ensuredSkillAssets.set(assetId, true);
  }

  async listAgentFixedAssetsWithDetail(
    params: ListWithDetailParams,
  ): Promise<AgentFixedAssetDetailResult> {
    const agent = await this.getAgentById(params.agent_id);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${params.agent_id}`);

    const pagination = this.pag(params);
    const assetTypes = params.asset_types && params.asset_types.length > 0
      ? params.asset_types
      : undefined;
    const bindingPage = await this.store.listAgentFixedAssets(params.agent_id, pagination, { assetTypes });
    const items: AgentAssetView[] = [];

    for (const b of bindingPage.items) {
      const asset = await this.getAssetById(b.asset_id);
      if (!asset) continue;

      if (FILTERED_STATUSES.includes(asset.status)) continue;

      if (params.apply_visibility_filter && !canBindAsset(agent, asset)) continue;

      if (params.touch_usage) {
        await this.store.touchAssetUsage(asset.asset_id);
      }

      items.push({
        asset_id: asset.asset_id,
        asset_type: asset.asset_type,
        name: asset.name,
        description: asset.description ?? null,
        status: asset.status,
        visibility: asset.visibility,
        injection_mode: b.injection_mode,
        priority: b.priority,
        created_at: asset.created_at,
      });
    }

    return {
      agent: {
        agent_id: agent.agent_id,
        team_id: agent.team_id,
        owner_user_id: agent.owner_user_id,
        prompt: agent.prompt ?? null,
        visibility: agent.visibility,
        status: agent.status,
      },
      items,
      total: bindingPage.total,
      limit: pagination.limit,
      offset: pagination.offset,
    };
  }

  // ============================================================
  // ACL
  // ============================================================
  async grantAcl(input: GrantAclInput): Promise<AclEntity> {
    const asset = await this.getAssetById(input.asset_id);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${input.asset_id}`);
    return this.store.grantAcl(input);
  }

  async revokeAcl(id: string): Promise<void> {
    await this.store.revokeAcl(id);
  }

  async listAclByAsset(assetId: string, pagination: PaginationParams = DEFAULT_PAGINATION): Promise<PaginatedResult<AclEntity>> {
    const page = await this.store.listAclByAsset(assetId, pagination);
    return formatListResult(page, pagination);
  }

  // ============================================================
  // Permission decision (lazily load ACL)
  // ============================================================
  async checkAssetPermission(params: CheckPermissionParams): Promise<PermCheckResult> {
    const userId = await resolveUserId(this, params);
    const asset = await this.getAssetById(params.asset_id);
    if (!asset || asset.status === "archived") {
      return { allowed: false, reason: "asset_not_available" };
    }

    // owner short-circuit, no need to look up members/ACL
    if (asset.owner_user_id === userId) {
      return { allowed: true, reason: "owner" };
    }

    const membership = await this.store.getTeamMember(asset.team_id, userId);

    // First run with an empty ACL: a role-default hit is allowed directly, no table lookup needed
    const action = params.action;
    const fast = checkPermission({
      user: { user_id: userId },
      asset,
      membership,
      action,
      aclRecords: [],
      agentId: params.agent_id,
      logger: this.logger,
    });
    if (fast.allowed) return fast;

    // Only "passed the preconditions but not covered by role defaults" (no_permission) needs lazy ACL loading and re-decision
    if (fast.reason !== "no_permission") return fast;
    if (membership && roleDefaultCovers(membership.role, action)) return fast;

    const aclRecords = await this.allAclRecords(params.asset_id);
    return checkPermission({
      user: { user_id: userId },
      asset,
      membership,
      action,
      aclRecords,
      agentId: params.agent_id,
      logger: this.logger,
    });
  }

  /** Filter the asset list by the permissions the user has (offset pagination after permission aggregation). */
  async listAccessibleAssets(params: ListAccessibleAssetsParams): Promise<PaginatedResult<AssetEntity>> {
    const userId = await resolveUserId(this, params);
    const action = params.action ?? "read";
    const pagination = this.pag(params);

    // visibility allowlist (server-side filtering, to avoid the frontend receiving data it should not see)
    const visFilter: Set<AssetEntity["visibility"]> | null = params.visibility
      ? new Set(Array.isArray(params.visibility) ? params.visibility : [params.visibility])
      : null;

    let teamIds: string[];
    if (params.team_id) {
      const member = await this.store.getTeamMember(params.team_id, userId);
      if (!member || member.status !== "active") {
        return paginateArray([], pagination);
      }
      teamIds = [params.team_id];
    } else {
      const allTeams: TeamEntity[] = [];
      let offset = 0;
      const limit = 100;
      while (true) {
        const page = await this.store.listTeamsByUser(userId, { limit, offset });
        allTeams.push(...page.items);
        if (offset + page.items.length >= page.total) break;
        offset += limit;
      }
      teamIds = allTeams.map((t) => t.team_id);
    }

    const result: AssetEntity[] = [];
    const seen = new Set<string>();

    for (const teamId of teamIds) {
      let offset = 0;
      const limit = 100;
      while (true) {
        const page = await this.store.listAssetsByTeam(
          teamId,
          { limit, offset },
          { asset_type: params.asset_type },
        );
        for (const asset of page.items) {
          if (seen.has(asset.asset_id)) continue;
          if (FILTERED_STATUSES.includes(asset.status)) continue;
          // visibility allowlist filtering (remove before the permission decision, saving the cost of checkAssetPermission)
          if (visFilter && !visFilter.has(asset.visibility)) continue;
          const perm = await this.checkAssetPermission({
            user_id: userId,
            asset_id: asset.asset_id,
            action,
            agent_id: params.agent_id,
          });
          if (perm.allowed) {
            seen.add(asset.asset_id);
            result.push(asset);
          }
        }
        if (offset + page.items.length >= page.total) break;
        offset += limit;
      }
    }

    result.sort((a, b) => b.created_at.localeCompare(a.created_at));
    return paginateArray(result, pagination);
  }

  // ============================================================
  // Helpers
  // ============================================================
  private async assertTeamExists(teamId: string): Promise<void> {
    const team = await this.store.getTeamById(teamId);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
  }

  private requireCallerId(ctx: V3AuthContext): string {
    if (!ctx.userId) {
      throw new MetadataError("permission_denied", "authentication required");
    }
    return ctx.userId;
  }

  private assertCallerIsResourceOwner(ctx: V3AuthContext, ownerUserId: string): void {
    const callerId = this.requireCallerId(ctx);
    if (callerId !== ownerUserId) {
      throw new MetadataError("permission_denied", "caller is not resource owner");
    }
  }

  private async requireActiveTeamMember(ctx: V3AuthContext, teamId: string): Promise<TeamMemberEntity> {
    const callerId = this.requireCallerId(ctx);
    const member = await this.store.getTeamMember(teamId, callerId);
    if (!member || member.status !== "active") {
      throw new MetadataError("permission_denied", "not a team member");
    }
    return member;
  }

  private async assertCallerIsTeamAdmin(ctx: V3AuthContext, teamId: string): Promise<void> {
    const member = await this.requireActiveTeamMember(ctx, teamId);
    if (member.role !== "admin") {
      throw new MetadataError("permission_denied", "caller is not team admin");
    }
  }

  private async assertCallerIsTeamOwnerOrAdmin(ctx: V3AuthContext, teamId: string): Promise<TeamEntity> {
    const callerId = this.requireCallerId(ctx);
    const team = await this.getTeamById(teamId);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    if (team.owner_user_id === callerId) return team;
    await this.assertCallerIsTeamAdmin(ctx, teamId);
    return team;
  }

  private async assertCallerIsAgentOwner(ctx: V3AuthContext, agentId: string): Promise<AgentEntity> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    this.assertCallerIsResourceOwner(ctx, agent.owner_user_id);
    return agent;
  }

  /**
   * Permission for agent fixed-asset write operations: the owner themselves, or a team admin of the team the agent belongs to.
   * Used for scenarios such as cold-start "admin mounts default Agent assets on behalf of a new user" (following the precedent of the asset
   * assertCallerIsAssetOwnerOrTeamAdmin, letting team admins through).
   */
  private async assertCallerIsAgentOwnerOrTeamAdmin(ctx: V3AuthContext, agentId: string): Promise<AgentEntity> {
    const agent = await this.getAgentById(agentId);
    if (!agent) throw new MetadataError("agent_not_found", `agent not found: ${agentId}`);
    const callerId = this.requireCallerId(ctx);
    if (agent.owner_user_id === callerId) return agent;
    await this.assertCallerIsTeamAdmin(ctx, agent.team_id);
    return agent;
  }

  private async assertCallerIsTaskCreator(ctx: V3AuthContext, taskId: string): Promise<TaskEntity> {
    const task = await this.getTaskById(taskId);
    if (!task) throw new MetadataError("task_not_found", `task not found: ${taskId}`);
    this.assertCallerIsResourceOwner(ctx, task.creator_user_id);
    return task;
  }

  private async assertCallerIsAssetOwner(ctx: V3AuthContext, assetId: string): Promise<AssetEntity> {
    const asset = await this.getAssetById(assetId);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    this.assertCallerIsResourceOwner(ctx, asset.owner_user_id);
    return asset;
  }

  private async assertCallerIsAssetOwnerOrTeamAdmin(ctx: V3AuthContext, assetId: string): Promise<AssetEntity> {
    const asset = await this.getAssetById(assetId);
    if (!asset) throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
    const callerId = this.requireCallerId(ctx);
    if (asset.owner_user_id === callerId) return asset;
    await this.assertCallerIsTeamAdmin(ctx, asset.team_id);
    return asset;
  }

  // ============================================================
  // Caller-scoped mutations (L-12 / L-14)
  // ============================================================
  async createTeamForCaller(input: CreateTeamInput, ctx: V3AuthContext): Promise<TeamEntity> {
    this.assertCallerIsResourceOwner(ctx, input.owner_user_id);
    return this.createTeam(input);
  }

  async updateTeamForCaller(
    teamId: string,
    patch: Partial<TeamEntity>,
    ctx: V3AuthContext,
  ): Promise<TeamEntity> {
    await this.assertCallerIsTeamOwnerOrAdmin(ctx, teamId);
    return this.updateTeam(teamId, patch);
  }

  async deleteTeamsForCaller(teamIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    for (const teamId of teamIds) {
      await this.assertCallerIsTeamOwnerOrAdmin(ctx, teamId);
    }
    return this.deleteTeams(teamIds);
  }

  async addTeamMemberForCaller(input: AddTeamMemberInput, ctx: V3AuthContext): Promise<TeamMemberEntity> {
    await this.assertCallerIsTeamAdmin(ctx, input.team_id);
    const callerId = this.requireCallerId(ctx);
    // "Add member" should not be used to change one's own role; selecting oneself + role=member would downgrade the admin.
    if (input.user_id === callerId) {
      throw new MetadataError("permission_denied", "cannot add yourself as a team member");
    }
    return this.addTeamMember(input);
  }

  async removeTeamMemberForCaller(teamId: string, userId: string, ctx: V3AuthContext): Promise<void> {
    await this.assertCallerIsTeamAdmin(ctx, teamId);
    const team = await this.getTeamById(teamId);
    if (!team) throw new MetadataError("team_not_found", `team not found: ${teamId}`);
    if (userId === team.owner_user_id) {
      throw new MetadataError("permission_denied", "cannot remove team owner");
    }
    return this.removeTeamMember(teamId, userId);
  }

  async listTeamMembersForCaller(
    teamId: string,
    ctx: V3AuthContext,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<TeamMemberView>> {
    await this.requireActiveTeamMember(ctx, teamId);
    const page = await this.store.listTeamMembersWithProfile(teamId, pagination);
    return formatListResult(page, pagination);
  }

  async getTeamMemberForCaller(
    teamId: string,
    userId: string,
    ctx: V3AuthContext,
  ): Promise<TeamMemberView> {
    await this.requireActiveTeamMember(ctx, teamId);
    const member = await this.store.getTeamMemberWithProfile(teamId, userId);
    if (!member) {
      throw new MetadataError("member_not_found", `member not found: ${teamId}/${userId}`);
    }
    return member;
  }

  async createAgentForCaller(input: CreateAgentInput, ctx: V3AuthContext): Promise<AgentEntity> {
    await this.assertTeamExists(input.team_id);
    await this.requireActiveTeamMember(ctx, input.team_id);
    // The owner themselves, or a team admin of that team (admin creates the default Agent on behalf of a new user)
    const callerId = this.requireCallerId(ctx);
    if (input.owner_user_id !== callerId) {
      await this.assertCallerIsTeamAdmin(ctx, input.team_id);
    }
    return this.createAgent(input);
  }

  async updateAgentForCaller(
    agentId: string,
    patch: Partial<AgentEntity>,
    ctx: V3AuthContext,
  ): Promise<AgentEntity> {
    await this.assertCallerIsAgentOwner(ctx, agentId);
    return this.updateAgent(agentId, patch);
  }

  async deleteAgentsForCaller(agentIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    for (const agentId of agentIds) {
      await this.assertCallerIsAgentOwner(ctx, agentId);
    }
    return this.deleteAgents(agentIds);
  }

  async archiveAgentForCaller(agentId: string, ctx: V3AuthContext): Promise<AgentEntity> {
    await this.assertCallerIsAgentOwner(ctx, agentId);
    return this.archiveAgent(agentId);
  }

  async createTaskForCaller(input: CreateTaskInput, ctx: V3AuthContext): Promise<TaskEntity> {
    await this.assertTeamExists(input.team_id);
    await this.requireActiveTeamMember(ctx, input.team_id);
    this.assertCallerIsResourceOwner(ctx, input.creator_user_id);
    return this.createTask(input);
  }

  async updateTaskForCaller(
    taskId: string,
    patch: Partial<TaskEntity>,
    ctx: V3AuthContext,
  ): Promise<TaskEntity> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.updateTask(taskId, patch);
  }

  async deleteTasksForCaller(taskIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    for (const taskId of taskIds) {
      await this.assertCallerIsTaskCreator(ctx, taskId);
    }
    return this.deleteTasks(taskIds);
  }

  async archiveTaskForCaller(taskId: string, ctx: V3AuthContext): Promise<TaskEntity> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.archiveTask(taskId);
  }

  /**
   * External-source import gate: team exists + caller is an active member of that team.
   *
   * Called by the task-source module (import-service cannot access this class's private gates).
   * Same semantics as the first two steps of createTaskForCaller, only the "resource owner" step is left to
   * createTaskForCaller itself (the creator is always the caller).
   */
  async assertExternalTaskImportAllowed(teamId: string, ctx: V3AuthContext): Promise<void> {
    await this.assertTeamExists(teamId);
    await this.requireActiveTeamMember(ctx, teamId);
  }

  async linkTaskAgentForCaller(
    taskId: string,
    agentId: string,
    roleInTask: string | undefined,
    ctx: V3AuthContext,
  ): Promise<TaskAgentEntity> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.linkTaskAgent(taskId, agentId, roleInTask);
  }

  async unlinkTaskAgentForCaller(taskId: string, agentId: string, ctx: V3AuthContext): Promise<void> {
    await this.assertCallerIsTaskCreator(ctx, taskId);
    return this.unlinkTaskAgent(taskId, agentId);
  }

  async appendParticipationLogForCaller(
    input: AppendParticipationLogInput,
    ctx: V3AuthContext,
  ): Promise<ParticipationLogEntity> {
    await this.requireActiveTeamMember(ctx, input.team_id);
    const callerId = this.requireCallerId(ctx);
    if (input.user_id !== callerId) {
      await this.assertCallerIsTeamAdmin(ctx, input.team_id);
    }
    return this.appendParticipationLog(input);
  }

  async listParticipationLogsForCaller(
    filter: ParticipationLogFilter,
    ctx: V3AuthContext,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<ParticipationLogEntity>> {
    await this.requireActiveTeamMember(ctx, filter.team_id);
    return this.listParticipationLogs(filter, pagination);
  }

  async createAssetForCaller(input: CreateAssetInput, ctx: V3AuthContext): Promise<AssetEntity> {
    await this.assertTeamExists(input.team_id);
    await this.requireActiveTeamMember(ctx, input.team_id);
    this.assertCallerIsResourceOwner(ctx, input.owner_user_id);
    return this.createAsset(input);
  }

  async updateAssetForCaller(
    assetId: string,
    patch: Partial<AssetEntity>,
    ctx: V3AuthContext,
  ): Promise<AssetEntity> {
    await this.assertCallerIsAssetOwner(ctx, assetId);
    return this.updateAsset(assetId, patch);
  }

  async deleteAssetsForCaller(assetIds: string[], ctx: V3AuthContext): Promise<BatchDeleteResult> {
    // Ids that no longer exist skip the owner check (aligned with the store layer's idempotent success); those that still exist must be owned.
    for (const assetId of assetIds) {
      const existing = await this.getAssetById(assetId);
      if (!existing) continue;
      await this.assertCallerIsAssetOwner(ctx, assetId);
    }
    return this.deleteAssets(assetIds);
  }

  async touchAssetUsageForCaller(assetId: string, ctx: V3AuthContext): Promise<void> {
    await this.assertCallerIsAssetOwner(ctx, assetId);
    return this.touchAssetUsage(assetId);
  }

  /**
   * Batch pre-resolution for `/v3/chat-memory/clear`: maps asset_id to (team, agent).
   *
   * Semantics (aligned with the requirement "if any memory_id is invalid, reject the whole batch"):
   *   - each id must exist and have asset_type === "chat_memory";
   *   - the corresponding agent must be locatable under the asset's team;
   *   - if any one fails, throw MetadataError directly and the whole batch is not executed.
   *
   * **No user-level Owner check**: the trust model of the kernel data plane is that Bearer +
   * x-tdai-service-id is an admin-level credential (consistent with the L0–L3 delete endpoints).
   * "Only the asset Owner can operate" is done by the panel backend before forwarding.
   *
   * Only validates and reads, **does not modify any asset fields** -- clearing only deletes content and does not touch the asset.
   */
  async resolveChatMemoryTargets(
    assetIds: string[],
  ): Promise<Array<{ asset_id: string; team_id: string; agent_id: string }>> {
    const targets: Array<{ asset_id: string; team_id: string; agent_id: string }> = [];
    // The agent list of the same team is reused repeatedly in batch scenarios, so cache it once per team.
    const agentIdsByTeam = new Map<string, string[]>();

    for (const assetId of assetIds) {
      const asset = await this.getAssetById(assetId);
      if (!asset) {
        throw new MetadataError("asset_not_found", `asset not found: ${assetId}`);
      }
      if (asset.asset_type !== "chat_memory") {
        throw new MetadataError(
          "asset_type_mismatch",
          `asset ${assetId} is not a chat_memory asset (got ${asset.asset_type})`,
        );
      }

      let agentIds = agentIdsByTeam.get(asset.team_id);
      if (!agentIds) {
        agentIds = await this.listAllAgentIdsByTeam(asset.team_id);
        agentIdsByTeam.set(asset.team_id, agentIds);
      }

      const agentId = resolveChatMemoryAgentId(assetId, asset.team_id, agentIds);
      if (!agentId) {
        throw new MetadataError(
          "agent_not_found",
          `cannot resolve owning agent for chat_memory asset ${assetId} in team ${asset.team_id}`,
        );
      }
      targets.push({ asset_id: assetId, team_id: asset.team_id, agent_id: agentId });
    }
    return targets;
  }

  /**
   * Fetch all agent_ids under a team (paginated traversal, up to 100 per page).
   * A hard upper limit is added to prevent an abnormally large team from filling up memory.
   */
  private async listAllAgentIdsByTeam(teamId: string): Promise<string[]> {
    const PAGE = 100;
    const MAX_AGENTS = 10_000;
    const ids: string[] = [];
    for (let offset = 0; offset < MAX_AGENTS; offset += PAGE) {
      const page = await this.store.listAgentsByTeam(teamId, { limit: PAGE, offset });
      for (const agent of page.items) ids.push(agent.agent_id);
      if (page.items.length < PAGE) break;
    }
    return ids;
  }

  async setAgentFixedAssetsForCaller(
    agentId: string,
    bindings: FixedAssetBindingInput[],
    ctx: V3AuthContext,
  ): Promise<void> {
    await this.assertCallerIsAgentOwnerOrTeamAdmin(ctx, agentId);
    return this.setAgentFixedAssets(agentId, bindings);
  }

  async grantAclForCaller(input: GrantAclInput, ctx: V3AuthContext): Promise<AclEntity> {
    await this.assertCallerIsAssetOwner(ctx, input.asset_id);
    const callerId = this.requireCallerId(ctx);
    if (input.granted_by !== callerId) {
      throw new MetadataError("permission_denied", "granted_by must match caller");
    }
    return this.grantAcl(input);
  }

  async revokeAclForCaller(id: string, ctx: V3AuthContext): Promise<void> {
    const acl = await this.store.getAclById(id);
    if (!acl) throw new MetadataError("acl_not_found", `acl not found: ${id}`);
    await this.assertCallerIsAssetOwner(ctx, acl.asset_id);
    return this.revokeAcl(id);
  }

  async listAclByAssetForCaller(
    assetId: string,
    ctx: V3AuthContext,
    pagination: PaginationParams = DEFAULT_PAGINATION,
  ): Promise<PaginatedResult<AclEntity>> {
    await this.assertCallerIsAssetOwnerOrTeamAdmin(ctx, assetId);
    return this.listAclByAsset(assetId, pagination);
  }

  // ── InstanceUpstreamConfig (v2 model group) ─────────────────────────────────
  //
  // Corresponds to design doc §6.B (groups/*) + §6.C (extraction/*) + §6.D (internal/list).
  // Service layer responsibilities:
  //   1. Application-layer field-level validation (name length / mode validity / immutable fields of the default group, etc.)
  //   2. Translate the InstanceUpstreamWriteConflictError thrown by the store into MetadataError
  //   3. Two list paths, Public/Internal: public is sanitized (api_key_masked),
  //      Internal is plaintext (for Proxy forwarding)
  //   4. Relies on the caller (router layer) to provide the supported-agents array for seed and agents validation;
  //      the service itself does not know yaml/config exists
  //
  // Validation matrix (§5.3):
  //   default: name fixed / mode='official' / base_url/api_key/model_id/description must be empty;
  //            agents may be 0~N, update allowed
  //   custom:  name non-empty ≤64; agents ≥1; mode ∈ {custom_unified,custom_passthrough};
  //            base_url non-empty; api_key non-empty when custom_unified
  //   extraction: agents=[]; mode='custom_unified'; base_url + api_key both required

  private static readonly NAME_MAX_LEN = 64;
  // Aligned with §5.3 "allow Chinese/English letters, digits, spaces and _-.()"; forbid newlines/quotes/angle brackets/slashes
  private static readonly NAME_INVALID_RE = /[\n\r"'<>\/\\]/;

  /**
   * Idempotently ensure default has been seeded. Router layer uses it for purely read-only endpoints (supported-agents / extraction/get),
   * and to avoid exposing the store reference by bypassing the store, a thin forwarding layer is added in the service.
   */
  async ensureDefaultSeeded(supportedAgents: SupportedAgent[]): Promise<void> {
    await this.store.ensureDefaultSeeded(supportedAgents);
  }

  /**
   * List all groups (default + custom), for Panel B1.
   * Seed semantics: when supportedAgents is non-empty, if the table has no default, automatically seed one row.
   */
  async listInstanceUpstreamGroups(
    supportedAgents: SupportedAgent[],
  ): Promise<{ items: Record<string, unknown>[] }> {
    const rows = await this.store.listInstanceUpstreamGroups(undefined, supportedAgents);
    // Only return default + custom (extraction goes through the C-class endpoints)
    const filtered = rows.filter((r) => r.group_type !== "extraction");
    return { items: filtered.map((r) => this.toPublicGroup(r)) };
  }

  /**
   * Internal D endpoint: Proxy pulls data, api_key in plaintext, all rows (including extraction).
   * Shares the seed logic with the Panel side (guaranteed by the store layer).
   */
  async listInstanceUpstreamGroupsInternal(
    supportedAgents: SupportedAgent[],
  ): Promise<{ items: InstanceUpstreamConfigEntity[] }> {
    const rows = await this.store.listInstanceUpstreamGroups(undefined, supportedAgents);
    return { items: rows };
  }

  /** Panel B2: create a new custom group. */
  async createInstanceUpstreamCustomGroup(
    input: {
      name: string;
      agents: string[];
      enabled?: boolean;
      mode: UpstreamMode;
      base_url: string;
      api_key?: string;
      model_id?: string;
      description?: string;
    },
    supportedAgents: SupportedAgent[],
  ): Promise<Record<string, unknown>> {
    this.assertGroupName(input.name);
    this.assertAgents(input.agents, supportedAgents, "custom");
    this.assertModeForGroupType("custom", input.mode);
    if (!input.base_url?.trim()) {
      throw new MetadataError("MISSING_BASE_URL", "base_url is required for custom group");
    }
    if (input.mode === "custom_unified" && !input.api_key?.trim()) {
      throw new MetadataError("MISSING_API_KEY", "api_key is required for custom_unified mode");
    }
    // The first request of an existing instance may not be list but a direct create; safety-net seed default
    // to prevent assertAgentsNotOverlap from seeing an empty table → INSERT custom → only 1 custom row
    // with no default → subsequent hermes requests hit AGENT_NOT_CONFIGURED (design §5.5 existing-instance safety net)
    await this.store.ensureDefaultSeeded(supportedAgents);
    try {
      const row = await this.store.createInstanceUpstreamGroup({
        group_type: "custom",
        name: input.name.trim(),
        agents: input.agents,
        enabled: input.enabled !== false,
        mode: input.mode,
        base_url: input.base_url.trim(),
        api_key: input.api_key ?? "",
        model_id: input.model_id ?? "",
        description: input.description ?? "",
      });
      return this.toPublicGroup(row);
    } catch (e) {
      throw this.translateUpstreamConflict(e);
    }
  }

  /** Panel B3: PATCH update a group (default or custom). */
  async updateInstanceUpstreamGroup(
    input: {
      group_id: string;
      group_type: GroupType;
      name?: string;
      agents?: string[];
      enabled?: boolean;
      mode?: UpstreamMode;
      base_url?: string;
      api_key?: string;
      model_id?: string;
      description?: string;
      expected_version?: number;
    },
    supportedAgents: SupportedAgent[],
  ): Promise<Record<string, unknown>> {
    if (input.group_type === "extraction") {
      throw new MetadataError("USE_EXTRACTION_ENDPOINT", "use /extraction/update for extraction row");
    }

    // Guard for immutable fields of the default group
    if (input.group_type === "default") {
      const rejected: string[] = [];
      if (input.name !== undefined) rejected.push("name");
      if (input.mode !== undefined) rejected.push("mode");
      if (input.base_url !== undefined) rejected.push("base_url");
      if (input.api_key !== undefined) rejected.push("api_key");
      if (input.model_id !== undefined) rejected.push("model_id");
      if (input.description !== undefined) rejected.push("description");
      if (rejected.length > 0) {
        throw new MetadataError(
          "DEFAULT_GROUP_IMMUTABLE_FIELDS",
          `default group only allows updating agents / enabled; rejected: ${rejected.join(",")}`,
          { rejected_fields: rejected },
        );
      }
    }

    // Validation of custom group fields (only validate when passed in)
    if (input.group_type === "custom") {
      if (input.name !== undefined) this.assertGroupName(input.name);
      if (input.agents !== undefined) this.assertAgents(input.agents, supportedAgents, "custom");
      if (input.mode !== undefined) this.assertModeForGroupType("custom", input.mode);
      if (input.base_url !== undefined && !input.base_url.trim()) {
        throw new MetadataError("MISSING_BASE_URL", "base_url must be non-empty");
      }
    }

    // Existing-instance safety-net seed (same as the create branch note)
    await this.store.ensureDefaultSeeded(supportedAgents);
    try {
      const row = await this.store.updateInstanceUpstreamGroup({
        group_id: input.group_id,
        expected_group_type: input.group_type,
        expected_version: input.expected_version,
        name: input.name?.trim(),
        agents: input.agents,
        enabled: input.enabled,
        mode: input.mode,
        base_url: input.base_url?.trim(),
        api_key: input.api_key,
        model_id: input.model_id,
        description: input.description,
      });
      return this.toPublicGroup(row);
    } catch (e) {
      throw this.translateUpstreamConflict(e);
    }
  }

  /** Panel B4: toggle the enabled field. */
  async toggleInstanceUpstreamGroup(
    input: {
      group_id: string;
      enabled: boolean;
      expected_version?: number;
    },
    supportedAgents: SupportedAgent[],
  ): Promise<Record<string, unknown>> {
    // Existing-instance safety-net seed (same as the create branch note)
    await this.store.ensureDefaultSeeded(supportedAgents);
    try {
      const row = await this.store.toggleInstanceUpstreamGroup(input);
      return { group_id: row.group_id, enabled: row.enabled, updated_at: row.updated_at };
    } catch (e) {
      const err = this.translateUpstreamConflict(e);
      // extraction uses C4 toggle; B4 receiving an extraction group_id means the wrong channel was taken
      if (err.code === "group_not_found") throw err;
      throw err;
    }
  }

  /** Panel B5: physically delete a custom group. */
  async deleteInstanceUpstreamGroup(
    input: { group_id: string },
    supportedAgents: SupportedAgent[],
  ): Promise<{ deleted: boolean; released_agents: string[] }> {
    // Existing-instance safety-net seed (same as the create branch note)
    await this.store.ensureDefaultSeeded(supportedAgents);
    const existing = await this.store.getInstanceUpstreamGroup(input.group_id);
    if (!existing) {
      throw new MetadataError("GROUP_NOT_FOUND", `group not found: ${input.group_id}`);
    }
    if (existing.group_type === "default") {
      throw new MetadataError(
        "CANNOT_DELETE_DEFAULT",
        "default group cannot be deleted; set agents:[] + enabled:false instead",
      );
    }
    if (existing.group_type === "extraction") {
      throw new MetadataError(
        "USE_EXTRACTION_ENDPOINT",
        "use /extraction/delete for extraction row",
      );
    }
    const ok = await this.store.deleteInstanceUpstreamGroup(input);
    return { deleted: ok, released_agents: existing.agents };
  }

  // ── Class C: extraction row ─────────────────────────────────────────────

  async getInstanceUpstreamExtraction(
    supportedAgents: SupportedAgent[],
  ): Promise<Record<string, unknown>> {
    // Seed even on read-only: if the user directly calls extraction/get and sees that default is not configured, they would mistakenly think
    // the instance really has no default, and manually "configuring default" would bypass the semantics of the official default model.
    // Every instance comes with a default, just lazily configured. Reading = ensuring a default exists.
    await this.store.ensureDefaultSeeded(supportedAgents);
    const rows = await this.store.listInstanceUpstreamGroups({ group_type: "extraction" });
    const ext = rows[0];
    if (!ext) return { configured: false, enabled: false };
    return {
      configured: true,
      enabled: ext.enabled,
      base_url: ext.base_url,
      api_key_masked: ext.api_key ? maskKeyValue(ext.api_key) : "",
      model_id: ext.model_id,
      description: ext.description,
      updated_at: ext.updated_at,
    };
  }

  async createInstanceUpstreamExtraction(
    input: {
      base_url: string;
      api_key: string;
      model_id?: string;
      enabled?: boolean;
      description?: string;
    },
    supportedAgents: SupportedAgent[],
  ): Promise<Record<string, unknown>> {
    if (!input.base_url?.trim()) {
      throw new MetadataError("MISSING_BASE_URL", "base_url is required for extraction");
    }
    if (!input.api_key?.trim()) {
      throw new MetadataError("MISSING_API_KEY", "api_key is required for extraction");
    }
    // Existing-instance safety-net seed: the Panel's first request may be a direct extraction/create, not going through list/groups
    await this.store.ensureDefaultSeeded(supportedAgents);
    try {
      const row = await this.store.createInstanceUpstreamGroup({
        group_type: "extraction",
        name: EXTRACTION_GROUP_NAME,
        agents: [],
        enabled: input.enabled !== false,
        mode: "custom_unified",
        base_url: input.base_url.trim(),
        api_key: input.api_key.trim(),
        model_id: input.model_id ?? "",
        description: input.description ?? "",
      });
      return this.toPublicExtraction(row);
    } catch (e) {
      const err = this.translateUpstreamConflict(e);
      if (err.code === "extraction_already_exists") {
        throw new MetadataError(
          "EXTRACTION_ALREADY_CONFIGURED",
          "extraction row already exists; use /extraction/update to modify",
        );
      }
      throw err;
    }
  }

  async updateInstanceUpstreamExtraction(
    input: {
      base_url?: string;
      api_key?: string;
      model_id?: string;
      enabled?: boolean;
      description?: string;
      expected_version?: number;
    },
    supportedAgents: SupportedAgent[],
  ): Promise<Record<string, unknown>> {
    if (input.api_key !== undefined && input.api_key.trim() === "") {
      // extraction must have a key; clearing must go through delete
      throw new MetadataError(
        "MISSING_API_KEY",
        "api_key cannot be cleared via update; use /extraction/delete instead",
      );
    }
    if (input.base_url !== undefined && !input.base_url.trim()) {
      throw new MetadataError("MISSING_BASE_URL", "base_url must be non-empty");
    }

    // Existing-instance safety-net seed
    await this.store.ensureDefaultSeeded(supportedAgents);
    const rows = await this.store.listInstanceUpstreamGroups({ group_type: "extraction" });
    const ext = rows[0];
    if (!ext) {
      throw new MetadataError(
        "EXTRACTION_NOT_CONFIGURED",
        "extraction row does not exist; use /extraction/create first",
      );
    }
    try {
      const row = await this.store.updateInstanceUpstreamGroup({
        group_id: ext.group_id,
        expected_group_type: "extraction",
        expected_version: input.expected_version,
        base_url: input.base_url?.trim(),
        api_key: input.api_key?.trim(),
        model_id: input.model_id,
        enabled: input.enabled,
        description: input.description,
      });
      return this.toPublicExtraction(row);
    } catch (e) {
      throw this.translateUpstreamConflict(e);
    }
  }

  async toggleInstanceUpstreamExtraction(
    input: {
      enabled: boolean;
      expected_version?: number;
    },
    supportedAgents: SupportedAgent[],
  ): Promise<Record<string, unknown>> {
    // Existing-instance safety-net seed
    await this.store.ensureDefaultSeeded(supportedAgents);
    const rows = await this.store.listInstanceUpstreamGroups({ group_type: "extraction" });
    const ext = rows[0];
    if (!ext) {
      throw new MetadataError(
        "EXTRACTION_NOT_CONFIGURED",
        "extraction row does not exist",
      );
    }
    try {
      const row = await this.store.toggleInstanceUpstreamGroup({
        group_id: ext.group_id,
        enabled: input.enabled,
        expected_version: input.expected_version,
      });
      return { enabled: row.enabled, updated_at: row.updated_at };
    } catch (e) {
      throw this.translateUpstreamConflict(e);
    }
  }

  async deleteInstanceUpstreamExtraction(
    supportedAgents: SupportedAgent[],
  ): Promise<{ deleted: boolean }> {
    // Existing-instance safety-net seed
    await this.store.ensureDefaultSeeded(supportedAgents);
    const rows = await this.store.listInstanceUpstreamGroups({ group_type: "extraction" });
    const ext = rows[0];
    if (!ext) return { deleted: true }; // idempotent: returns true even when absent
    const ok = await this.store.deleteInstanceUpstreamGroup({ group_id: ext.group_id });
    return { deleted: ok };
  }

  // ── Internal utilities ─────────────────────────────────────────────

  private assertGroupName(name: string): void {
    const trimmed = (name ?? "").trim();
    if (!trimmed) {
      throw new MetadataError("MISSING_GROUP_NAME", "group name is required");
    }
    if (trimmed.length > MetadataService.NAME_MAX_LEN) {
      throw new MetadataError(
        "MISSING_GROUP_NAME",
        `group name exceeds ${MetadataService.NAME_MAX_LEN} chars`,
      );
    }
    if (MetadataService.NAME_INVALID_RE.test(trimmed)) {
      throw new MetadataError(
        "MISSING_GROUP_NAME",
        "group name contains invalid characters (newline / quotes / angle brackets / slashes)",
      );
    }
  }

  private assertAgents(agents: string[], supported: SupportedAgent[], groupType: GroupType): void {
    if (groupType === "custom" && agents.length === 0) {
      throw new MetadataError("INVALID_AGENTS", "custom group must have at least 1 agent");
    }
    if (supported.length === 0) return; // skip the enumeration check when there is no supported list (only an extreme boot-time case)
    const supportedSet = new Set(supported.map((a) => a.agent_source));
    const unknown = agents.filter((a) => !supportedSet.has(a));
    if (unknown.length > 0) {
      throw new MetadataError(
        "INVALID_AGENTS",
        `unknown agents: ${unknown.join(",")}`,
        { unknown_agents: unknown },
      );
    }
  }

  private assertModeForGroupType(gt: GroupType, mode: UpstreamMode): void {
    if (gt === "custom" && mode === "official") {
      throw new MetadataError(
        "INVALID_MODE_FOR_GROUP_TYPE",
        "custom group cannot use official mode",
      );
    }
    if (gt === "default" && mode !== "official") {
      throw new MetadataError(
        "INVALID_MODE_FOR_GROUP_TYPE",
        "default group must use official mode",
      );
    }
    if (gt === "extraction" && mode !== "custom_unified") {
      throw new MetadataError(
        "INVALID_MODE_FOR_GROUP_TYPE",
        "extraction row must use custom_unified mode",
      );
    }
  }

  private toPublicGroup(row: InstanceUpstreamConfigEntity): Record<string, unknown> {
    return {
      group_id: row.group_id,
      group_type: row.group_type,
      name: row.name,
      agents: row.agents,
      enabled: row.enabled,
      mode: row.mode,
      base_url: row.base_url,
      api_key_masked: row.api_key ? maskKeyValue(row.api_key) : "",
      model_id: row.model_id,
      description: row.description,
      version: row.version,
      updated_at: row.updated_at,
    };
  }

  private toPublicExtraction(row: InstanceUpstreamConfigEntity): Record<string, unknown> {
    return {
      configured: true,
      enabled: row.enabled,
      base_url: row.base_url,
      api_key_masked: row.api_key ? maskKeyValue(row.api_key) : "",
      model_id: row.model_id,
      description: row.description,
      version: row.version,
      updated_at: row.updated_at,
    };
  }

  private translateUpstreamConflict(e: unknown): MetadataError {
    if (e instanceof InstanceUpstreamWriteConflictError) {
      const codeMap: Record<string, string> = {
        agents_overlap: "AGENTS_OVERLAP",
        name_duplicate: "DUPLICATE_GROUP_NAME",
        group_not_found: "GROUP_NOT_FOUND",
        group_type_mismatch: "GROUP_TYPE_MISMATCH",
        version_mismatch: "WRITE_CONFLICT",
        default_already_exists: "CANNOT_CREATE_DEFAULT",
        extraction_already_exists: "EXTRACTION_ALREADY_CONFIGURED",
      };
      const mapped = codeMap[e.reason] ?? e.reason;
      return new MetadataError(mapped, e.message, e.detail);
    }
    if (e instanceof MetadataError) return e;
    // Unknown error: wrap and throw
    return new MetadataError("internal_error", e instanceof Error ? e.message : String(e));
  }
}
