/**
 * Knowledge store contract — storage-agnostic interface + row/input/aux types.
 *
 * ZERO third-party dependencies (no drizzle, no better-sqlite3). This is the
 * abstraction seam (001 Q6): `IKnowledgeStore` lets us swap the SQLite backend
 * for e.g. a MySQL implementation without touching service/route code.
 *
 * Multi-tenancy (001, phase 5): every resource is scoped by `service_id`.
 *   - Main tables (code_graph / wiki) carry `service_id` NOT NULL.
 *   - Read/write methods take `serviceId` as their FIRST parameter (compile-time
 *     guard against forgetting the tenant filter), INCLUDING id-only lookups
 *     (getCodeGraphById / getWikiById / update*Status / update*Meta). A resource
 *     whose service_id does not match returns null/false → 404 at the route layer.
 *     This closes the cross-Memory leak risk (001 §2.4 / R1).
 *   - Create/audit inputs carry `service_id` on the input object itself.
 */

export type SyncStatus = "pending" | "processing" | "ready" | "failed";

/**
 * Wiki-specific status: on top of SyncStatus, adds a `draft` — the initial state when create builds the shell,
 * meaning "never processed, no content, can be ingested". Once ingest succeeds it becomes ready, on failure failed;
 * afterwards re-running ingest only goes through pending/processing and never returns to draft.
 * code-graph does not use draft (its create enqueues graph building immediately, so the initial pending is truly in-flight).
 */
export type WikiStatus = SyncStatus | "draft";

// ───────────────────────── Code-Graph ─────────────────────────

export interface CodeGraphRow {
  code_graph_id: string;
  service_id: string;
  team_id: string;
  repo_name: string;
  repo_url: string;
  branch: string;
  commit_hash: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  visibility: string;
  status: SyncStatus;
  internal_status: string | null;
  sync_error: string | null;
  stats_json: string | null;
  service_url: string | null;
  summary: string | null;
  version: number;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateCodeGraphInput {
  service_id: string;
  team_id: string;
  repo_url: string;
  branch: string;
  repo_name?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

export interface CodeGraphStatusPatch {
  status?: SyncStatus;
  internal_status?: string | null;
  sync_error?: string | null;
  commit_hash?: string | null;
  last_sync_at?: string | null;
  stats_json?: string | null;
  service_url?: string | null;
  summary?: string | null;
  version?: number;
}

export interface CodeGraphMetaPatch {
  repo_name?: string;
  summary?: string | null;
}

// ───────────────────────── Wiki ─────────────────────────

export interface WikiRow {
  wiki_id: string;
  service_id: string;
  team_id: string;
  name: string;
  source_type: string | null;
  source_url: string | null;
  owner_user_id: string | null;
  user_id: string | null;
  agent_id: string | null;
  task_id: string | null;
  visibility: string;
  status: WikiStatus;
  internal_status: string | null;
  sync_error: string | null;
  page_count: number | null;
  service_url: string | null;
  summary: string | null;
  version: number;
  last_sync_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface CreateWikiInput {
  service_id: string;
  team_id: string;
  name: string;
  source_type?: string;
  source_url?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  service_url?: string;
}

export interface WikiStatusPatch {
  status?: WikiStatus;
  internal_status?: string | null;
  sync_error?: string | null;
  page_count?: number | null;
  last_sync_at?: string | null;
  service_url?: string | null;
  summary?: string | null;
  version?: number;
}

export interface WikiMetaPatch {
  name?: string;
  summary?: string | null;
}

// ───────────────────────── Audit ─────────────────────────

export type AuditAction = "ingest" | "ready" | "failed" | "delete" | "create";

export interface AuditLogInput {
  service_id?: string | null;
  asset_id: string;
  version: number;
  action: AuditAction;
  user_id?: string | null;
  agent_id?: string | null;
  detail?: string | null;
}

export interface AuditLogRow {
  id: number;
  service_id: string | null;
  asset_id: string;
  version: number;
  action: AuditAction;
  user_id: string | null;
  agent_id: string | null;
  detail: string | null;
  created_at: string;
}

// ───────────────────────── Shared ─────────────────────────

export interface CreateResult<T> {
  row: T;
  existed: boolean;
}

export interface ListOpts {
  // Wiki uses WikiStatus (including draft); code-graph only uses SyncStatus, and passing draft yields an empty set (no side effects).
  syncStatus?: WikiStatus;
  limit?: number;
  offset?: number;
}

export interface CountOpts {
  syncStatus?: WikiStatus;
}

/** Restart-recovery projection — carries service_id so dirs can be rebuilt per-tenant. */
export interface SyncedCodeGraphRef {
  code_graph_id: string;
  service_id: string;
  team_id: string;
}

export interface SyncedWikiRef {
  wiki_id: string;
  service_id: string;
  team_id: string;
}

// ───────────────────────── Store interface ─────────────────────────

/**
 * Storage-agnostic knowledge metadata store (001 Q6).
 *
 * Tenant isolation contract: every read/write method takes `serviceId` first and
 * filters on it. id-only accessors that do not match the given memory return
 * null/false (never a foreign tenant's row).
 */
export interface IKnowledgeStore {
  // ── Code-Graph ──
  createCodeGraph(input: CreateCodeGraphInput): CreateResult<CodeGraphRow>;
  getCodeGraph(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null;
  getCodeGraphById(serviceId: string, codeGraphId: string): CodeGraphRow | null;
  listCodeGraphs(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[];
  countCodeGraphs(serviceId: string, teamId: string, opts?: CountOpts): number;
  updateCodeGraphStatus(serviceId: string, codeGraphId: string, patch: CodeGraphStatusPatch): void;
  deleteCodeGraph(serviceId: string, teamId: string, codeGraphId: string): boolean;
  updateCodeGraphMeta(serviceId: string, codeGraphId: string, patch: CodeGraphMetaPatch): CodeGraphRow | null;

  // ── Wiki ──
  createWiki(input: CreateWikiInput): CreateResult<WikiRow>;
  getWiki(serviceId: string, teamId: string, wikiId: string): WikiRow | null;
  getWikiById(serviceId: string, wikiId: string): WikiRow | null;
  listWikis(serviceId: string, teamId: string, opts?: ListOpts): WikiRow[];
  countWikis(serviceId: string, teamId: string, opts?: CountOpts): number;
  updateWikiStatus(serviceId: string, wikiId: string, patch: WikiStatusPatch): void;
  deleteWiki(serviceId: string, teamId: string, wikiId: string): boolean;
  updateWikiMeta(serviceId: string, wikiId: string, patch: WikiMetaPatch): WikiRow | null;

  // ── Audit ──
  appendWikiAudit(input: AuditLogInput): void;
  appendCodeGraphAudit(input: AuditLogInput): void;
  listWikiAudit(serviceId: string, wikiId: string, limit?: number, offset?: number): AuditLogRow[];
  listCodeGraphAudit(serviceId: string, codeGraphId: string, limit?: number, offset?: number): AuditLogRow[];

  // ── Restart recovery ──
  /** Sweep all non-terminal (pending/processing) assets to failed, across all tenants. */
  markInterruptedAsFailed(reason?: string): number;
  /** All ready code-graphs (with service_id) so module.ts can rebuild per-tenant dirs. */
  listSyncedCodeGraphs(): SyncedCodeGraphRef[];
  listSyncedWikis(): SyncedWikiRef[];
}
