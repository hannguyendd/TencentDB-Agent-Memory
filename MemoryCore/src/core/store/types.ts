/**
 * Memory Store Abstraction Layer — Core Types & Interfaces.
 *
 * This module defines the storage contracts that all backend implementations
 * (SQLite local, Tencent Cloud VectorDB, etc.) must satisfy.
 *
 * Design principles:
 * 1. **Backend-agnostic**: Upper-layer modules (hooks, tools, pipeline, record)
 *    depend only on these interfaces — never on concrete implementations.
 * 2. **Capability-based**: Features like vector search, FTS, and hybrid search
 *    are expressed as capability flags so callers can gracefully degrade.
 * 3. **Fault-tolerant**: All methods return empty results or `false` on
 *    failure rather than throwing, unless explicitly documented otherwise.
 * 4. **Sync-first**: Matches current SQLite DatabaseSync usage. TCVDB backend
 *    adapts internally without changing these signatures.
 */

import type { MemoryRecord } from "../record/l1-writer.js";
import type { EmbeddingProviderInfo } from "./embedding.js";
import type { Logger } from "../types.js";
import type { IsolationFilter } from "./isolation.js";
import type { MemoryPromptStore } from "../memory-prompt/types.js";
import type { MemoryGenerationRefStore } from "../memory-generation-log/types.js";

// Re-export so consumers can import everything from types.ts
export type { MemoryRecord, EmbeddingProviderInfo };

// Re-export isolation primitives so all store consumers import from here.
export type {
  IsolationContext,
  IsolationFilter,
  IsolationConfig,
} from "./isolation.js";
export {
  DEFAULT_ISOLATION_ID,
  LEGACY_ISOLATION_PLACEHOLDER,
  DEFAULT_ISOLATION_CONFIG,
  assertIsolation,
  buildIsolationWhere,
  rowMatchesIsolation,
  IsolationError,
} from "./isolation.js";

// ============================
// Common Types
// ============================

/** Minimal logger interface accepted by store implementations. */
export type StoreLogger = Logger;

// ============================
// L1 Types (Structured Memories)
// ============================

/** Result from an L1 vector similarity search. */
export interface L1SearchResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  version: number;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  metadata_json: string;
}

/** Result from an L1 FTS keyword search. */
export interface L1FtsResult {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  version: number;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  metadata_json: string;
}

/** Filter options for querying L1 records. */
export interface L1QueryFilter {
  /** Query by document primary keys (maps to VDB `documentIds`, max 20). */
  recordIds?: string[];
  sessionKey?: string;
  sessionId?: string;
  taskId?: string;
  /** Isolation dimensions (any subset). */
  teamId?: string;
  userId?: string;
  agentId?: string;
  /** Only return records with updated_time strictly after this ISO 8601 UTC timestamp. */
  updatedAfter?: string;
}

/** Row shape returned by L1 query methods. */
export interface L1RecordRow {
  record_id: string;
  content: string;
  type: string;
  priority: number;
  scene_name: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  version: number;
  timestamp_str: string;
  timestamp_start: string;
  timestamp_end: string;
  created_time: string;
  updated_time: string;
  metadata_json: string;
}

// ============================
// L0 Types (Raw Conversations)
// ============================

/** An L0 conversation message record for vector indexing. */
export interface L0Record {
  id: string;
  sessionKey: string;
  sessionId: string;
  /**
   * Three-dim isolation (new in this branch).
   *
   * Mandatory for new writes once gateway-level enforcement is on, but kept
   * optional on the type during the rollout window. SQLite upsert defaults to
   * '' when missing; the migration script backfills existing rows to
   * `__legacy__`.
   */
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  role: string;
  messageText: string;
  recordedAt: string;
  /** Original message timestamp (epoch ms). */
  timestamp: number;
}

/** Result from an L0 vector similarity search. */
export interface L0SearchResult {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  /** Similarity score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Result from an L0 FTS keyword search. */
export interface L0FtsResult {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  /** BM25-derived score (0–1, higher is better). */
  score: number;
  recorded_at: string;
  timestamp: number;
}

/** Raw L0 row returned by query methods (used by L1 runner). */
export interface L0QueryRow {
  record_id: string;
  session_key: string;
  session_id: string;
  team_id: string;
  task_id: string;
  user_id: string;
  agent_id: string;
  role: string;
  message_text: string;
  recorded_at: string;
  timestamp: number;
}

/** L0 messages grouped by session ID (for L1 runner). */
export interface L0SessionGroup {
  sessionId: string;
  teamId?: string;
  userId: string;
  agentId: string;
  taskId?: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    timestamp: number;
    /** Epoch ms when this message was recorded into L0 (used by L1 cursor). */
    recordedAtMs: number;
  }>;
}

// ============================
// Store Init Result
// ============================

/** Result of store initialization. */
export interface StoreInitResult {
  /** Whether embeddings need to be regenerated (provider/model change). */
  needsReindex: boolean;
  /** Human-readable reason (for logging). */
  reason?: string;
}

// ============================
// Capability Flags
// ============================

/**
 * Describes what search capabilities a store backend supports.
 * Callers use this to select search strategies and degrade gracefully.
 */
export interface StoreCapabilities {
  /** Whether vector (embedding) search is available. */
  vectorSearch: boolean;
  /** Whether FTS (full-text keyword) search is available. */
  ftsSearch: boolean;
  /** Whether native hybrid search is supported (e.g., TCVDB hybridSearch). */
  nativeHybridSearch: boolean;
  /** FTS accepts raw text and returns normalized BM25 scores without client fusion. */
  nativeBm25Search?: boolean;
  /** Whether the store supports sparse vectors (BM25 encoding). */
  sparseVectors: boolean;
  /**
   * Whether the store serves L2/L3 profile rows, i.e. satisfies
   * {@link IProfileRowStore}. Required to back a row-view filesystem (`rowfs`).
   * SQLite reports `false`.
   */
  profileRows: boolean;
}

// ============================
// L2/L3 Profile Sync Types
// ============================

/** Canonical L2/L3 profile row shared between local cache and remote store. */
export interface ProfileRecord {
  /** Stable ID: `profile:v1:${sha256(scope + "\0" + type + "\0" + filename)}`. */
  id: string;
  type: "l2" | "l3";
  filename: string;
  content: string;
  contentMd5: string;
  /** L2/L3 profile identity is team+agent scoped. userId/sessionId are optional
   *  for backwards compatibility with old in-memory shapes; new profile writes leave them empty. */
  teamId?: string;
  agentId?: string;
  userId?: string;
  sessionId?: string;
  version: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** Profile upsert payload with optimistic-lock baseline from the last pull. */
export interface ProfileSyncRecord extends ProfileRecord {
  baselineVersion?: number;
}

/**
 * Filter for profile row queries — shared by `countProfiles` and `queryProfiles`.
 *
 * `pathPrefix` matches `filename` by string prefix (Mongo `$regex ^prefix`,
 * TCVDB `startsWith`), which is what `IStorageBackend.listObjects` needs.
 */
export interface ProfileFilter {
  type?: ProfileRecord["type"];
  teamId?: string;
  userId?: string;
  agentId?: string;
  pathPrefix?: string;
}

/** @deprecated Use {@link ProfileFilter}. Kept so existing call sites keep compiling. */
export type ProfileCountFilter = ProfileFilter;

/**
 * The profile-row surface required to back a row-view filesystem
 * (`ProfileRowStorageBackend`).
 *
 * On {@link IMemoryStore} these methods are all optional, because SQLite does not
 * implement them. This interface restates them as **required**, so that anything
 * needing a row-view filesystem can demand `IMemoryStore & IProfileRowStore` and
 * let `tsc` reject a store that cannot serve it.
 *
 * Use {@link isProfileRowStore} (store/profile-row-store.ts) to narrow at runtime.
 */
export interface IProfileRowStore {
  pullProfiles(): Promise<ProfileRecord[]>;
  queryProfilesByIds(ids: string[]): Promise<ProfileRecord[]>;
  /** Query rows by scope/type/path-prefix. Returns rows rather than a count. */
  queryProfiles(filter?: ProfileFilter): Promise<ProfileRecord[]>;
  countProfiles(filter?: ProfileFilter): Promise<number>;
  syncProfiles(records: ProfileSyncRecord[]): Promise<void>;
  deleteProfiles(recordIds: string[]): Promise<void>;
}

/** An {@link IMemoryStore} that is statically known to serve profile rows. */
export type ProfileRowCapableStore = IMemoryStore & IProfileRowStore;

// ============================
// v2 API Paginated Query Types
// ============================

/** Filter for v2 L0 paginated query (`/conversation/query`). */
export interface L0CountFilter {
  /** Filter by session. */
  sessionId?: string;
  /** Isolation dimensions (any subset). */
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  /** Timestamp >= (epoch ms, inclusive). */
  timeStartMs?: number;
  /** Timestamp <= (epoch ms, inclusive). */
  timeEndMs?: number;
}

export interface L0PaginatedFilter extends L0CountFilter {
  /** Page size. */
  limit: number;
  /** Page offset. */
  offset: number;
}

/** Result of v2 L0 paginated query. */
export interface L0PaginatedResult {
  rows: L0QueryRow[];
  /** Total count matching filters (for pagination). */
  total: number;
}

/** Filter for v2 L1 paginated query (`/atomic/query`). */
export interface L1CountFilter {
  /** Filter by memory type (episodic/persona/instruction). */
  type?: string;
  /** Filter by session. */
  sessionId?: string;
  /** Isolation dimensions (any subset). */
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
  /** Filter by updated_time >= (ISO 8601). */
  timeStart?: string;
  /** Filter by updated_time <= (ISO 8601). */
  timeEnd?: string;
}

export interface L1PaginatedFilter extends L1CountFilter {
  /** Page size. */
  limit: number;
  /** Page offset. */
  offset: number;
}

/** Result of v2 L1 paginated query. */
export interface L1PaginatedResult {
  rows: L1RecordRow[];
  /** Total count matching filters (for pagination). */
  total: number;
}

// ============================
// Entity Metadata Types (Team / User / Agent / Task)
// ============================

export type TeamStatus = "active" | "archived";
export type UserStatus = "active" | "inactive";
export type AgentStatus = "active" | "inactive";
export type AgentVisibility = "team" | "restricted";
/** Broad category, excluding the concrete source (read the source from metadata_json.external.provider). */
export type TaskSourceType = "manual" | "external" | "other";

export interface TeamEntity {
  team_id: string;
  name: string;
  description?: string;
  owner_user_id: string;
  status: TeamStatus;
  user_ids?: string[];
  agent_ids?: string[];
  task_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface UserEntity {
  user_id: string;
  name: string;
  job_description?: string;
  team_ids: string[];
  task_ids: string[];
  owned_agent_ids: string[];
  task_agent_ids?: string[];
  status: UserStatus;
  created_at: string;
  updated_at: string;
}

export interface AgentEntity {
  agent_id: string;
  team_id: string;
  name: string;
  description?: string;
  prompt?: string;
  owner_user_id?: string;
  visibility: AgentVisibility;
  status: AgentStatus;
  task_ids?: string[];
  created_at: string;
  updated_at: string;
}

export interface TaskEntity {
  task_id: string;
  team_id: string;
  creator_user_id: string;
  title?: string;
  description?: string;
  source_type: TaskSourceType;
  source_url?: string;
  agent_ids: string[];
  user_ids: string[];
  created_at: string;
  updated_at: string;
}

export interface BatchDeleteResult {
  deleted_ids: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Clear all content under a memory by isolation dimension (does not delete the asset itself).
 *
 * Semantic conventions (see `/v3/chat-memory/clear`):
 *   - at least teamId + agentId must be given, otherwise the implementation must reject directly (to avoid wiping the whole database by mistake);
 *   - without sessionId: clear the data of all sessions under that (team, agent);
 *   - delete only content rows (L0/L1 + vector / FTS auxiliary rows), do not touch the meta_* asset tables.
 */
export interface MemoryContentClearFilter {
  teamId: string;
  agentId: string;
  /** Optional: narrow further to a single user. Omitted means all users under that agent. */
  userId?: string;
}

/** Clear result: the number of rows actually deleted per layer. */
export interface MemoryContentClearResult {
  l0Deleted: number;
  l1Deleted: number;
  /** Number of L2/L3 profile rows (VDB / sqlite profiles table). */
  profilesDeleted: number;
}

export type KnowledgeType = "wiki" | "code-graph";

export interface KnowledgeEntity {
  knowledge_id: string;
  type: KnowledgeType;
  service_url: string;
  name: string;
  summary: string | null;
  team_id: string;
  /** Reserved: agent binding dimension (currently written as ""; the binding authority is in meta_assets). */
  agent_id?: string;
  user_id: string | null;
  repo_url?: string;
  branch?: string;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeListResult {
  items: KnowledgeEntity[];
  total: number;
}

// ============================
// IMemoryStore — The Core Abstraction
// ============================

/**
 * Unified memory store interface.
 *
 * Implementations:
 * - `SqliteMemoryStore` (sqlite.ts) — local SQLite + sqlite-vec + FTS5
 * - `TcvdbMemoryStore` (tcvdb.ts) — Tencent Cloud VectorDB (future)
 *
 * All methods are fault-tolerant: they return empty results or `false` on
 * failure rather than throwing, unless explicitly documented otherwise.
 */
/**
 * Helper type: a value that may be sync or async.
 * Callers should always `await` the result — it's safe for both sync and async values.
 */
export type MaybePromise<T> = T | Promise<T>;

// ============================
// Memory Audit (modification audit)
// ============================

/**
 * One memory modification event. The original L0/L1/L2/L3 tables are left completely untouched; only one audit row is appended here.
 *
 * Design notes (per user decision):
 *   - does not store historical content / old values, only records "when, by whom, which one was changed"
 *   - team/agent/user/task come from the external request IdFields (not the record's original values)
 *   - version = the new version number of the record after modification (consistent with the original table's version field)
 *   - L0 does not enter audit (immutable stream); L1/L2/L3 each record one entry for update + delete
 */
export interface AuditEntry {
  /** Auto-generated primary key, audit-{uuid} recommended. */
  audit_id: string;
  /**
   * Primary key of the modified record:
   *   - L1 → MemoryRecord.id (msg-xxx / mem-xxx)
   *   - L2 → file path (scene_blocks/xxx.md)
   *   - L3 → "core" (only one for the whole instance) or path
   */
  record_id: string;
  layer: "L1" | "L2" | "L3";
  action: "update" | "delete";
  /** Copy of the external request IdFields, sourced from the body / header passed by the caller (after resolveIsolation). */
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  task_id?: string;
  /** New version number of the record after modification. For delete use 0 or the previous version number + 1. */
  version: number;
  /** Modification time (ms). */
  updated_at_ms: number;
  /** Gateway request_id, for easy tracing. */
  request_id?: string;
}

/** queryAudit filter conditions, all optional. */
export interface AuditQueryFilter {
  record_id?: string;
  layer?: "L1" | "L2" | "L3";
  action?: "update" | "delete";
  team_id?: string;
  agent_id?: string;
  user_id?: string;
  task_id?: string;
  /** Return only events with updated_at_ms ≥ since_ms. */
  since_ms?: number;
  /** Return only events with updated_at_ms ≤ until_ms. */
  until_ms?: number;
  limit?: number;   // default 100, max 1000
  offset?: number;
}

export interface IMemoryStore extends MemoryPromptStore, MemoryGenerationRefStore {
  // ── Capabilities ───────────────────────────────────────────

  /**
   * Whether this store supports deferred (background) embedding updates.
   *
   * When `true`, auto-capture writes metadata-only via `upsertL0(record, undefined)`
   * and later calls `updateL0Embedding()` in a fire-and-forget background task.
   * When `false` or absent, embedding is computed inline and passed to `upsertL0()`.
   */
  readonly supportsDeferredEmbedding?: boolean;

  // ── Lifecycle (always sync) ──────────────────────────────

  init(providerInfo?: EmbeddingProviderInfo): MaybePromise<StoreInitResult>;
  isDegraded(): boolean;
  getCapabilities(): StoreCapabilities;
  close(): void;

  // ── L1 Write ─────────────────────────────────────────────

  upsertL1(record: MemoryRecord, embedding?: Float32Array): MaybePromise<boolean>;
  deleteL1(recordId: string, filter?: IsolationFilter): MaybePromise<boolean>;
  deleteL1Batch(recordIds: string[], filter?: IsolationFilter): MaybePromise<boolean>;
  deleteL1Expired(cutoffIso: string): MaybePromise<number>;

  // ── L1 Read ──────────────────────────────────────────────

  countL1(filter?: L1CountFilter): MaybePromise<number>;
  queryL1Records(filter?: L1QueryFilter): MaybePromise<L1RecordRow[]>;
  getAllL1Texts(): MaybePromise<Array<{ record_id: string; content: string; updated_time: string }>>;

  // ── L1 Search ────────────────────────────────────────────

  searchL1Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): MaybePromise<L1SearchResult[]>;
  searchL1Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): MaybePromise<L1FtsResult[]>;
  searchL1Hybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    topK?: number;
    filter?: IsolationFilter;
  }): MaybePromise<L1SearchResult[]>;

  // ── L0 Write ─────────────────────────────────────────────

  upsertL0(record: L0Record, embedding?: Float32Array): MaybePromise<boolean>;
  /** Update only the vector embedding for an existing L0 record (sqlite background path). */
  updateL0Embedding?(recordId: string, embedding: Float32Array): MaybePromise<boolean>;
  /**
   * Insert a whole `/conversation/add` group in one batch (optional capability).
   *
   * Callers prefer this over the per-record `upsertL0` loop when present AND no
   * per-message embedding is required. Records carry freshly-generated ids, so
   * an `insertMany`-style implementation is correct; a duplicate id must surface
   * as an error rather than silently overwrite. Returns the number inserted.
   * See docs/design/mongodb/phases/phase-1-db/2026-08-24-l0-write-batch-and-id.md.
   */
  insertL0Batch?(records: L0Record[]): MaybePromise<number>;
  deleteL0(recordId: string, filter?: IsolationFilter): MaybePromise<boolean>;
  deleteL0Expired(cutoffIso: string): MaybePromise<number>;

  // ── L0 Read ──────────────────────────────────────────────

  countL0(filter?: L0CountFilter): MaybePromise<number>;
  queryL0ForL1(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0QueryRow[]>;
  queryL0GroupedBySessionId(sessionKey: string, afterRecordedAtMs?: number, limit?: number): MaybePromise<L0SessionGroup[]>;
  getAllL0Texts(): MaybePromise<Array<{ record_id: string; message_text: string; recorded_at: string }>>;

  // ── L0 Search ────────────────────────────────────────────

  searchL0Vector(queryEmbedding: Float32Array, topK?: number, queryText?: string, filter?: IsolationFilter): MaybePromise<L0SearchResult[]>;
  searchL0Fts(ftsQuery: string, limit?: number, filter?: IsolationFilter): MaybePromise<L0FtsResult[]>;
  searchL0Hybrid?(params: {
    query?: string;
    queryEmbedding?: Float32Array;
    sparseVector?: Array<[number, number]>;
    topK?: number;
    filter?: IsolationFilter;
  }): MaybePromise<L0SearchResult[]>;

  pullProfiles?(): Promise<ProfileRecord[]>;
  /**
   * Batch query by profile stable id (lightweight, queries only the given ids).
   * When the store supports it, callers should prefer this interface over a full pull with pullProfiles().
   * A store that does not support it returns undefined → the caller falls back to pullProfiles().
   */
  queryProfilesByIds?(ids: string[]): Promise<ProfileRecord[]>;
  /**
   * Query profile rows by scope / type / filename prefix (returns rows, not a count).
   * Supports `listObjects` on the row-view file system, avoiding degradation into a full pullProfiles().
   */
  queryProfiles?(filter?: ProfileFilter): Promise<ProfileRecord[]>;
  countProfiles?(filter?: ProfileFilter): Promise<number>;
  syncProfiles?(records: ProfileSyncRecord[]): Promise<void>;
  deleteProfiles?(recordIds: string[]): Promise<void>;

  // ── Re-index ─────────────────────────────────────────────

  reindexAll(
    embedFn: (text: string) => Promise<Float32Array>,
    onProgress?: (done: number, total: number, layer: "L1" | "L0") => void,
  ): Promise<{ l1Count: number; l0Count: number }>;

  // ── FTS (always sync — cached flag) ──────────────────────

  isFtsAvailable(): boolean;

  // ── v2 API: Paginated queries (optional — added for Gateway v2) ──

  /**
   * L0 paginated query for v2 API `/conversation/query`.
   * Returns rows matching the filter, paginated by limit/offset,
   * plus the total count of matching rows.
   */
  queryL0Paginated?(filter: L0PaginatedFilter): MaybePromise<L0PaginatedResult>;

  /**
   * L1 paginated query for v2 API `/atomic/query`.
   * Returns rows matching the filter, paginated by limit/offset,
   * plus the total count of matching rows.
   */
  queryL1Paginated?(filter: L1PaginatedFilter): MaybePromise<L1PaginatedResult>;

  /**
   * Delete all L0 messages belonging to a session.
   * Returns the actual number of rows deleted.
   * Used by v2 API `/conversation/delete` (session mode).
   */
  deleteL0BySession?(sessionId: string, filter?: IsolationFilter): MaybePromise<number>;

  /**
   * Clear all memory content under a (team, agent): L0 + L1 + L2/L3 profile rows,
   * together with their vector / FTS auxiliary data. **Does not touch** the meta_* asset tables — asset IDs,
   * ownership, bindings, ACLs, visibility, and names are all preserved.
   *
   * Used by `/v3/chat-memory/clear`. Idempotent: calling it again on an already-cleared memory returns all 0s.
   * The implementation must verify that filter.teamId / filter.agentId are non-empty, otherwise throw and refuse to execute.
   */
  clearMemoryContent?(filter: MemoryContentClearFilter): MaybePromise<MemoryContentClearResult>;

  // ── Entity metadata (Team / User / Agent / Task) ───────────
  createTeam?(input: Omit<TeamEntity, "created_at" | "updated_at" | "status" | "user_ids" | "agent_ids" | "task_ids"> & { team_id?: string; status?: TeamStatus }): MaybePromise<TeamEntity>;
  getTeam?(teamId: string): MaybePromise<TeamEntity | null>;
  updateTeam?(teamId: string, patch: Partial<Pick<TeamEntity, "name" | "description" | "owner_user_id" | "user_ids" | "agent_ids" | "status">>): MaybePromise<TeamEntity | null>;
  deleteTeams?(teamIds: string[]): MaybePromise<BatchDeleteResult>;

  createUser?(input: Pick<UserEntity, "name"> & Partial<Pick<UserEntity, "job_description" | "status">> & { user_id?: string }): MaybePromise<UserEntity>;
  getUser?(userId: string): MaybePromise<UserEntity | null>;
  updateUser?(userId: string, patch: Partial<Pick<UserEntity, "name" | "job_description" | "status">>): MaybePromise<UserEntity | null>;
  deleteUsers?(userIds: string[]): MaybePromise<BatchDeleteResult>;

  createAgent?(input: Omit<AgentEntity, "created_at" | "updated_at" | "status" | "visibility"> & { agent_id?: string; status?: AgentStatus; visibility?: AgentVisibility }): MaybePromise<AgentEntity>;
  getAgent?(agentId: string): MaybePromise<AgentEntity | null>;
  updateAgent?(agentId: string, patch: Partial<Pick<AgentEntity, "name" | "description" | "prompt" | "owner_user_id" | "visibility" | "status">>): MaybePromise<AgentEntity | null>;
  deleteAgents?(agentIds: string[]): MaybePromise<BatchDeleteResult>;

  createTask?(input: Omit<TaskEntity, "created_at" | "updated_at" | "source_type" | "agent_ids" | "user_ids"> & { task_id?: string; source_type?: TaskSourceType; agent_ids?: string[]; user_ids?: string[] }): MaybePromise<TaskEntity>;
  getTask?(taskId: string): MaybePromise<TaskEntity | null>;
  updateTask?(taskId: string, patch: Partial<Pick<TaskEntity, "title" | "description" | "source_type" | "source_url" | "agent_ids" | "user_ids">>): MaybePromise<TaskEntity | null>;
  deleteTasks?(taskIds: string[]): MaybePromise<BatchDeleteResult>;

  // ── Knowledge entity (wiki / code-graph metadata) ───────────
  createKnowledge?(input: Omit<KnowledgeEntity, "created_at" | "updated_at">): MaybePromise<KnowledgeEntity>;
  getKnowledge?(knowledgeId: string): MaybePromise<KnowledgeEntity | null>;
  updateKnowledge?(knowledgeId: string, patch: Partial<Pick<KnowledgeEntity, "name" | "summary" | "service_url" | "repo_url" | "branch">>): MaybePromise<KnowledgeEntity | null>;
  deleteKnowledge?(knowledgeIds: string[], teamId?: string): MaybePromise<BatchDeleteResult>;
  listKnowledge?(input: { team_id: string; type?: KnowledgeType; knowledge_ids?: string[]; limit?: number; offset?: number }): MaybePromise<KnowledgeListResult>;

  // ── Memory Audit (modification audit; optional so a store may choose not to implement it) ──
  appendAudit?(entry: AuditEntry): MaybePromise<void>;
  queryAudit?(filter: AuditQueryFilter): MaybePromise<AuditEntry[]>;
}

// ============================
// IEmbeddingService — re-exported from embedding.ts for convenience
// ============================

/**
 * Re-export EmbeddingService as IEmbeddingService for backward compatibility.
 * The canonical definition lives in `./embedding.ts`. All concrete implementations
 * (LocalEmbeddingService, OpenAIEmbeddingService, NoopEmbeddingService) implement
 * the EmbeddingService interface from embedding.ts.
 */
export type { EmbeddingService as IEmbeddingService } from "./embedding.js";
