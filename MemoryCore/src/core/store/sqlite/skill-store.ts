/**
 * SqliteSkillStore — new skill data access layer.
 *
 * Design goals:
 *   - single table with multiple rows and versions: one row per (skill_id, version), is_head=1 marks the current version
 *   - 5-tuple identity hard fields: user_id / owner_agent_id / team_id / task_id / skill_id
 *   - unaware of binding / floating / draft / conflict
 *   - write path: old head set to 0 → INSERT new row → fts5 sync (atomic in a transaction)
 *   - read path: all queries force team_id filtering
 *
 * See docs/design/2026-06-17-skill-redesign-v2.md §2 / §5 for details.
 *
 * Note: this file was added in Phase 2. When Phase 10 cleans up, the old `skill-store.ts` is deleted
 * and this file is renamed to `skill-store.ts`.
 */

import type { DatabaseSync } from "node:sqlite";

import { randomBase62 } from "../../../utils/short-id.js";
import { SKILLS_DDL, SKILL_FTS_DDL, SKILL_VEC_DDL_TEMPLATE, FTS_CONTENT_MAX } from "../../skill/skill-store-ddl.js";
import { buildFtsQuery, tokenizeForFts } from "../tokenize.js";
import type { ISkillStore, ExpiredVersionMeta, SkillStoreCapabilities, SkillSearchResult } from "../../skill/skill-store.interface.js";
import { SkillStoreError } from "../../skill/skill-store.interface.js";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  SkillManifestEntry,
  SkillStatus,
  Skill,
} from "../../skill/types.js";

// ═══════════════════════════════════════════════════════════════════════
//  Logger interface
// ═══════════════════════════════════════════════════════════════════════

export interface StoreLogger {
  debug?(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

// ═══════════════════════════════════════════════════════════════════════
//  Options
// ═══════════════════════════════════════════════════════════════════════

export interface SqliteSkillStoreOptions {
  db: DatabaseSync;
  /** Embedding dimension. 0 = do not create the skill_vec virtual table. */
  dimensions: number;
  logger?: StoreLogger;
  /** Injected now (ms). Default Date.now. Convenient for tests. */
  now?: () => number;
  /** Injected ULID generator. See mkUlid() for the default. Convenient for tests. */
  ulid?: () => string;
}

// ═══════════════════════════════════════════════════════════════════════
//  Internal helpers
// ═══════════════════════════════════════════════════════════════════════

/**
 * row_id generator — the physical primary key of each row (TEXT PRIMARY KEY).
 * Separate from skill_id: skill_id is shared across versions, row_id is unique per row.
 * base62 12 characters (~71 bits of CSPRNG true entropy); no base36 pseudo-random hazard.
 */
function defaultUlid(): string {
  return randomBase62(12);
}

interface SkillRowRaw {
  row_id: string;
  skill_id: string;
  version: number;
  is_head: number;

  user_id: string;
  owner_agent_id: string;
  team_id: string;
  task_id: string;

  name: string;
  description: string;
  content: string;
  content_hash: string;
  manifest_json: string;
  storage_dir: string;

  status: string;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

function toSkill(raw: SkillRowRaw): Skill {
  let manifest: SkillManifestEntry[];
  try {
    manifest = JSON.parse(raw.manifest_json);
    if (!Array.isArray(manifest)) manifest = [];
  } catch {
    manifest = [];
  }
  return {
    row_id: raw.row_id,
    skill_id: raw.skill_id,
    version: raw.version,
    is_head: raw.is_head === 1,
    user_id: raw.user_id,
    owner_agent_id: raw.owner_agent_id,
    team_id: raw.team_id,
    task_id: raw.task_id,
    name: raw.name,
    description: raw.description,
    content: raw.content,
    content_hash: raw.content_hash,
    manifest,
    storage_dir: raw.storage_dir,
    status: raw.status as SkillStatus,
    metadata_json: raw.metadata_json,
    created_at_ms: raw.created_at_ms,
    updated_at_ms: raw.updated_at_ms,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Store implementation
// ═══════════════════════════════════════════════════════════════════════

export class SqliteSkillStore implements ISkillStore {
  private readonly db: DatabaseSync;
  private readonly dimensions: number;
  private readonly logger?: StoreLogger;
  private readonly now: () => number;
  private readonly ulid: () => string;
  private vecAvailable = false;
  private degraded = false;

  constructor(opts: SqliteSkillStoreOptions) {
    this.db = opts.db;
    this.dimensions = Math.max(0, Math.floor(opts.dimensions ?? 0));
    this.logger = opts.logger;
    this.now = opts.now ?? (() => Date.now());
    this.ulid = opts.ulid ?? defaultUlid;
  }

  /** Create tables and indexes. Idempotent. Also migrates old indexes and the FTS schema. */
  init(): void {
    this.db.exec(SKILLS_DDL);
    // Migration: drop the old (team_id, name) unique index (after the v2 refactor it became team_id + owner_agent_id + name)
    this.db.exec("DROP INDEX IF EXISTS uniq_skills_team_name_head");
    this.db.exec(SKILL_FTS_DDL);
    // Migration: detect whether skill_fts is missing the owner_agent_id column (the old schema has only 5 columns)
    this.migrateFtsSchema();
    if (this.dimensions > 0) {
      try {
        const ddl = SKILL_VEC_DDL_TEMPLATE.replace(/__DIM__/g, String(this.dimensions));
        this.db.exec(ddl);
        this.vecAvailable = true;
      } catch (e) {
        this.logger?.warn(`[skill-store] vec0 init failed: ${(e as Error).message}; downgrade to bm25-only`);
        this.vecAvailable = false;
      }
    }
  }

  /**
   * Detect and migrate the skill_fts table schema.
   *
   * Background: the old FTS DDL had only 5 columns (name, description, content, skill_id, team_id),
   * and the new version adds three columns: owner_agent_id / task_id / user_id. But CREATE VIRTUAL TABLE IF NOT EXISTS
   * does not modify an existing table, so new code querying/writing 8 columns hits a "no such column" error.
   *
   * Migration strategy: detect missing owner_agent_id → DROP the old FTS table → rebuild → backfill head rows from the skills main table.
   * This is safer than ALTER (FTS5 does not support ALTER) and loses no data (the main table is the only data source).
   */
  private migrateFtsSchema(): void {
    // Detect: if the skill_fts table does not exist, skip (on first startup SKILL_FTS_DDL creates it automatically)
    const tableCheck = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='skill_fts'")
      .get() as { name: string } | undefined;
    if (!tableCheck) return;

    // detect whether the existing skill_fts contains the owner_agent_id column
    const cols = this.db
      .prepare("PRAGMA table_info('skill_fts')")
      .all() as Array<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>;
    const colNames = new Set(cols.map((c) => c.name));

    // the new version needs owner_agent_id / task_id / user_id; the old one has only 5 columns, missing these 3
    if (colNames.has("owner_agent_id")) return; // already the new schema, no migration needed

    this.logger?.info("[skill-store] migrating skill_fts schema: old columns missing owner_agent_id/task_id/user_id");

    // Step 1: read all head rows from the main table (for backfill)
    interface HeadRow {
      skill_id: string;
      name: string;
      description: string;
      content: string;
      team_id: string;
      owner_agent_id: string;
      task_id: string;
      user_id: string;
    }
    const headRows = this.db
      .prepare("SELECT skill_id, name, description, content, team_id, owner_agent_id, task_id, user_id FROM skills WHERE is_head=1 AND status='active'")
      .all() as unknown as HeadRow[];

    // Step 2: DROP the old table → rebuild with the new schema (atomic operation inside a transaction)
    this.db.exec("BEGIN");
    try {
      this.db.exec("DROP TABLE IF EXISTS skill_fts");
      this.db.exec(SKILL_FTS_DDL);

      // Step 3: backfill all head rows into FTS
      const insertStmt = this.db.prepare(
        "INSERT INTO skill_fts (name, description, content, skill_id, team_id, owner_agent_id, task_id, user_id) VALUES (?,?,?,?,?,?,?,?)",
      );
      for (const row of headRows) {
        const ftsContent = row.content.length > FTS_CONTENT_MAX
          ? row.content.slice(0, FTS_CONTENT_MAX)
          : row.content;
        insertStmt.run(
          tokenizeForFts(row.name),
          tokenizeForFts(row.description),
          tokenizeForFts(ftsContent),
          row.skill_id,
          row.team_id,
          row.owner_agent_id,
          row.task_id,
          row.user_id,
        );
      }

      this.db.exec("COMMIT");
      this.logger?.info(`[skill-store] fts migration done: rebuilt skill_fts with ${headRows.length} head rows`);
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.logger?.error(`[skill-store] fts migration failed: ${(e as Error).message}`);
      // Even if the migration fails, do not throw — the gateway can still start, only skill search may degrade
      // It retries on the next restart (because after skill_fts is dropped, SKILL_FTS_DDL rebuilds an empty table)
    }
  }

  /** Whether in degraded mode (SQLite connection abnormal, etc.) */
  isDegraded(): boolean {
    return this.degraded;
  }

  /** Get the store capability declaration */
  getCapabilities(): SkillStoreCapabilities {
    return {
      vectorSearch: this.vecAvailable,
      ftsSearch: true,
      nativeHybridSearch: false,
      sparseVectors: false,
    };
  }

  /** Close the store (a no-op in SQLite mode; the connection is managed externally) */
  close(): void {
    this.degraded = true;
  }

  // ────────────────────────────────────────────────────────────────────
  //  appendVersion
  //
  //  Note: the store no longer does the content_hash idempotency check — this layer only handles "write one new version row".
  //  Idempotency semantics (content + manifest both unchanged → do not write a new version) are decided by skill-versioning at the
  //  upper layer, because only it knows both content_hash and the new manifest_json.
  // ────────────────────────────────────────────────────────────────────
  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    const tid = input.team_id ?? "default";
    const head = await this.getHead(input.skill_id, tid);

    // [4] same team, same agent, same name already has an active head (and it is not an update of the same skill_id) → duplicate name
    if (!head) {
      const oid = input.owner_agent_id ?? "default";
      const dupRaw = this.db
        .prepare(
          "SELECT * FROM skills WHERE team_id=? AND owner_agent_id=? AND name=? AND is_head=1 AND status='active' LIMIT 1",
        )
        .get(tid, oid, input.name) as SkillRowRaw | undefined;
      if (dupRaw) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${input.name}' already exists for agent in team`);
      }
    } else {
      // there is already history for the same skill_id → name is immutable
      if (head.name !== input.name) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
      }
    }

    const newVersion = head ? head.version + 1 : 1;
    const ownerForRow = head ? head.owner_agent_id : (input.owner_agent_id ?? "default");
    // user_id records the operator of this operation, not the first creator. Later versions take input.user_id.
    const userIdForRow = input.user_id ?? "default";
    const ts = this.now();
    const newRowId = this.ulid();

    // Transaction: flip the old head to 0 → INSERT the new row → sync fts5
    // node:sqlite has no db.transaction() helper yet, so BEGIN/COMMIT is written by hand.
    // Must stay synchronous (do not await in the middle), same idea as sqlite-transaction-guard.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (head) {
        this.db
          .prepare("UPDATE skills SET is_head=0 WHERE skill_id=? AND version=?")
          .run(head.skill_id, head.version);
      }

      this.db
        .prepare(
          `INSERT INTO skills (
            row_id, skill_id, version, is_head,
            user_id, owner_agent_id, team_id, task_id,
            name, description, content, content_hash, manifest_json, storage_dir,
            status, metadata_json, created_at_ms, updated_at_ms
          ) VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?,?)`,
        )
        .run(
          newRowId,
          input.skill_id,
          newVersion,
          1,
          userIdForRow,
          ownerForRow,
          tid,
          input.task_id ?? "default",
          input.name,
          input.description,
          input.content,
          input.content_hash,
          JSON.stringify(input.manifest ?? []),
          input.storage_dir,
          "active",
          input.metadata_json ?? "{}",
          ts,
          ts,
        );

      // FTS sync: delete all old index rows of this skill_id → insert only the new head
      this.db.prepare("DELETE FROM skill_fts WHERE skill_id=?").run(input.skill_id);
      const ftsContent = input.content.length > FTS_CONTENT_MAX
        ? input.content.slice(0, FTS_CONTENT_MAX)
        : input.content;
      // Use jieba pre-tokenization (the same approach as L0/L1 FTS) so the unicode61 tokenizer can split Chinese by spaces.
      // If jieba is unavailable, tokenizeForFts returns the original text directly.
      const ftsName = tokenizeForFts(input.name);
      const ftsDescription = tokenizeForFts(input.description);
      const ftsContentTokenized = tokenizeForFts(ftsContent);
      this.db
        .prepare(
          "INSERT INTO skill_fts (name, description, content, skill_id, team_id, owner_agent_id, task_id, user_id) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(ftsName, ftsDescription, ftsContentTokenized, input.skill_id, tid, ownerForRow, input.task_id ?? "default", userIdForRow);

      this.db.exec("COMMIT");
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }

    // fetch the new row (read outside the transaction to save lock-holding time)
    const inserted = this.db
      .prepare("SELECT * FROM skills WHERE row_id=?")
      .get(newRowId) as SkillRowRaw;
    return toSkill(inserted);
  }

  // ────────────────────────────────────────────────────────────────────
  //  archiveHead
  // ────────────────────────────────────────────────────────────────────
  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    const where = teamId ? "skill_id=? AND team_id=? AND is_head=1" : "skill_id=? AND is_head=1";
    const args: unknown[] = teamId ? [this.now(), skillId, teamId] : [this.now(), skillId];
    const r = this.db
      .prepare(`UPDATE skills SET status='archived', updated_at_ms=? WHERE ${where}`)
      .run(...args);

    // remove from fts after archiving (no longer searchable)
    if ((r.changes ?? 0) > 0) {
      this.db.prepare("DELETE FROM skill_fts WHERE skill_id=?").run(skillId);
      return { archived: true };
    }

    // check whether it was already archived before (still counts as success / idempotent)
    const checkWhere = teamId
      ? "skill_id=? AND team_id=? AND is_head=1 AND status='archived'"
      : "skill_id=? AND is_head=1 AND status='archived'";
    const checkArgs = teamId ? [skillId, teamId] : [skillId];
    const exists = this.db.prepare(`SELECT 1 FROM skills WHERE ${checkWhere} LIMIT 1`).get(...checkArgs);
    return { archived: !!exists };
  }

  // ────────────────────────────────────────────────────────────────────
  //  getHead / getByVersion / listVersions
  // ────────────────────────────────────────────────────────────────────
  /**
   * Get the current head, forcing `status='active'`. An archived skill is treated as nonexistent.
   *
   * Aligned with the semantics of the TCVDB side's `_getHeadAsync` (whose filter always carries `status="active"`).
   * To get an archived row use {@link getHeadIncludingArchived}.
   */
  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    if (teamId) {
      const raw = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND team_id=? AND is_head=1 AND status='active' LIMIT 1")
        .get(skillId, teamId) as SkillRowRaw | undefined;
      return raw ? toSkill(raw) : null;
    }
    const raw = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? AND is_head=1 AND status='active' LIMIT 1")
      .get(skillId) as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  /**
   * Get the current head regardless of status. For delete idempotent readback / compensation tasks / the admin console only.
   * Ordinary read/write paths **should not** call this method.
   */
  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    if (teamId) {
      const raw = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND team_id=? AND is_head=1 LIMIT 1")
        .get(skillId, teamId) as SkillRowRaw | undefined;
      return raw ? toSkill(raw) : null;
    }
    const raw = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? AND is_head=1 LIMIT 1")
      .get(skillId) as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    if (teamId) {
      const raw = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND version=? AND team_id=? LIMIT 1")
        .get(skillId, version, teamId) as SkillRowRaw | undefined;
      return raw ? toSkill(raw) : null;
    }
    const raw = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? AND version=? LIMIT 1")
      .get(skillId, version) as SkillRowRaw | undefined;
    return raw ? toSkill(raw) : null;
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<Skill[]> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);
    if (teamId) {
      const rows = this.db
        .prepare("SELECT * FROM skills WHERE skill_id=? AND team_id=? ORDER BY version DESC LIMIT ? OFFSET ?")
        .all(skillId, teamId, limit, offset) as SkillRowRaw[];
      return rows.map(toSkill);
    }
    const rows = this.db
      .prepare("SELECT * FROM skills WHERE skill_id=? ORDER BY version DESC LIMIT ? OFFSET ?")
      .all(skillId, limit, offset) as SkillRowRaw[];
    return rows.map(toSkill);
  }

  /** Total number of versions under this skill_id (team_id optional filter). */
  async countVersions(skillId: string, teamId?: string): Promise<number> {
    if (teamId) {
      const row = this.db
        .prepare("SELECT COUNT(*) AS c FROM skills WHERE skill_id=? AND team_id=?")
        .get(skillId, teamId) as { c: number };
      return row.c;
    }
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM skills WHERE skill_id=?")
      .get(skillId) as { c: number };
    return row.c;
  }

  // ────────────────────────────────────────────────────────────────────
  //  listSkills
  // ────────────────────────────────────────────────────────────────────
  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    const status = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    const where: string[] = ["is_head=1"];
    const args: unknown[] = [];

    // four IDs: filter if passed, no restriction if not
    if (opts.team_id) {
      where.push("team_id=?");
      args.push(opts.team_id);
    }
    if (opts.owner_agent_id) {
      where.push("owner_agent_id=?");
      args.push(opts.owner_agent_id);
    }
    if (opts.user_id) {
      where.push("user_id=?");
      args.push(opts.user_id);
    }
    if (opts.task_id) {
      where.push("task_id=?");
      args.push(opts.task_id);
    }

    where.push(`status IN (${status.map(() => "?").join(",")})`);
    args.push(...status);

    if (opts.name_prefix) {
      where.push("name LIKE ?");
      args.push(`${opts.name_prefix}%`);
    }

    const whereSql = where.join(" AND ");

    const totalRow = this.db.prepare(`SELECT COUNT(*) AS c FROM skills WHERE ${whereSql}`).get(...args) as { c: number };
    const rows = this.db
      .prepare(`SELECT * FROM skills WHERE ${whereSql} ORDER BY updated_at_ms DESC LIMIT ? OFFSET ?`)
      .all(...args, limit, offset) as SkillRowRaw[];

    return { items: rows.map(toSkill), total: totalRow.c };
  }

  // ────────────────────────────────────────────────────────────────────
  //  searchSkills (BM25 implementation only; the vec part is composed by the hybrid caller)
  // ────────────────────────────────────────────────────────────────────
  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const query = (opts.query ?? "").trim();
    if (!query) return [];

    // mode passthrough: the current store implements only the BM25 path.
    // - 'bm25' / omitted  → go straight to BM25 (default)
    // - 'embedding' / 'hybrid' but vec is unavailable or queryEmbedding not given → degrade to BM25 + one warn
    // The real hybrid (RRF) / pure vec path is a follow-up item; at the contract level mode is not silently swallowed.
    const requestedMode = opts.mode ?? "bm25";
    const wantsVec = requestedMode === "embedding" || requestedMode === "hybrid";
    if (wantsVec && (!this.vecAvailable || !opts.queryEmbedding)) {
      this.logger?.warn(
        `[skill-store] search mode='${requestedMode}' downgraded to 'bm25' ` +
          `(vec_available=${this.vecAvailable}, has_embedding=${!!opts.queryEmbedding})`,
      );
    }
    // the pure embedding path is not yet implemented → still falls back to BM25; hybrid likewise falls back to BM25 (RRF fusion later).

    // FTS5 query: use buildFtsQuery (the same jieba tokenization + quote wrapping + OR joining as L0/L1).
    // jieba cutForSearch handles Chinese tokenization correctly; falls back to Unicode regex splitting.
    // Each token is wrapped in double quotes, to prevent FTS5 reserved words (AND/OR/NOT/NEAR) from being misparsed as boolean operators.
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];

    // FTS5 snippet(table, col, prefix, suffix, ellipsis, tokenCount)
    // col=2 → skill_fts.content (DDL column order: name=0, description=1, content=2, skill_id=3, team_id=4, owner_agent_id=5, task_id=6, user_id=7).
    // 16-token snippet, with <mark> highlighting.
    //
    // the four IDs are filtered directly at the FTS5 layer (added if passed), avoiding the inefficient path of searching the full set first and then looking up to filter.
    let ftsRows: Array<{ skill_id: string; bm25: number; snippet: string }>;
    try {
      const ftsArgs: Array<string | number> = [ftsQuery];
      let ftsWhere = "skill_fts MATCH ?";
      if (opts.team_id) {
        ftsWhere += " AND team_id=?";
        ftsArgs.push(opts.team_id);
      }
      if (opts.agent_id) {
        ftsWhere += " AND owner_agent_id=?";
        ftsArgs.push(opts.agent_id);
      }
      if (opts.task_id) {
        ftsWhere += " AND task_id=?";
        ftsArgs.push(opts.task_id);
      }
      if (opts.user_id) {
        ftsWhere += " AND user_id=?";
        ftsArgs.push(opts.user_id);
      }
      ftsArgs.push(topK * 2);
      ftsRows = this.db
        .prepare(
          `SELECT skill_id,
                  bm25(skill_fts) AS bm25,
                  snippet(skill_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet
           FROM skill_fts
           WHERE ${ftsWhere}
           ORDER BY bm25 LIMIT ?`,
        )
        .all(...ftsArgs) as Array<{ skill_id: string; bm25: number; snippet: string }>;
    } catch (e) {
      this.logger?.warn(`[skill-store] fts query failed: ${(e as Error).message}`);
      return [];
    }

    // look up the main table: verify is_head=1 AND status='active' (FTS5 does not have these two fields)
    const hits: Array<{ skill: Skill; score: number; snippet: string }> = [];
    for (const r of ftsRows) {
      const row = this.db
        .prepare(
          `SELECT * FROM skills WHERE skill_id=? AND is_head=1 AND status='active' LIMIT 1`,
        )
        .get(r.skill_id) as SkillRowRaw | undefined;
      if (!row) continue;
      // smaller bm25 means more relevant → convert to a score where larger is better
      hits.push({
        skill: toSkill(row),
        score: -r.bm25,
        snippet: r.snippet ?? "",
      });
      if (hits.length >= topK) break;
    }
    return hits;
  }

  // ────────────────────────────────────────────────────────────────────
  //  TTL cleanup
  // ────────────────────────────────────────────────────────────────────

  /** Query expired non-head versions with created_at_ms < cutoffMs. */
  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    const rows = this.db
      .prepare(
        `SELECT skill_id, version, is_head, status, storage_dir, created_at_ms
         FROM skills WHERE is_head=0 AND status='active' AND created_at_ms < ?
         ORDER BY skill_id ASC, version ASC`,
      )
      .all(cutoffMs) as Array<{
        skill_id: string;
        version: number;
        is_head: number;
        status: string;
        storage_dir: string;
        created_at_ms: number;
      }>;
    return rows.map((r) => ({
      skill_id: r.skill_id,
      version: r.version,
      is_head: r.is_head === 1,
      status: r.status as SkillStatus,
      storage_dir: r.storage_dir,
      created_at_ms: r.created_at_ms,
    }));
  }

  /** Physically delete the specified version row (is_head=0 safety lock only). */
  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    const r = this.db
      .prepare("DELETE FROM skills WHERE skill_id=? AND version=? AND is_head=0")
      .run(skillId, version);
    return (r.changes ?? 0) > 0;
  }

  /**
   * Physically delete all version rows under the same skill_id (including head + archived) + clear fts / vec.
   * Returns the number of rows actually deleted. `SkillCore.delete` goes through this path; permission checks are the caller's responsibility.
   */
  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    const where = teamId ? "skill_id=? AND team_id=?" : "skill_id=?";
    const args: unknown[] = teamId ? [skillId, teamId] : [skillId];
    const r = this.db.prepare(`DELETE FROM skills WHERE ${where}`).run(...args);
    const changes = r.changes ?? 0;
    // DELETE the auxiliary tables only when the main table actually deleted rows — avoids wrongly clearing fts when cross-team validation fails
    if (changes > 0) {
      try {
        this.db.prepare("DELETE FROM skill_fts WHERE skill_id=?").run(skillId);
      } catch {
        // fts may already have been cleared by archiveHead; the second delete is idempotent
      }
      if (this.vecAvailable) {
        try {
          this.db.prepare("DELETE FROM skill_vec WHERE skill_id=?").run(skillId);
        } catch {
          /* non-fatal */
        }
      }
    }
    return changes;
  }

  // ────────────────────────────────────────────────────────────────────
  //  Embedding maintenance
  // ────────────────────────────────────────────────────────────────────
  upsertEmbedding(skillId: string, embedding: Float32Array): void {
    if (!this.vecAvailable) return;
    if (embedding.length !== this.dimensions) {
      this.logger?.warn(`[skill-store] embedding dim mismatch: ${embedding.length} vs ${this.dimensions}`);
      return;
    }
    try {
      this.db.prepare("DELETE FROM skill_vec WHERE skill_id=?").run(skillId);
      this.db.prepare("INSERT INTO skill_vec (skill_id, embedding) VALUES (?, ?)").run(skillId, Buffer.from(embedding.buffer));
    } catch (e) {
      this.logger?.warn(`[skill-store] upsertEmbedding failed: ${(e as Error).message}`);
    }
  }

  deleteEmbedding(skillId: string): void {
    if (!this.vecAvailable) return;
    try {
      this.db.prepare("DELETE FROM skill_vec WHERE skill_id=?").run(skillId);
    } catch (e) {
      this.logger?.warn(`[skill-store] deleteEmbedding failed: ${(e as Error).message}`);
    }
  }
}
