/**
 * IMetadataStore — metadata storage abstract interface.
 *
 * Corresponds to design doc §6.1. All backend implementations (SQLite / MongoDB / MySQL reserved) must satisfy this contract,
 * verified uniformly by the shared test suite in metadata-store.contract.ts to keep backend behavior consistent.
 *
 * Conventions:
 *   - All methods may be sync or async; callers always await.
 *   - Composite writes (createTeam + auto admin, createTask + linkAgents, setAgentFixedAssets full replace)
 *     must guarantee atomicity inside the implementation (SQLite serial transaction / MongoDB withTransaction).
 *   - get* returns null when not found; delete* returns BatchDeleteResult.
 */

import type {
  UserEntity,
  UserKeyEntity,
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
  AgentFixedAssetCountRow,
  AclEntity,
  CreateUserInput,
  CreateUserKeyInput,
  CreateTeamInput,
  AddTeamMemberInput,
  CreateAgentInput,
  CreateTaskInput,
  CreateAssetInput,
  FixedAssetBindingInput,
  GrantAclInput,
  AgentFilter,
  TaskFilter,
  TeamFilter,
  AssetFilter,
  BatchDeleteResult,
  ListPage,
  PaginationParams,
  InstanceUserListFilter,
  TeamRole,
  ConfigParamEntity,
  UpsertConfigParamInput,
  ListConfigParamsFilter,
  InstanceUpstreamConfigEntity,
  InstanceUpstreamConfigFilter,
  CreateInstanceUpstreamGroupInput,
  UpdateInstanceUpstreamGroupInput,
  ToggleInstanceUpstreamGroupInput,
  DeleteInstanceUpstreamGroupInput,
  SupportedAgent,
} from "../types.js";

export type MaybePromise<T> = T | Promise<T>;

/**
 * When the caller specifies default_key_value / key_value, it hits the meta_user_keys.key_value UNIQUE constraint.
 * The Service layer catches it and translates it to MetadataError("duplicate_user_key"); the HTTP layer maps it to 409.
 * The Store layer throws this error directly, independent of the business-layer MetadataError (avoiding a reverse dependency of storage on service).
 */
export class DuplicateUserKeyError extends Error {
  constructor(public readonly keyValue: string) {
    super(`user_key already exists: ${keyValue}`);
    this.name = "DuplicateUserKeyError";
  }
}

export interface IMetadataStore {
  /** Initialize storage (create tables/indexes/connections). Idempotent. */
  init(): MaybePromise<void>;
  /** Close the storage connection. */
  close(): MaybePromise<void>;

  // ── User ──
  createUser(input: CreateUserInput): MaybePromise<UserEntity>;
  getUserById(userId: string): MaybePromise<UserEntity | null>;
  getUserByKey(userKey: string): MaybePromise<UserEntity | null>;
  getUserByEmail(email: string): MaybePromise<UserEntity | null>;
  getUserByExternalId(authProvider: string, externalId: string): MaybePromise<UserEntity | null>;
  getUserByUsername(authProvider: string, username: string): MaybePromise<UserEntity | null>;
  updateUser(userId: string, patch: Partial<UserEntity>): MaybePromise<UserEntity | null>;
  deleteUsers(userIds: string[]): MaybePromise<BatchDeleteResult>;
  listUsersByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): MaybePromise<ListPage<UserEntity>>;
  listUsers(
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): MaybePromise<ListPage<UserEntity>>;
  countUsers(): MaybePromise<number>;
  countSystemAdmins(): MaybePromise<number>;
  countTeams(): MaybePromise<number>;

  // ── UserKey (multiple API keys) ──
  createUserKey(input: CreateUserKeyInput): MaybePromise<UserKeyEntity>;
  getUserKeyById(keyId: string): MaybePromise<UserKeyEntity | null>;
  listUserKeys(userId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<UserKeyEntity>>;
  countActiveUserKeys(userId: string): MaybePromise<number>;
  revokeUserKey(keyId: string, options?: { promoteNextDefault?: boolean }): MaybePromise<UserKeyEntity | null>;
  updateUserKey(keyId: string, patch: Partial<Pick<UserKeyEntity, "name" | "expires_at" | "is_default" | "metadata_json">>): MaybePromise<UserKeyEntity | null>;
  touchUserKeyUsage(keyId: string): MaybePromise<void>;
  revokeAllUserKeysForUser(userId: string): MaybePromise<void>;
  getDefaultUserKey(userId: string): MaybePromise<UserKeyEntity | null>;

  // ── Team ── (createTeam automatically adds the owner as an admin member)
  createTeam(input: CreateTeamInput): MaybePromise<TeamEntity>;
  getTeamById(teamId: string): MaybePromise<TeamEntity | null>;
  updateTeam(teamId: string, patch: Partial<TeamEntity>): MaybePromise<TeamEntity | null>;
  deleteTeams(teamIds: string[]): MaybePromise<BatchDeleteResult>;
  listTeamsByUser(userId: string, pagination?: PaginationParams | null, filter?: TeamFilter): MaybePromise<ListPage<TeamEntity>>;

  // ── TeamMember ──
  addTeamMember(input: AddTeamMemberInput): MaybePromise<TeamMemberEntity>;
  removeTeamMember(teamId: string, userId: string): MaybePromise<void>;
  listTeamMembers(teamId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<TeamMemberEntity>>;
  getTeamMember(teamId: string, userId: string): MaybePromise<TeamMemberEntity | null>;
  listTeamMembersWithProfile(
    teamId: string,
    pagination?: PaginationParams | null,
  ): MaybePromise<ListPage<TeamMemberView>>;
  getTeamMemberWithProfile(teamId: string, userId: string): MaybePromise<TeamMemberView | null>;

  // ── Agent ──
  createAgent(input: CreateAgentInput): MaybePromise<AgentEntity>;
  getAgentById(agentId: string): MaybePromise<AgentEntity | null>;
  updateAgent(agentId: string, patch: Partial<AgentEntity>): MaybePromise<AgentEntity | null>;
  deleteAgents(agentIds: string[]): MaybePromise<BatchDeleteResult>;
  listAgentsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AgentFilter): MaybePromise<ListPage<AgentEntity>>;
  listAgentsByOwner(userId: string, pagination?: PaginationParams | null, filter?: AgentFilter): MaybePromise<ListPage<AgentEntity>>;

  // ── Task ── (createTask can also linkAgents at the same time)
  createTask(input: CreateTaskInput): MaybePromise<TaskEntity>;
  getTaskById(taskId: string): MaybePromise<TaskEntity | null>;
  updateTask(taskId: string, patch: Partial<TaskEntity>): MaybePromise<TaskEntity | null>;
  deleteTasks(taskIds: string[]): MaybePromise<BatchDeleteResult>;
  listTasksByTeam(teamId: string, pagination?: PaginationParams | null, filter?: TaskFilter): MaybePromise<ListPage<TaskEntity>>;
  listTasks(filter: TaskFilter, pagination?: PaginationParams | null): MaybePromise<ListPage<TaskEntity>>;

  // ── TaskAgent ──
  linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): MaybePromise<TaskAgentEntity>;
  unlinkTaskAgent(taskId: string, agentId: string): MaybePromise<void>;
  listTaskAgents(taskId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<TaskAgentEntity>>;

  // ── ParticipationLog ──
  appendParticipationLog(input: AppendParticipationLogInput): MaybePromise<ParticipationLogEntity>;
  listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination?: PaginationParams | null,
  ): MaybePromise<ListPage<ParticipationLogEntity>>;

  // ── Asset ── (main table only; detail tables stay in the control panel)
  createAsset(input: CreateAssetInput): MaybePromise<AssetEntity>;
  getAssetById(assetId: string): MaybePromise<AssetEntity | null>;
  updateAsset(assetId: string, patch: Partial<AssetEntity>): MaybePromise<AssetEntity | null>;
  deleteAssets(assetIds: string[]): MaybePromise<BatchDeleteResult>;
  listAssetsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AssetFilter): MaybePromise<ListPage<AssetEntity>>;
  touchAssetUsage(assetId: string): MaybePromise<void>;

  // ── AgentFixedAsset ── (setAgentFixedAssets is a full replace)
  setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): MaybePromise<void>;
  /**
   * Append one agent binding, **preserving** the agent's other existing bindings; when (agent_id, asset_id)
   * already exists it is a no-op (idempotent).
   *
   * Scenario: when writing memory, automatically register the chat_memory asset and bind it to the agent, which must coexist with the
   * existing bindings of other assets such as skill / wiki / code_graph -- setAgentFixedAssets
   * is a full replace and would overwrite those bindings, so an append-semantics operation is needed.
   */
  addAgentFixedAsset(agentId: string, binding: FixedAssetBindingInput): MaybePromise<void>;
  listAgentFixedAssets(
    agentId: string,
    pagination?: PaginationParams | null,
    /**
     * Optional filter: only return bindings whose asset type is in the list. Empty/omitted = no filtering.
     * The store JOINs meta_assets internally for SQL-level filtering, avoiding truncation from "paginate first, filter by type after".
     */
    filter?: { assetTypes?: readonly string[] },
  ): MaybePromise<ListPage<FixedAssetBindingEntity>>;
  getAgentFixedAsset(agentId: string, assetId: string): MaybePromise<FixedAssetBindingEntity | null>;
  /**
   * Aggregate COUNT(DISTINCT asset_id) by agent_id + asset_type.
   * Does not fill in missing agents / missing types (the Service layer fills zeros).
   */
  summarizeAgentFixedAssetsByAgents(
    agentIds: string[],
    options?: { assetId?: string },
  ): MaybePromise<AgentFixedAssetCountRow[]>;

  // ── ACL ──
  grantAcl(input: GrantAclInput): MaybePromise<AclEntity>;
  getAclById(id: string): MaybePromise<AclEntity | null>;
  revokeAcl(id: string): MaybePromise<void>;
  listAclByAsset(assetId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<AclEntity>>;
  listAclBySubject(subjectType: string, subjectId: string, pagination?: PaginationParams | null): MaybePromise<ListPage<AclEntity>>;

  // ── ConfigParam ──
  getConfigParam(
    scope: "global" | "user",
    userId: string | null,
    module: string,
    paramName: string,
  ): MaybePromise<ConfigParamEntity | null>;
  upsertConfigParam(input: UpsertConfigParamInput): MaybePromise<ConfigParamEntity>;
  listConfigParams(filter: ListConfigParamsFilter): MaybePromise<ConfigParamEntity[]>;

  // ── InstanceUpstreamConfig (v2 model group) ──
  //
  // See docs/design/2026-08-25-instance-upstream-config.md §5 / §6 for the semantics.
  // Key constraints (the store layer must guarantee):
  //   1. group_id is generated by the store (dflt-<r> / grp-<r> / ext-<r>).
  //   2. default / extraction have at most 1 row per instance (UNIQUE partial index).
  //   3. agents are globally unique: within one instance, the elements of default.agents ∪ all custom.agents are pairwise distinct.
  //      On write, within a transaction SELECT-all → in-memory intersection check → write; a conflict throws
  //      InstanceUpstreamWriteConflictError("agents_overlap").
  //   4. version field optimistic lock: update / toggle pass expected_version; a mismatch throws
  //      InstanceUpstreamWriteConflictError("version_mismatch"). On the SQLite side
  //      BEGIN IMMEDIATE is also used as a transaction lock, for double protection.
  //   5. Idempotent seed: listGroups on an empty table triggers ensureDefaultSeeded; two concurrent writes
  //      are backstopped by the default singleton UNIQUE constraint.

  /** Get one row exactly by group_id (returns null if absent). */
  getInstanceUpstreamGroup(groupId: string): MaybePromise<InstanceUpstreamConfigEntity | null>;

  /**
   * List all rows of the instance (default + custom + extraction), sorted by group_type
   * (default first, custom next, extraction last), and within the same type by updated_at DESC.
   * Triggers ensureDefaultSeeded: if the table has 0 default rows and the passed supported-agents
   * is non-empty, automatically seed one default row (agents=supportedAgents, enabled=true).
   * Does not trigger seeding when undefined is passed.
   */
  listInstanceUpstreamGroups(
    filter?: InstanceUpstreamConfigFilter,
    seedIfEmpty?: SupportedAgent[],
  ): MaybePromise<InstanceUpstreamConfigEntity[]>;

  /**
   * Create a new group: custom / default (seed internal use only) / extraction.
   * Conflict scenarios:
   *   - default_already_exists / extraction_already_exists → throws InstanceUpstreamWriteConflictError
   *   - agents overlap with other rows → agents_overlap
   */
  createInstanceUpstreamGroup(
    input: CreateInstanceUpstreamGroupInput,
  ): MaybePromise<InstanceUpstreamConfigEntity>;

  /**
   * PATCH-update an existing group; conflict scenarios:
   *   - group_not_found / group_type_mismatch / version_mismatch / agents_overlap
   */
  updateInstanceUpstreamGroup(
    input: UpdateInstanceUpstreamGroupInput,
  ): MaybePromise<InstanceUpstreamConfigEntity>;

  /** Toggle enabled shortcut (syntactic sugar for update, also supports expected_version). */
  toggleInstanceUpstreamGroup(
    input: ToggleInstanceUpstreamGroupInput,
  ): MaybePromise<InstanceUpstreamConfigEntity>;

  /** Physical delete; returns false if absent. */
  deleteInstanceUpstreamGroup(
    input: DeleteInstanceUpstreamGroupInput,
  ): MaybePromise<boolean>;

  /**
   * Idempotently ensure the default row exists. A safety-net seed for existing instances whose first call is directly a
   * create/update/toggle/delete write endpoint -- instances that only went through list are seeded automatically, but the Panel may also enter
   * the "create custom" or extraction flow without going through list, and in that case, without a seed, subsequent
   * requests would hit AGENT_NOT_CONFIGURED.
   *
   * Semantics:
   *   - supported is empty → no-op (respecting the list-side convention "undefined does not seed")
   *   - a default already exists in the table → no-op
   *   - no default → INSERT one row (agents=supported, mode=official, enabled=true,
   *     snapshot=supported), exactly the same as the list-side seed branch
   *   - concurrent seed → relies on the UNIQUE partial index of the default row as a backstop
   *
   * No diff-append (the convergence of option E only runs on list, to avoid every write path refreshing the snapshot).
   */
  ensureDefaultSeeded(supported: SupportedAgent[]): MaybePromise<void>;
}

/** Backend type. */
export type MetadataBackend = "sqlite" | "mongodb" | "mysql";

export type { TeamRole };
