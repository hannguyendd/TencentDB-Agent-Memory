/**
 * TcvdbSkillStore — TCVDB (Service mode) implementation of the Skill storage layer
 *
 * Implements the ISkillStore interface, providing VDB persistence for skill metadata/content.
 * Mirrors the 12 methods of SqliteSkillStore, following TcvdbMemoryStore's
 * Collection creation / upsert / query / search / hybridSearch patterns.
 *
 * Schema: see docs/design/2026-06-29-skill-vdb-schema.md
 * Interface:   src/core/skill/skill-store.interface.ts
 */

import { randomBase62 } from "../../../utils/short-id.js";
import { TcvdbClient, TcvdbApiError, type QueryResponse } from "./client.js";
import type { BM25LocalEncoder } from "../bm25-local.js";
import type { SparseVector } from "@tencentdb-agent-memory/tcvdb-text";
import type { StoreLogger } from "../types.js";
import type {
  ISkillStore,
  SkillStoreCapabilities,
  SkillSearchResult,
  ExpiredVersionMeta,
} from "../../skill/skill-store.interface.js";
import type {
  AppendVersionInput,
  ListSkillsOptions,
  SearchSkillsOptions,
  Skill,
  SkillManifestEntry,
  SkillStatus,
} from "../../skill/types.js";
import { SkillStoreError } from "../../skill/skill-store.interface.js";

// ─── Config ─────────────────────────────────────────────────────────────

export interface TcvdbSkillStoreConfig {
  /** VDB instance URL */
  url: string;
  /** Account name (default "root") */
  username: string;
  /** API Key */
  apiKey: string;
  /** Database name */
  database: string;
  /** Embedding model name (shared with L1: "bge-large-zh") */
  embeddingModel: string;
  /** Request timeout in ms */
  timeout: number;
  /** CA certificate path */
  caPemPath?: string;
  logger?: StoreLogger;
  /** BM25 encoder (shared instance) */
  bm25Encoder?: BM25LocalEncoder;
  /** Injected ulid factory */
  ulid?: () => string;
  /** Injected now */
  now?: () => number;
}

// ─── Constants ──────────────────────────────────────────────────────────

const TAG = "[tcvdb-skill-store]";
const SKILLS_COLLECTION_SUFFIX = "_skills";

/** VDB dense vector index (DISK_FLAT, HNSW fallback) */
const VECTOR_INDEX_DISK_FLAT: Record<string, unknown> = {
  fieldName: "vector",
  fieldType: "vector",
  indexType: "DISK_FLAT",
  dimension: 1024,
  metricType: "COSINE",
  params: { M: 16, efConstruction: 200 },
};
const VECTOR_INDEX_HNSW: Record<string, unknown> = {
  fieldName: "vector",
  fieldType: "vector",
  indexType: "HNSW",
  dimension: 1024,
  metricType: "COSINE",
  params: { M: 16, efConstruction: 200 },
};

/** Fields returned by queries (all, except vector/sparse_vector) */
const SKILL_OUTPUT_FIELDS: string[] = [
  "id", "skill_id", "version", "is_head",
  "team_id", "owner_agent_id", "user_id", "task_id",
  "name", "description", "content", "content_hash",
  "manifest_json", "storage_dir", "status", "metadata_json",
  "created_at_ms", "updated_at_ms",
];

/** Vector field names (VDB internal names) */
const DENSE_VECTOR_FIELD = "vector";
const SPARSE_VECTOR_FIELD = "sparse_vector";

// ─── Ulid helpers ───────────────────────────────────────────────────────

// row_id generator — the physical primary key of a VDB doc (the `id` primaryKey field).
// Separate from skill_id: skill_id is shared across versions, row_id is unique per row.
// base62 12 characters (~71 bits of CSPRNG true entropy).
function defaultUlid(): string {
  return randomBase62(12);
}

// ─── Error helpers ──────────────────────────────────────────────────────

function isDiskFlatUnsupported(err: unknown): boolean {
  if (!(err instanceof TcvdbApiError)) return false;
  if (err.apiCode === 15113) return true;
  const msg = err.message.toLowerCase();
  return msg.includes("disk_flat") && msg.includes("not support");
}

// ─── Implementation ─────────────────────────────────────────────────────

export class TcvdbSkillStore implements ISkillStore {
  private readonly client: TcvdbClient;
  private readonly skillsCollection: string;
  private readonly embeddingModel: string;
  private readonly logger?: StoreLogger;
  private readonly bm25Encoder?: BM25LocalEncoder;
  private readonly ulid: () => string;
  private readonly now: () => number;

  private degraded = false;
  private initPromise?: Promise<void>;
  private initialized = false;

  constructor(config: TcvdbSkillStoreConfig) {
    this.client = new TcvdbClient({
      url: config.url,
      username: config.username,
      apiKey: config.apiKey,
      database: config.database,
      timeout: config.timeout,
      caPemPath: config.caPemPath,
    });
    this.skillsCollection = `${config.database}${SKILLS_COLLECTION_SUFFIX}`;
    this.embeddingModel = config.embeddingModel;
    this.logger = config.logger;
    this.bm25Encoder = config.bm25Encoder;
    this.ulid = config.ulid ?? defaultUlid;
    this.now = config.now ?? (() => Date.now());
  }

  // ── ISkillStore: lifecycle ─────────────────────────────────────────────

  init(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.initPromise = this._initAsync().catch((err) => {
      this.logger?.error(`${TAG} Init failed: ${err instanceof Error ? err.message : String(err)}`);
      this.degraded = true;
    });
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  getCapabilities(): SkillStoreCapabilities {
    return {
      vectorSearch: !this.degraded,
      ftsSearch: !!this.bm25Encoder && !this.degraded,
      nativeHybridSearch: !!this.bm25Encoder && !this.degraded,
      sparseVectors: !!this.bm25Encoder,
    };
  }

  close(): void {
    this.degraded = true;
  }

  // ── ISkillStore: CRUD ─────────────────────────────────────────────────

  async appendVersion(input: AppendVersionInput): Promise<Skill> {
    await this._ensureInit();
    if (this.degraded) throw new Error("TcvdbSkillStore degraded");

    const tid = input.team_id ?? "default";
    const sid = input.skill_id;

    // 1. look up the old head
    const head = await this._getHeadAsync(sid, tid);

    // 2. Name uniqueness check (no head → new skill, check for a duplicate name)
    if (!head) {
      await this._assertNameUnique(input.name, tid, input.owner_agent_id ?? "default", sid);
    } else {
      // there is already history → name is immutable
      if (head.name !== input.name) {
        throw new SkillStoreError("SKILL_NAME_DUPLICATE", "name change is not allowed across versions");
      }
    }

    // 3. version uniqueness check
    const newVersion = head ? head.version + 1 : 1;
    const existing = await this._queryOneAsync(
      `skill_id="${this._escape(sid)}" and version=${newVersion} and team_id="${this._escape(tid)}"`,
    );
    if (existing) {
      // the same version already exists → idempotent return
      return existing;
    }

    const ownerForRow = head ? head.owner_agent_id : (input.owner_agent_id ?? "default");
    const userIdForRow = input.user_id ?? "default";
    const ts = this.now();
    const rowId = this.ulid();
    const storageDir = `skills/${sid}/v${newVersion}`;

    // 4. build the new row document
    const doc: Record<string, unknown> = {
      id: rowId,
      skill_id: sid,
      version: newVersion,
      is_head: 1,
      team_id: tid,
      owner_agent_id: ownerForRow,
      user_id: userIdForRow,
      task_id: input.task_id ?? "default",
      name: input.name,
      description: input.description,
      content: input.content,
      content_hash: input.content_hash,
      manifest_json: JSON.stringify(input.manifest ?? []),
      storage_dir: storageDir,
      status: "active",
      metadata_json: input.metadata_json ?? "{}",
      created_at_ms: ts,
      updated_at_ms: ts,
    };

    // 5. BM25 sparse vector encoding
    if (this.bm25Encoder) {
      const sparse = this.bm25Encoder.encodeTexts([input.content]);
      if (sparse.length > 0 && sparse[0] && sparse[0].length > 0) {
        doc[SPARSE_VECTOR_FIELD] = sparse[0];
      }
    }

    // 6. INSERT the new row first (compensating for VDB's lack of transactions: land the new row first, flip the old row afterwards)
    await this.client.upsert(this.skillsCollection, [doc]);

    // 7. CAS-flip the old head — fixes the concurrent dirty-write incident of 2026-09-02.
    //
    // The original implementation was a three-step "read → merge → upsert" with no lock in between — within a single extract task the LLM, in one turn via the
    // Vercel AI SDK, concurrently issued N skill_patch(expected_version=N) calls, all of which read
    // head=vN, all passed the in-memory assertVersionFresh, and all reached step 6 and landed new rows, leaving 5 rows
    // (skill_id, version=N+1, is_head=1) alive together, so listSkills(is_head=1) afterwards returned
    // the same skill_id N times.
    //
    // Now it is changed to VDB /document/update's server-side atomic CAS: the filter precisely specifies "the old head
    // I expect" (skill_id + team_id + version=old + is_head=1), only the first writer to arrive
    // gets affectedCount=1, and all later ones get affectedCount=0. The latter are losers,
    // who immediately DELETE the orphan new row just landed in step 6 to restore state, and throw SKILL_VERSION_STALE so that
    // the upper-level caller (skill-versioning also cleans the COS directory) and the LLM (which, on getting the error, retries with the new version number)
    // handle it per optimistic-lock semantics.
    if (head) {
      let affected = 0;
      try {
        affected = await this.client.update(this.skillsCollection, {
          filter:
            `skill_id="${this._escape(sid)}" and team_id="${this._escape(tid)}" ` +
            `and version=${head.version} and is_head=1`,
          update: { is_head: 0 },
        });
      } catch (err) {
        // A network/VDB jitter left the CAS state unknown — we cannot rashly act as a loser and delete our own row (what if the CAS actually
        // succeeded?), nor rashly act as a winner (what if someone else won first?). Keep the original behavior: log a warn,
        // let the write path return normally, and the double head is resolved by listSkills' version DESC fallback.
        this.logger?.warn(
          `${TAG} Head-flip CAS request failed for ${sid} v${head.version}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
        return this._docToSkill(doc);
      }

      if (affected === 0) {
        // loser branch: we lost the CAS. The v=(head+1) just landed in step 6 is an "orphan" and must be cleaned
        // so that listSkills keeps a single head. DELETE locates by primary key via documentIds, precisely
        // deleting only our own row, without harming a concurrent winner's same-version sibling row.
        try {
          await this.client.deleteDoc(this.skillsCollection, {
            query: { documentIds: [rowId] },
          });
        } catch (delErr) {
          // Orphan cleanup failed: briefly there will be an extra row v=(head+1) with is_head=1 on the field, but because its timestamp is earlier than the winner's,
          // listSkills ordered by updated_at_ms DESC will pick the winner. Leave a warn
          // for ops/reconciler to really delete as a fallback.
          this.logger?.warn(
            `${TAG} Head-flip CAS lost race for ${sid} v${newVersion}, but orphan cleanup failed: ` +
              (delErr instanceof Error ? delErr.message : String(delErr)),
          );
        }
        throw new SkillStoreError(
          "SKILL_VERSION_STALE",
          `head advanced under append(skill_id=${sid}, expected_head_version=${head.version})`,
        );
      }
    }

    return this._docToSkill(doc);
  }

  async getHead(skillId: string, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    return this._getHeadAsync(skillId, teamId);
  }

  /**
   * Internal use: get the current head without filtering status. An archived head is also returned.
   * Consistent with the semantics of `SqliteSkillStore.getHeadIncludingArchived`.
   * For `SkillCore.delete` idempotent readback, asset compensation tasks, and the admin console.
   */
  async getHeadIncludingArchived(skillId: string, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    return this._getHeadAsync(skillId, teamId, { includeArchived: true });
  }

  async getByVersion(skillId: string, version: number, teamId?: string): Promise<Skill | null> {
    await this._ensureInit();
    if (this.degraded) return null;

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and version=${version} and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}" and version=${version}`;

    return this._queryOneAsync(filter);
  }

  async archiveHead(skillId: string, teamId?: string): Promise<{ archived: boolean }> {
    await this._ensureInit();
    if (this.degraded) return { archived: false };

    const head = await this._getHeadAsync(skillId, teamId);
    if (!head) return { archived: false };

    try {
      await this._updateDocAsync(head.row_id, {
        status: "archived",
        updated_at_ms: this.now(),
      } as Record<string, unknown>);
      return { archived: true };
    } catch (err) {
      this.logger?.warn(`${TAG} archiveHead failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
      return { archived: false };
    }
  }

  // ── ISkillStore: queries ─────────────────────────────────────────────────

  async listSkills(opts: ListSkillsOptions): Promise<{ items: Skill[]; total: number }> {
    await this._ensureInit();
    if (this.degraded) return { items: [], total: 0 };

    const conditions: string[] = ["is_head=1"];
    if (opts.team_id) conditions.push(`team_id="${this._escape(opts.team_id)}"`);
    if (opts.owner_agent_id) conditions.push(`owner_agent_id="${this._escape(opts.owner_agent_id)}"`);
    if (opts.user_id) conditions.push(`user_id="${this._escape(opts.user_id)}"`);
    if (opts.task_id) conditions.push(`task_id="${this._escape(opts.task_id)}"`);

    const statuses = opts.status?.length ? opts.status : (["active"] as SkillStatus[]);
    if (statuses.length === 1) {
      conditions.push(`status="${this._escape(statuses[0])}"`);
    } else {
      // VDB does not support `IN (...)` syntax, only `OR`; expand with `(status="a" or status="b")`.
      // Using IN before failed silently (VDB returned code=14000), causing status=["active","archived"] to return empty.
      conditions.push(
        `(${statuses.map((s) => `status="${this._escape(s)}"`).join(" or ")})`,
      );
    }

    const filter = conditions.join(" and ");
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const offset = Math.max(opts.offset ?? 0, 0);

    // name_prefix: the VDB filter syntax does not support LIKE / string prefix matching,
    // so instead pull the head rows matching the other conditions, then do prefix filtering in memory and paginate.
    // (the number of head rows is small; a one-time pull with a cap of 1000 is acceptable)
    if (opts.name_prefix) {
      const prefix = opts.name_prefix;
      try {
        const resp = await this.client.query(this.skillsCollection, {
          filter,
          limit: 1000,
          outputFields: SKILL_OUTPUT_FIELDS,
          sort: [{ fieldName: "updated_at_ms", direction: "desc" }],
        });
        const filtered = (resp.documents ?? [])
          .map((d) => this._docToSkill(d))
          .filter((s) => s.name.startsWith(prefix));
        // 2026-09-02 auto-heal: dedup after prefix filtering, ensuring the UI sees only winners
        const deduped = this._autoHealListSkills(filtered);
        return { items: deduped.slice(offset, offset + limit), total: deduped.length };
      } catch (err) {
        this.logger?.warn(`${TAG} listSkills(name_prefix) query failed: ${err instanceof Error ? err.message : String(err)}`);
        return { items: [], total: 0 };
      }
    }

    let total: number;
    try {
      total = await this.client.count(this.skillsCollection, filter);
    } catch {
      total = 0;
    }

    let rows: Skill[] = [];
    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit,
        offset,
        outputFields: SKILL_OUTPUT_FIELDS,
        sort: [{ fieldName: "updated_at_ms", direction: "desc" }],
      });
      rows = (resp.documents ?? []).map((d) => this._docToSkill(d));
    } catch (err) {
      this.logger?.warn(`${TAG} listSkills query failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2026-09-02 auto-heal: application-layer group-by skill_id to pick winners + fire-and-forget
    // demote of losers. Historical dirty data (multiple rows with is_head=1 for the same skill_id) self-heals on a single UI refresh.
    // See the _autoHealListSkills comment for details.
    const deduped = this._autoHealListSkills(rows);
    // total correction: physical rows on this page - the number of losers removed on this page. Slightly off when pagination crosses a dirty group; after fire-and-forget
    // completes + the VDB filter index refreshes, the next read converges automatically.
    const adjustedTotal = Math.max(0, total - (rows.length - deduped.length));
    return { items: deduped, total: adjustedTotal };
  }

  async searchSkills(opts: SearchSkillsOptions): Promise<SkillSearchResult[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const topK = Math.min(Math.max(opts.topK ?? 10, 1), 50);
    const filter = this._buildSearchFilter(opts);
    const mode = opts.mode ?? "bm25";

    try {
      if (mode === "hybrid" && this.bm25Encoder) {
        return this._searchHybridAsync(opts.query, topK, filter);
      }
      if (mode === "embedding") {
        return this._searchEmbeddingAsync(opts.query, topK, filter);
      }
      // bm25 (default)
      return this._searchBm25Async(opts.query, topK, filter);
    } catch (err) {
      this.logger?.warn(`${TAG} searchSkills failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async listVersions(
    skillId: string,
    teamId?: string,
    pagination?: { limit?: number; offset?: number },
  ): Promise<Skill[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}"`;

    const limit = Math.min(Math.max(pagination?.limit ?? 50, 1), 1000);
    const offset = Math.max(pagination?.offset ?? 0, 0);

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit,
        offset,
        outputFields: SKILL_OUTPUT_FIELDS,
        sort: [{ fieldName: "version", direction: "desc" }],
      });
      return (resp.documents ?? []).map((d) => this._docToSkill(d));
    } catch (err) {
      this.logger?.warn(`${TAG} listVersions query failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async countVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) return 0;

    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
      : `skill_id="${this._escape(skillId)}"`;

    try {
      return await this.client.count(this.skillsCollection, filter);
    } catch {
      return 0;
    }
  }

  // ── ISkillStore: TTL Cleanup ─────────────────────────────────────────

  async findExpiredVersions(cutoffMs: number): Promise<ExpiredVersionMeta[]> {
    await this._ensureInit();
    if (this.degraded) return [];

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter: `is_head=0 and status="active" and created_at_ms<${cutoffMs}`,
        limit: 10000,
        outputFields: ["skill_id", "version", "is_head", "status", "storage_dir", "created_at_ms"],
        // VDB requires the sort field to be uint64; skill_id is a string and cannot be sorted (code 15143).
        // Use created_at_ms ascending (clean the oldest first), consistent with TTL cleanup semantics.
        sort: [{ fieldName: "created_at_ms", direction: "asc" }],
      });
      return (resp.documents ?? []).map((d) => ({
        skill_id: d.skill_id as string,
        version: d.version as number,
        is_head: (d.is_head as number) === 1,
        status: d.status as SkillStatus,
        storage_dir: d.storage_dir as string,
        created_at_ms: d.created_at_ms as number,
      }));
    } catch (err) {
      this.logger?.warn(`${TAG} findExpiredVersions failed: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    }
  }

  async deleteVersion(skillId: string, version: number): Promise<boolean> {
    await this._ensureInit();
    if (this.degraded) return false;

    try {
      const filter = `skill_id="${this._escape(skillId)}" and version=${version} and is_head=0`;
      const affected = await this.client.deleteDoc(this.skillsCollection, { query: { filter } });
      return affected > 0;
    } catch (err) {
      this.logger?.warn(`${TAG} deleteVersion failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Physically delete all version rows under the same skill_id. `SkillCore.delete` goes through this path.
   * Permission checks are the responsibility of the caller SkillCore; this method does a single deleteDoc by (skill_id, team_id) only.
   */
  async deleteAllVersions(skillId: string, teamId?: string): Promise<number> {
    await this._ensureInit();
    if (this.degraded) return 0;

    try {
      const filter = teamId
        ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}"`
        : `skill_id="${this._escape(skillId)}"`;
      const affected = await this.client.deleteDoc(this.skillsCollection, { query: { filter } });
      return affected;
    } catch (err) {
      this.logger?.warn(`${TAG} deleteAllVersions failed for ${skillId}: ${err instanceof Error ? err.message : String(err)}`);
      return 0;
    }
  }

  // ─── Private: Init ────────────────────────────────────────────────────

  private async _initAsync(): Promise<void> {
    try {
      const dbCreated = await this.client.createDatabase();
      if (dbCreated) {
        this.logger?.debug?.(`${TAG} Database created, waiting 5s...`);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    } catch (err) {
      if (err instanceof TcvdbApiError && err.apiCode === 15201) {
        this.logger?.debug?.(`${TAG} Database already exists (benign)`);
      } else {
        throw err;
      }
    }

    // Create skills collection with DISK_FLAT → HNSW fallback
    await this._createCollectionWithVectorFallback(
      {
        collection: this.skillsCollection,
        shardNum: 1,
        replicaNum: 2,
        description: "Skill storage",
        embedding: {
          status: "enabled",
          field: "content",
          vectorField: DENSE_VECTOR_FIELD,
          model: this.embeddingModel,
        },
      },
      [
        { fieldName: "skill_id",       fieldType: "string", indexType: "filter" },
        { fieldName: "version",        fieldType: "uint64", indexType: "filter" },
        { fieldName: "is_head",        fieldType: "uint64", indexType: "filter" },
        { fieldName: "team_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "owner_agent_id", fieldType: "string", indexType: "filter" },
        { fieldName: "user_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "task_id",        fieldType: "string", indexType: "filter" },
        { fieldName: "name",           fieldType: "string", indexType: "filter" },
        { fieldName: "status",         fieldType: "string", indexType: "filter" },
        { fieldName: "created_at_ms",  fieldType: "uint64", indexType: "filter" },
        { fieldName: "updated_at_ms",  fieldType: "uint64", indexType: "filter" },
      ],
    );

    this.logger?.info(`${TAG} Initialized: collection=${this.skillsCollection}, model=${this.embeddingModel}`);
  }

  private async _createCollectionWithVectorFallback(
    params: Record<string, unknown>,
    filterIndexes: Array<Record<string, unknown>>,
  ): Promise<void> {
    const buildIndexes = (vectorIndex: Record<string, unknown>) => [
      { fieldName: "id", fieldType: "string", indexType: "primaryKey" },
      vectorIndex,
      { fieldName: SPARSE_VECTOR_FIELD, fieldType: "sparseVector", indexType: "inverted", metricType: "IP", diskSwapEnabled: true },
      ...filterIndexes,
    ];

    try {
      await this.client.createCollection({ ...params, indexes: buildIndexes(VECTOR_INDEX_DISK_FLAT) });
    } catch (err) {
      if (isDiskFlatUnsupported(err)) {
        this.logger?.debug?.(`${TAG} DISK_FLAT not supported, falling back to HNSW`);
        await this.client.createCollection({ ...params, indexes: buildIndexes(VECTOR_INDEX_HNSW) });
      } else {
        throw err;
      }
    }
  }

  private async _ensureInit(): Promise<void> {
    if (this.initPromise) {
      try { await this.initPromise; } catch { /* degraded already set */ }
    }
  }

  // ─── Private: Query helpers ───────────────────────────────────────────

  /**
   * Look up the head row. By default forces `status="active"`; with `includeArchived=true` no status filter is added,
   * for use by `getHeadIncludingArchived` (idempotent readback of an archived head / compensation tasks).
   *
   * 2026-09-02 read-time auto-heal: raised from limit=1 to 100, to detect multi-head dirty data
   * for the same skill_id (a leftover of the append-race); the application layer picks a winner + fire-and-forget demotes
   * the other losers. See the _pickHeadAndAutoHeal comment.
   */
  private async _getHeadAsync(
    skillId: string,
    teamId?: string,
    opts?: { includeArchived?: boolean },
  ): Promise<Skill | null> {
    const statusClause = opts?.includeArchived ? "" : ' and status="active"';
    const filter = teamId
      ? `skill_id="${this._escape(skillId)}" and team_id="${this._escape(teamId)}" and is_head=1${statusClause}`
      : `skill_id="${this._escape(skillId)}" and is_head=1${statusClause}`;

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        // A clean skill has only 1 row; the largest observed in production for a dirty skill is 5 rows, and 100 is a defensive upper bound.
        // It also ensures the tiebreaker below still has a deterministic winner under extreme dirty data.
        limit: 100,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      const rows = (resp.documents ?? []).map((d) => this._docToSkill(d));
      return this._pickHeadAndAutoHeal(rows);
    } catch (err) {
      this.logger?.warn(`${TAG} getHead failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }


  // ─── Read-time auto-heal (2026-09-02) ────────────────────────────────
  // Handle historical dirty data of "multiple heads is_head=1 for the same skill_id" (a leftover of the append-race).
  // On every head read / list: detect + pick a winner + fire-and-forget demote the losers.
  // - winner selection is fully deterministic: version DESC → updated_at_ms DESC → row_id ASC.
  //   The last row_id tier ensures concurrent readers pick the same winner, so their demote sets
  //   do not conflict, and convergence is unambiguous.
  // - demote locates precisely via documentIds, unaffected by filter expressions under timestamp ties / VDB
  //   filter-index async refresh.
  // - on failure (network/VDB jitter) only warn; the main flow returns the winner unimpeded; the next read will detect
  //   and retry again, converging idempotently.
  //
  // TTL fallback: a loser becomes (v=N, is_head=0), and as later versions advance → when v=N falls out of the
  // KEEP_RECENT protection window + time passes the cutoff, deleteVersion(sid, N) deletes
  // all (skill_id=X, version=N, is_head=0) rows at once (the winner has also been demoted by then), fully
  // converging. In the extreme scenario (the skill never changes again) the loser stays on disk, but enters no read view.

  /**
   * Pick a winner from the is_head=1 candidate rows and fire-and-forget demote the other rows.
   * Input usually comes from the query results with filter `is_head=1 and ...`.
   * Empty input returns null; a single-row input is returned directly without triggering an update.
   */
  private _pickHeadAndAutoHeal(rows: Skill[]): Skill | null {
    if (rows.length === 0) return null;
    if (rows.length === 1) return rows[0];

    const sorted = [...rows].sort((a, b) => {
      if (a.version !== b.version) return b.version - a.version;
      if (a.updated_at_ms !== b.updated_at_ms) return b.updated_at_ms - a.updated_at_ms;
      return a.row_id < b.row_id ? -1 : a.row_id > b.row_id ? 1 : 0;
    });
    const winner = sorted[0]!;
    const loserRowIds = sorted.slice(1).map((r) => r.row_id).filter((id) => !!id);

    this.logger?.warn(
      `${TAG} dirty-head auto-heal: skill_id=${winner.skill_id} keeps row_id=${winner.row_id} ` +
        `v${winner.version} ts=${winner.updated_at_ms}, demoting ${loserRowIds.length} loser(s)`,
    );

    if (loserRowIds.length > 0) {
      // fire-and-forget: the main read path does not wait for the demote to finish; on failure only warn, and the next read makes it up.
      this.client
        .update(this.skillsCollection, {
          documentIds: loserRowIds,
          update: { is_head: 0 },
        })
        .catch((err) => {
          this.logger?.warn(
            `${TAG} auto-heal demote failed for skill_id=${winner.skill_id}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        });
    }

    return winner;
  }

  /**
   * Group-by skill_id on the listSkills results + pick a winner per group.
   * Used by listSkills to correct the returned items and total.
   */
  private _autoHealListSkills(rows: Skill[]): Skill[] {
    if (rows.length <= 1) return rows;
    const grouped = new Map<string, Skill[]>();
    for (const r of rows) {
      const arr = grouped.get(r.skill_id);
      if (arr) arr.push(r);
      else grouped.set(r.skill_id, [r]);
    }
    // fast path: avoid an extra loop when completely clean
    if (grouped.size === rows.length) return rows;

    const winners: Skill[] = [];
    for (const group of grouped.values()) {
      const w = this._pickHeadAndAutoHeal(group);
      if (w) winners.push(w);
    }
    return winners;
  }

  /** Fetch one by filter */
  private async _queryOneAsync(filter: string): Promise<Skill | null> {
    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit: 1,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      return resp.documents && resp.documents.length > 0
        ? this._docToSkill(resp.documents[0])
        : null;
    } catch (err) {
      this.logger?.warn(`${TAG} queryOne failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── Private: Write helpers ───────────────────────────────────────────

  /** Upsert to update partial fields of a document (unspecified fields are kept) */
  private async _updateDocAsync(rowId: string, partial: Record<string, unknown>): Promise<void> {
    // VDB upsert needs the full document or at least id + the changed fields
    // first read the existing document, merge, then upsert
    const existing = await this._queryByIdAsync(rowId);
    if (!existing) return;

    const doc = this._skillToDoc(existing);
    Object.assign(doc, partial);
    await this.client.upsert(this.skillsCollection, [doc]);
  }

  /**
   * Fetch one by primary key (id / row_id).
   * Note: id is the primaryKey, not a filter index, so it cannot be queried with `filter: id="..."`
   * (VDB reports Field Not Found: id and it gets caught as null). Must use the documentIds primary-key lookup,
   * aligned with the memory production implementation (tcvdb.ts "Primary key lookup: use documentIds").
   */
  private async _queryByIdAsync(rowId: string): Promise<Skill | null> {
    try {
      const resp = await this.client.query(this.skillsCollection, {
        documentIds: [rowId],
        limit: 1,
        retrieveVector: false,
        outputFields: SKILL_OUTPUT_FIELDS,
      });
      return resp.documents && resp.documents.length > 0
        ? this._docToSkill(resp.documents[0])
        : null;
    } catch (err) {
      this.logger?.warn(`${TAG} queryById failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /** Name uniqueness check (same team + agent + name, and is_head=1 and status=active) */
  private async _assertNameUnique(
    name: string,
    teamId: string,
    ownerAgentId: string,
    excludeSkillId: string,
  ): Promise<void> {
    const filter =
      `team_id="${this._escape(teamId)}" and owner_agent_id="${this._escape(ownerAgentId)}" ` +
      `and name="${this._escape(name)}" and is_head=1 and status="active"`;

    try {
      const resp = await this.client.query(this.skillsCollection, {
        filter,
        limit: 1,
        outputFields: ["skill_id"],
      });
      if (resp.documents && resp.documents.length > 0) {
        const dupId = resp.documents[0].skill_id as string;
        if (dupId !== excludeSkillId) {
          throw new SkillStoreError("SKILL_NAME_DUPLICATE", `name '${name}' already exists for agent in team`);
        }
      }
    } catch (err) {
      if (err instanceof SkillStoreError) throw err;
      this.logger?.warn(`${TAG} name uniqueness check failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ─── Private: Search ─────────────────────────────────────────────────

  private _buildSearchFilter(opts: SearchSkillsOptions): string {
    const conditions: string[] = ["is_head=1", 'status="active"'];
    if (opts.team_id) conditions.push(`team_id="${this._escape(opts.team_id)}"`);
    if (opts.agent_id) conditions.push(`owner_agent_id="${this._escape(opts.agent_id)}"`);
    if (opts.task_id) conditions.push(`task_id="${this._escape(opts.task_id)}"`);
    if (opts.user_id) conditions.push(`user_id="${this._escape(opts.user_id)}"`);
    return conditions.join(" and ");
  }

  /**
   * bm25 mode: TCVDB has no pure sparse retrieval channel (/document/search only does dense;
   * hybridSearch's ann is required). The skill collection's server-side embedding is always on,
   * so in Service mode bm25 mode degrades to hybrid (dense + sparse),
   * semantically equivalent and with retrieval quality no weaker than pure BM25. Only standalone (SQLite) is true pure BM25.
   */
  private async _searchBm25Async(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    this.logger?.debug?.(
      `${TAG} bm25 mode on TCVDB → degrade to hybrid (server-side embedding always enabled, no pure-sparse channel)`,
    );
    return this._searchHybridAsync(queryText, topK, filter);
  }

  /**
   * embedding mode: dense-only. Goes through /document/search + embeddingItems,
   * with the VDB server embedding the query text (collection.embedding.field=content).
   * Note: /document/search does not accept ann/match; server-side embedding uses embeddingItems to pass the raw text.
   */
  private async _searchEmbeddingAsync(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    const resp = await this.client.search(this.skillsCollection, {
      embeddingItems: [queryText],
      filter,
      limit: topK,
      retrieveVector: false,
      outputFields: SKILL_OUTPUT_FIELDS,
    });

    return this._parseSearchResponse(resp, topK);
  }

  /**
   * hybrid mode: dense (server-side embedding) + sparse (BM25) + RRF fusion.
   * Aligned with the memory production implementation (tcvdb.ts searchL1HybridAsync):
   *   - ann / match are both arrays
   *   - ann.fieldName = the server-side embedding source field "content", data carries the raw query text
   *   - the query-side sparse vector uses encodeQueries (IDF weights), distinct from the write-side encodeTexts (TF)
   *   - rerank: { method: "rrf", k: 60 }
   * Without a BM25 encoder it degrades to dense-only (embedding).
   */
  private async _searchHybridAsync(
    queryText: string,
    topK: number,
    filter: string,
  ): Promise<SkillSearchResult[]> {
    const sparse = this.bm25Encoder?.encodeQueries([queryText]) ?? [];
    const sparseVec: SparseVector | undefined =
      sparse.length > 0 && sparse[0] && sparse[0].length > 0 ? sparse[0] : undefined;

    if (!sparseVec) {
      // no sparse signal → dense-only
      return this._searchEmbeddingAsync(queryText, topK, filter);
    }

    const searchParams: Record<string, unknown> = {
      filter,
      limit: topK,
      retrieveVector: false,
      outputFields: SKILL_OUTPUT_FIELDS,
      ann: [{
        fieldName: "content",
        data: [queryText],
        limit: topK * 2,
      }],
      match: [{
        fieldName: SPARSE_VECTOR_FIELD,
        data: [sparseVec],
        limit: topK * 2,
      }],
      rerank: {
        method: "rrf",
        k: 60,
      },
    };

    const resp = await this.client.hybridSearch(this.skillsCollection, searchParams);
    return this._parseSearchResponse(resp, topK);
  }

  private _parseSearchResponse(
    resp: { documents: Array<Array<Record<string, unknown>>> },
    topK: number,
  ): SkillSearchResult[] {
    const results: SkillSearchResult[] = [];
    const docs = resp.documents?.[0] ?? [];

    for (const d of docs) {
      if (results.length >= topK) break;
      const skill = this._docToSkill(d);
      const score = (d.score as number) ?? 0;
      let snippet: string | undefined;
      if (d.text !== undefined && typeof d.text === "string") {
        snippet = d.text.slice(0, 200);
      }
      results.push({ skill, score, snippet });
    }

    return results;
  }

  // ─── Private: Doc ↔ Skill mapping ─────────────────────────────────────

  private _docToSkill(doc: Record<string, unknown>): Skill {
    let manifest: SkillManifestEntry[] = [];
    try {
      const raw = doc.manifest_json as string | undefined;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) manifest = parsed;
      }
    } catch { /* ignore */ }

    return {
      row_id: (doc.id ?? doc.row_id) as string,
      skill_id: doc.skill_id as string,
      version: (doc.version as number) ?? 0,
      is_head: (doc.is_head as number) === 1,
      user_id: doc.user_id as string,
      owner_agent_id: doc.owner_agent_id as string,
      team_id: doc.team_id as string,
      task_id: doc.task_id as string,
      name: doc.name as string,
      description: doc.description as string,
      content: doc.content as string,
      content_hash: doc.content_hash as string,
      manifest,
      storage_dir: doc.storage_dir as string,
      status: (doc.status as SkillStatus) ?? "active",
      metadata_json: (doc.metadata_json as string) ?? "{}",
      created_at_ms: (doc.created_at_ms as number) ?? 0,
      updated_at_ms: (doc.updated_at_ms as number) ?? 0,
    };
  }

  /** Skill → VDB doc (for rewriting on update) */
  private _skillToDoc(skill: Skill): Record<string, unknown> {
    return {
      id: skill.row_id,
      skill_id: skill.skill_id,
      version: skill.version,
      is_head: skill.is_head ? 1 : 0,
      team_id: skill.team_id,
      owner_agent_id: skill.owner_agent_id,
      user_id: skill.user_id,
      task_id: skill.task_id,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      content_hash: skill.content_hash,
      manifest_json: JSON.stringify(skill.manifest),
      storage_dir: skill.storage_dir,
      status: skill.status,
      metadata_json: skill.metadata_json,
      created_at_ms: skill.created_at_ms,
      updated_at_ms: skill.updated_at_ms,
    };
  }

  // ─── Private: String escape ───────────────────────────────────────────

  private _escape(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
}
