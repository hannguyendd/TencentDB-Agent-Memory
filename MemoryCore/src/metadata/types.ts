/**
 * Metadata module — Entity types & shared contracts.
 *
 * Corresponds to design doc 08-metadata-migration-and-permission-design.md §2 / §6.
 *
 * These are the metadata entity type definitions migrated from team-memory-control into the memory kernel.
 * Unlike the simplified entity_* types already in core/store, these are the full business models
 * (including user_key / password / visibility / acl, etc.).
 */

// ============================
// Enums and literal types
// ============================

export type UserStatus = "active" | "inactive" | "invited";
export type UserType = "normal" | "system_admin";
export type TeamStatus = "active" | "archived";
export type TeamRole = "admin" | "member" | "reviewer";
export type MemberStatus = "active" | "removed";
export type AgentStatus = "active" | "inactive";
export type TaskStatus = "running" | "completed";
/**
 * The **broad category** of a Task source, not encoding the specific source system.
 *
 * - `manual`: manually created by the user on the board.
 * - `external`: imported from a third-party requirements/task system. Which system it is
 *   (tapd / jira / ...) is always read from `metadata_json.external.provider`.
 * - `other`: anything else.
 *
 * Deliberately **not** making each source an enum member: that would turn adding a source into a scattershot change of
 * "edit the type definition + edit all references". The source identifier is an open set, extensible only when placed in metadata.
 */
export type TaskSourceType = "manual" | "external" | "other";

export type AssetType = "skill" | "llm_wiki" | "code_graph" | "chat_memory";
export type AssetVisibility = "private" | "team" | "restricted" | "agent" | "task";
export type AssetStatus =
  | "draft"
  | "candidate"
  | "approved"
  | "deprecated"
  | "archived"
  | "failed";

export type InjectionMode = "direct" | "summary" | "tool" | "reference";

/** Permission actions (6 kinds). */
export type Permission =
  | "read"
  | "write"
  | "delete"
  | "assign"
  | "share"
  | "use";

/** ACL grant subject types. */
export type AclSubjectType = "user" | "team_role" | "agent";

/** ACL effect (phase one only allow, deny reserved). */
export type AclEffect = "allow" | "deny";

// ============================
// Entity types
// ============================

export type UserKeyStatus = "active" | "revoked";

export interface UserEntity {
  user_id: string;
  /** Password hashed with scrypt+pepper (`$scrypt$...`), nullable. */
  password?: string | null;
  auth_provider: string;
  external_id: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json: string;
  status: UserStatus;
  user_type: UserType;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamEntity {
  team_id: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status: TeamStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TeamMemberEntity {
  id: string;
  team_id: string;
  user_id: string;
  role: TeamRole;
  joined_at: string;
  status: MemberStatus;
}

/** team-member/list · get response: membership + username JOINed at read time (not persisted). */
export interface TeamMemberView extends TeamMemberEntity {
  username: string;
}

export interface AgentEntity {
  agent_id: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility: AssetVisibility;
  status: AgentStatus;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskEntity {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type: TaskSourceType;
  source_url?: string | null;
  status: TaskStatus;
  auto_assign_floating_assets: boolean;
  risk_level?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface TaskAgentEntity {
  id: string;
  task_id: string;
  agent_id: string;
  role_in_task?: string | null;
  status: MemberStatus;
  created_at: string;
}

/** Task/Agent participation event log (append-only). */
export interface ParticipationLogEntity {
  id: string;
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  source: string;
  metadata_json: string;
  created_at: string;
  updated_at: string;
}

export interface AppendParticipationLogInput {
  team_id: string;
  task_id: string;
  agent_id: string;
  user_id: string;
  created_at?: string;
  source?: string;
  metadata_json?: string;
}

export interface ParticipationLogFilter {
  team_id: string;
  task_id?: string;
  agent_id?: string;
  user_id?: string;
  created_after?: string;
  created_before?: string;
  /** Whether to dedupe by user_id; default false. */
  dedupe?: boolean;
}

export interface AssetEntity {
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  version: number;
  visibility: AssetVisibility;
  status: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  last_used_at?: string | null;
  usage_count: number;
  content_ref?: string | null;
  created_at: string;
  updated_at: string;
  metadata_json: string;
}

export interface FixedAssetBindingEntity {
  id: string;
  agent_id: string;
  asset_id: string;
  asset_type: AssetType;
  injection_mode: InjectionMode;
  priority: number;
  created_by: string;
  created_at: string;
}

/** Fixed-asset binding counts aggregated by asset_type (distinct asset_id). */
export interface FixedAssetTypeCounts {
  skill: number;
  code_graph: number;
  llm_wiki: number;
  chat_memory: number;
}

/** Fixed-asset allocation summary of a single agent. */
export interface AgentFixedAssetSummary {
  agent_id: string;
  counts: FixedAssetTypeCounts;
  /** Total number of binding rows matched by this agent (not deduplicated). */
  total: number;
}

/** summary-by-agents response. */
export interface AgentFixedAssetSummaryResult {
  items: AgentFixedAssetSummary[];
  total: number;
}

/** Store/Service: count fixed-asset bindings grouped by multiple agents. */
export interface SummarizeAgentFixedAssetsParams {
  agent_ids: string[];
  /** Optional: only count rows bound to this asset; used for bound_agent_count. */
  asset_id?: string;
}

/** Raw aggregate rows at the Store layer (zeros not filled). */
export interface AgentFixedAssetCountRow {
  agent_id: string;
  asset_type: AssetType;
  cnt: number;
}

/** User API key row (storage layer, containing the full key_value). */
export interface UserKeyEntity {
  key_id: string;
  user_id: string;
  key_value: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
  metadata_json: string;
}

/** API sanitized structure (list / get). */
export interface UserKeyPublic {
  key_id: string;
  user_id: string;
  key_prefix: string;
  name?: string | null;
  status: UserKeyStatus;
  is_default: boolean;
  last_used_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  revoked_at?: string | null;
}

/** create response: the full key_value is returned only this once. */
export interface UserKeyCreated extends UserKeyPublic {
  key_value: string;
}

export interface AclEntity {
  id: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect: AclEffect;
  granted_by: string;
  created_at: string;
  updated_at: string;
}

// ============================
// Input types (create/update)
// ============================

export interface UserPublic {
  user_id: string;
  user_type: UserType;
  username: string;
  created_at: string;
}

/** Optional filters for public user/list (internal list-by-instance additionally has status / user_type). */
export interface UserListFilter {
  user_ids?: string[];
  /** Exact match on username (for duplicate-check scenarios, etc.). */
  username?: string;
}

/** user/create response: does not include username (see 08 §CreateUserResult). */
export interface CreateUserApiResult {
  user_id: string;
  user_type: UserType;
  created_at: string;
  default_user_key: string;
}

export interface InitAdminInput {
  username: string;
  user_key?: string;
}

export interface InitAdminResult {
  user_id: string;
  user_key: string;
}

export interface CreateUserInput {
  user_id?: string;
  /** Internal: init-admin may specify the default user_key. */
  default_key_value?: string;
  /** Storage-layer default `local` (not exposed by the API). */
  auth_provider?: string;
  /** Storage-layer default `user_id` (not exposed by the API). */
  external_id?: string;
  username: string;
  display_name?: string | null;
  email?: string | null;
  raw_profile_json?: string;
  status?: UserStatus;
  metadata_json?: string;
  /** Used only inside the storage layer; API create is fixed to normal, init-admin is fixed to system_admin. */
  user_type?: UserType;
  /** v3.1: always NULL for new users; written only by the store layer. */
  password?: string | null;
}

export interface CreateUserKeyInput {
  user_id: string;
  key_value?: string;
  name?: string | null;
  expires_at?: string | null;
  is_default?: boolean;
  metadata_json?: string;
}

export interface CreateTeamInput {
  team_id?: string;
  name: string;
  description?: string | null;
  owner_user_id: string;
  status?: TeamStatus;
  metadata_json?: string;
}

export interface AddTeamMemberInput {
  id?: string;
  team_id: string;
  user_id: string;
  role?: TeamRole;
  status?: MemberStatus;
}

export interface CreateAgentInput {
  agent_id?: string;
  team_id: string;
  owner_user_id: string;
  name: string;
  description?: string | null;
  prompt?: string | null;
  visibility?: AssetVisibility;
  status?: AgentStatus;
  metadata_json?: string;
}

export interface CreateTaskInput {
  task_id?: string;
  team_id: string;
  creator_user_id: string;
  title: string;
  description?: string | null;
  source_type?: TaskSourceType;
  source_url?: string | null;
  status?: TaskStatus;
  auto_assign_floating_assets?: boolean;
  risk_level?: string | null;
  metadata_json?: string;
  /** Agents that can be linked at the same time when creating a task. */
  linked_agents?: Array<{ agent_id: string; role_in_task?: string }>;
}

export interface CreateAssetInput {
  /** Provided by the caller (the external asset system); the metadata module only records and authorizes, and does not generate asset_id. */
  asset_id: string;
  team_id: string;
  asset_type: AssetType;
  name: string;
  description?: string | null;
  owner_user_id: string;
  source_type: string;
  source_ref?: string | null;
  visibility?: AssetVisibility;
  status?: AssetStatus;
  confidence?: number | null;
  expires_at?: string | null;
  content_ref?: string | null;
  metadata_json?: string;
}

export interface FixedAssetBindingInput {
  asset_id: string;
  asset_type: AssetType;
  injection_mode?: InjectionMode;
  priority?: number;
  created_by: string;
}

export interface GrantAclInput {
  id?: string;
  asset_id: string;
  subject_type: AclSubjectType;
  subject_id: string;
  permission: Permission;
  effect?: AclEffect;
  granted_by: string;
}

// ============================
// Filter types
// ============================

export interface AgentFilter {
  status?: AgentStatus;
  /**
   * Combined filter: when used together with team_id it means "agents owned by a certain user within the team".
   * When owner_user_id is used alone it goes through listAgentsByOwner, and this field is not needed.
   */
  owner_user_id?: string;
  /** Exact match on agent name (for duplicate-check scenarios, etc.). */
  name?: string;
}

export interface TaskFilter {
  status?: TaskStatus;
  creator_user_id?: string;
  /** Exact match on task title (for duplicate-check scenarios, etc.). */
  title?: string;
}

/** team/list optional filter (for duplicate-check scenarios, etc.). */
export interface TeamFilter {
  /** Exact match on team name. */
  name?: string;
}

export interface AssetFilter {
  asset_type?: AssetType;
  status?: AssetStatus;
  owner_user_id?: string;
  visibility?: AssetVisibility;
}

// ============================
// Common result types
// ============================

/** list API pagination input (optional; when omitted the server defaults to limit=20, offset=0). */
export interface PaginationInput {
  limit?: number;
  offset?: number;
}

/** Resolved pagination parameters (limit/offset both have definite values). */
export interface PaginationParams {
  limit: number;
  offset: number;
}

/** list API pagination response envelope. */
export interface PaginatedResult<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Store-layer list query result (internal pagination slice + total). */
export interface ListPage<T> {
  items: T[];
  total: number;
}

/** internal list-by-instance optional filter (extends UserListFilter). */
export interface InstanceUserListFilter extends UserListFilter {
  status?: UserStatus;
  user_type?: UserType;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}

// ============================
// ConfigParam types
// ============================

export type ConfigParamScope = "global" | "user";

export interface ConfigParamEntity {
  id: number;
  scope: ConfigParamScope;
  user_id: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
  created_at: string;
  updated_at: string;
}

export interface UpsertConfigParamInput {
  scope: ConfigParamScope;
  user_id?: string | null;
  module: string;
  param_name: string;
  param_value: string;
  description: string;
}

export interface ListConfigParamsFilter {
  scope?: ConfigParamScope;
  module: string;
  userId?: string;
  paramNames?: string[];
}

// ============================
// InstanceUpstreamConfig types (v2 model group structure)
// ============================
//
// Corresponds to design doc docs/design/2026-08-25-instance-upstream-config.md §5.1.
// v2 refactors from "one row = one agent" to "one row = one model group":
//   - default group: at most 1 row per instance, mode=official, name fixed to "Official Built-in"
//   - custom group: 0~N rows, mode ∈ {custom_unified, custom_passthrough}, name user-defined
//   - extraction row: 0 or 1 row, mode=custom_unified, agents always [], name fixed to "Extraction Model"
//
// Core differences from v1:
//   - agents upgraded from "one agent_source per row" to "one agents array per row"
//   - introduces the group_id (prefixed ULID) + group_type + name + enabled fields
//   - agents globally unique (default + custom do not overlap)
//   - MongoDB version optimistic lock (version field) protects concurrent writes

export type GroupType = "default" | "custom" | "extraction";
export type UpstreamMode = "official" | "custom_unified" | "custom_passthrough";

/** Fixed name of the default group (not changeable by users). */
export const DEFAULT_GROUP_NAME = "Official Built-in";
/** Fixed name of the extraction row (not changeable by users). */
export const EXTRACTION_GROUP_NAME = "Extraction Model";

/**
 * Instance upstream config row (storage-layer entity).
 *
 * One row = one model group (default / custom / extraction).
 * The agents field is stored as a JSON array (SQLite stores JSON in TEXT, MongoDB uses a native array).
 * MongoDB additionally has a `version` field (optimistic lock, §5.3); SQLite does not need it.
 */
export interface InstanceUpstreamConfigEntity {
  id: number;
  /** Backend-generated group ID: `dflt-<random>` / `grp-<random>` / `ext-<random>`. */
  group_id: string;
  group_type: GroupType;
  /** custom: user-defined; default is fixed to DEFAULT_GROUP_NAME; extraction is fixed to EXTRACTION_GROUP_NAME. */
  name: string;
  /**
   * default / custom groups: the explicitly managed agent list (0~N); extraction row: always [].
   * Global uniqueness constraint: within one instance, the elements of default.agents ∪ all custom.agents are pairwise distinct.
   */
  agents: string[];
  /**
   * The enabled semantics differ across the three group_types:
   *   - default:  false = agent requests hitting this group fail with UPSTREAM_DISABLED
   *   - custom:   false = agent requests hitting this group fail with UPSTREAM_DISABLED
   *   - extraction: false = gracefully fall back to the global upstream (no error)
   */
  enabled: boolean;
  mode: UpstreamMode;
  base_url: string;
  api_key: string;
  model_id: string;
  description: string;
  created_at: string;
  updated_at: string;
  /** Optimistic lock version number. MongoDB does $inc:1 on every write; SQLite ignores this field (relies on BEGIN IMMEDIATE transactions). */
  version: number;
  /**
   * Only the default group has a value: the full supported-agents snapshot seen at the last listGroups (deduped + sorted).
   *
   * Used for the "automatically fill in default.agents after Proxy adds an agent" logic (see the store layer
   * `_syncDefaultAgentsWithSnapshot`):
   *   - Proxy adds cursor, supported-agents goes from [old8] to [old8+cursor]
   *   - listGroups triggers a diff: supported - snapshot = [cursor]
   *   - automatically append to default.agents, and update snapshot = [old8+cursor]
   *   - agents the user actively removed (not in agents but in snapshot) keep their decision unchanged
   *
   * On the first listGroups for an existing instance, snapshot=empty → treated as "the user has accepted the current agents",
   * directly fill snapshot with agents (agents unchanged), and only later additions go through diff-append.
   *
   * custom / extraction groups are always []; they do not take part in diff.
   */
  supported_agents_snapshot: string[];
}

/**
 * create input: create a new default (seed internal use) / custom / extraction row.
 * group_id is generated by the store layer; the caller does not pass it.
 */
export interface CreateInstanceUpstreamGroupInput {
  group_type: GroupType;
  name?: string;
  agents?: string[];
  enabled?: boolean;
  mode: UpstreamMode;
  base_url?: string;
  api_key?: string;
  model_id?: string;
  description?: string;
}

/**
 * update input: PATCH semantics, unpassed fields keep their original value.
 * `api_key`: undefined = keep the original value; empty string = explicitly clear.
 */
export interface UpdateInstanceUpstreamGroupInput {
  group_id: string;
  /** Expected group_type, used as a dispatch guard (mismatch with the DB → GROUP_TYPE_MISMATCH). */
  expected_group_type: GroupType;
  /** Optimistic lock: the caller passes the currently-read version; a mismatch on write → WRITE_CONFLICT. */
  expected_version?: number;
  name?: string;
  agents?: string[];
  enabled?: boolean;
  mode?: UpstreamMode;
  base_url?: string;
  api_key?: string;
  model_id?: string;
  description?: string;
}

/** toggle single-field shortcut input (syntactic sugar for update). */
export interface ToggleInstanceUpstreamGroupInput {
  group_id: string;
  enabled: boolean;
  expected_version?: number;
}

/** delete input: physical delete by group_id. */
export interface DeleteInstanceUpstreamGroupInput {
  group_id: string;
}

/** Query filter (for list). */
export interface InstanceUpstreamConfigFilter {
  group_type?: GroupType;
}

/** supported-agents entry (read from the Core yaml; also the source of this module's seed default agents). */
export interface SupportedAgent {
  agent_source: string;
  protocol: "anthropic" | "openai-chat" | "openai-responses";
  display_name: string;
}

/**
 * Write conflict: agents overlap, missing group_id, version mismatch, etc. on concurrent writes.
 * Store layer throws this error directly (not depending on the service layer's MetadataError, to avoid a reverse dependency).
 */
export class InstanceUpstreamWriteConflictError extends Error {
  constructor(
    public readonly reason: "agents_overlap" | "name_duplicate" | "group_not_found" | "group_type_mismatch" | "version_mismatch" | "default_already_exists" | "extraction_already_exists",
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "InstanceUpstreamWriteConflictError";
  }
}
