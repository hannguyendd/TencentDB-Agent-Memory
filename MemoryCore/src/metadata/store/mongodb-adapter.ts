/**
 * MongoDB implementation of IMetadataStore.
 *
 * Corresponds to design doc §6.1 / §6.4 (MongoDB transaction handling).
 * Composite writes (createTeam + admin, createTask + linkAgents, setAgentFixedAssets full replace,
 * deleteAssets cascade) use multi-document transactions (requires a replica set) to guarantee atomicity.
 *
 * Collection naming aligns with the SQLite tables (meta_*). Read operations uniformly project out `_id`.
 */

import type {
  MongoClient,
  Db,
  Collection,
  ClientSession,
  Document,
} from "mongodb";
import { mapTeamMemberWithProfile } from "./team-member-view.js";
import { generateId, generateRelationId, ID_PREFIX } from "../utils/id-generator.js";
import {
  isMongoRelationIdCollision,
  runWithGeneratedRelationId,
  RELATION_ID_RETRY_LIMIT,
} from "./relation-id-insert.js";
import { generateUserKey } from "../utils/crypto.js";
import { isUserKeyExpired } from "../utils/user-key.js";
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
  AssetFilter,
  BatchDeleteResult,
  ListPage,
  PaginationParams,
  InstanceUserListFilter,
  AgentFixedAssetCountRow,
  AssetType,
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
  GroupType,
  UpstreamMode,
} from "../types.js";
import { DEFAULT_GROUP_NAME, InstanceUpstreamWriteConflictError } from "../types.js";
import { DEFAULT_PAGINATION } from "../pagination.js";
import { buildChatMemoryAssetId } from "../utils/chat-memory-asset.js";
import { DuplicateUserKeyError } from "./interface.js";

function nowIso(): string {
  return new Date().toISOString();
}

const PK_RETRY_LIMIT = 3;

/** Returns true if the error is a MongoDB E11000 duplicate key on a primary key (xxx_id) field. */
function isPkCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  if (e.code !== 11000) return false;
  const keys = e.keyPattern ? Object.keys(e.keyPattern) : [];
  return keys.some((k) => k.endsWith("_id") && k !== "_id");
}

function isStorePkCollision(err: unknown): boolean {
  return isPkCollision(err) || isMongoRelationIdCollision(err);
}

/** E11000 on meta_user_keys.key_value (hit concurrently when the caller explicitly specifies default_key_value). */
function isUserKeyValueCollision(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: number; keyPattern?: Record<string, unknown> };
  return e.code === 11000 && !!e.keyPattern && "key_value" in e.keyPattern;
}

const PROJECT_NO_ID = { projection: { _id: 0 } } as const;

export interface MongoMetadataStoreOptions {
  /** Whether to enable multi-document transactions (requires a replica set). Default true. */
  useTransactions?: boolean;
  /** When false, close() does not close the client (MetadataStorePool shares the connection). */
  ownsClient?: boolean;
}

export class MongoMetadataStore implements IMetadataStore {
  private readonly client: MongoClient;
  private readonly db: Db;
  private readonly useTransactions: boolean;
  private readonly ownsClient: boolean;
  /**
   * One-time flag for the v1→v2 legacy sweep. true means this process has already done the index/document
   * cleanup on the list path, and subsequent lists skip it -- the sweep is a historical migration action (dropIndex + deleteMany),
   * the data plane will never roll back after v2, so there is no need to run it on every list (each run costs 2
   * Mongo network round trips, the main contributor to the 400ms steady-state latency). A process restart runs it once more as a safety net.
   */
  private legacyV1Swept = false;
  /**
   * One-time flag for the v1 user_key migration (same pattern as legacyV1Swept). init() runs every time
   * `find(all users)` + `findOne(user_key)` one by one; an existing instance cold start takes ~1s the first time,
   * and old instances are costlier (all users must be pulled). It is also a historical migration action; mark it after the first init finishes it.
   */
  private legacyUserKeysMigrated = false;

  constructor(client: MongoClient, dbName: string, opts: MongoMetadataStoreOptions = {}) {
    this.client = client;
    this.db = client.db(dbName);
    this.useTransactions = opts.useTransactions ?? true;
    this.ownsClient = opts.ownsClient ?? true;
    if (!this.useTransactions) {
      console.warn(
        "[META-STORE] WARNING: MongoDB transactions disabled (useTransactions=false). " +
        "Composite writes (createTeam, createTask+linkAgents, setFixedAssets) will NOT be atomic. " +
        "Production deployments MUST use a replica set with transactions enabled.",
      );
    }
  }

  private col<T extends Document = Document>(name: string): Collection<T> {
    return this.db.collection<T>(name);
  }

  private async paginatedFind<T>(
    col: string,
    filter: Document,
    pagination: PaginationParams | null | undefined,
    sort: Document,
    mapper: (doc: Document) => T,
  ): Promise<ListPage<T>> {
    const c = this.col(col);
    const total = await c.countDocuments(filter);
    const p = pagination ?? DEFAULT_PAGINATION;
    let cursor = c.find(filter, PROJECT_NO_ID).sort(sort).skip(p.offset).limit(p.limit);
    const docs = await cursor.toArray();
    return { items: docs.map(mapper), total };
  }

  private async paginatedJoin<T>(
    fromCol: string,
    match: Document,
    lookupFrom: string,
    localField: string,
    foreignField: string,
    sort: Document,
    pagination: PaginationParams | null | undefined,
    joinedMatch?: Document,
  ): Promise<ListPage<T>> {
    const base: Document[] = [
      { $match: match },
      { $lookup: { from: lookupFrom, localField, foreignField, as: "_joined" } },
      { $unwind: "$_joined" },
      { $replaceRoot: { newRoot: "$_joined" } },
      { $project: { _id: 0 } },
    ];
    if (joinedMatch && Object.keys(joinedMatch).length > 0) {
      base.push({ $match: joinedMatch });
    }
    const c = this.col(fromCol);
    const countResult = await c.aggregate([...base, { $count: "total" }]).toArray();
    const total = (countResult[0] as { total?: number })?.total ?? 0;
    const p = pagination ?? DEFAULT_PAGINATION;
    const pipeline: Document[] = [...base, { $sort: sort }, { $skip: p.offset }, { $limit: p.limit }];
    const docs = await c.aggregate(pipeline).toArray();
    return { items: docs as T[], total };
  }

  async init(): Promise<void> {
    // All 25 ensureIndex calls in parallel: createIndex is idempotent, different collections/indexes do not conflict,
    // server-side each was already created independently, and the only overhead is the RTT. Serial 25 × ~70ms ≈ 1.8s,
    // parallel max(independent RTT) ≈ 100~300ms (a first build on an empty database is a bit costlier).
    await Promise.all([
      // ── meta_users ──
      this.ensureIndex("meta_users", { user_id: 1 }, { unique: true }),
      this.ensureIndex("meta_users",
        { user_type: 1 },
        { unique: true, partialFilterExpression: { user_type: "system_admin" } },
      ),
      this.ensureIndex("meta_users", { auth_provider: 1, username: 1 }),
      this.ensureIndex("meta_users",
        { auth_provider: 1, external_id: 1 },
        { sparse: true },
      ),
      this.ensureIndex("meta_users", { email: 1 }, { sparse: true }),
      this.ensureIndex("meta_users", { created_at: -1 }),

      // ── meta_user_keys ──
      this.ensureIndex("meta_user_keys", { key_id: 1 }, { unique: true }),
      this.ensureIndex("meta_user_keys", { key_value: 1 }, { unique: true }),
      this.ensureIndex("meta_user_keys", { user_id: 1, status: 1 }),
      this.ensureIndex("meta_user_keys", { user_id: 1, created_at: -1 }),

      // ── meta_teams ──
      this.ensureIndex("meta_teams", { team_id: 1 }, { unique: true }),
      this.ensureIndex("meta_teams", { created_at: -1 }),

      // ── meta_team_members ──
      this.ensureIndex("meta_team_members", { team_id: 1, user_id: 1 }, { unique: true }),
      this.ensureIndex("meta_team_members", { team_id: 1, status: 1, joined_at: -1 }),
      this.ensureIndex("meta_team_members", { user_id: 1, status: 1 }),

      // ── meta_agents ──
      this.ensureIndex("meta_agents", { agent_id: 1 }, { unique: true }),
      this.ensureIndex("meta_agents", { team_id: 1, status: 1, created_at: -1 }),
      this.ensureIndex("meta_agents", { owner_user_id: 1, status: 1, created_at: -1 }),

      // ── meta_tasks ──
      this.ensureIndex("meta_tasks", { task_id: 1 }, { unique: true }),
      this.ensureIndex("meta_tasks", { team_id: 1, status: 1, created_at: -1 }),
      this.ensureIndex("meta_tasks", { creator_user_id: 1, status: 1, created_at: -1 }),

      // ── meta_task_agents ──
      this.ensureIndex("meta_task_agents", { task_id: 1, agent_id: 1 }, { unique: true }),
      this.ensureIndex("meta_task_agents", { task_id: 1, status: 1, created_at: -1 }),

      // ── meta_participation_logs ──
      this.ensureIndex("meta_participation_logs", { team_id: 1, created_at: -1 }, { name: "ix_pl_team_created" }),
      this.ensureIndex(
        "meta_participation_logs",
        { team_id: 1, task_id: 1, agent_id: 1, created_at: -1 },
        { name: "ix_pl_team_task_agent_created" },
      ),
      this.ensureIndex(
        "meta_participation_logs",
        { team_id: 1, user_id: 1, created_at: -1 },
        { name: "ix_pl_team_user_created" },
      ),
      this.ensureIndex(
        "meta_participation_logs",
        { team_id: 1, task_id: 1, agent_id: 1, user_id: 1, created_at: -1 },
        { name: "ix_pl_team_dims_created" },
      ),

      // ── meta_assets ──
      this.ensureIndex("meta_assets", { asset_id: 1 }, { unique: true }),
      this.ensureIndex("meta_assets", { team_id: 1, status: 1, created_at: -1 }),

      // ── meta_agent_fixed_assets ──
      this.ensureIndex("meta_agent_fixed_assets", { agent_id: 1, asset_id: 1 }, { unique: true }),
      this.ensureIndex("meta_agent_fixed_assets", { agent_id: 1, priority: -1, created_at: -1 }),

      // ── meta_asset_acl ──
      this.ensureIndex("meta_asset_acl",
        { asset_id: 1, subject_type: 1, subject_id: 1, permission: 1 },
        { unique: true },
      ),
      this.ensureIndex("meta_asset_acl", { id: 1 }, { unique: true }),
      this.ensureIndex("meta_asset_acl", { asset_id: 1, created_at: -1 }),
      this.ensureIndex("meta_asset_acl", { subject_type: 1, subject_id: 1, created_at: -1 }),

      // ── meta_config_params ──
      this.ensureIndex("meta_config_params",
        { scope: 1, user_id: 1, module: 1, param_name: 1 },
        { unique: true },
      ),
      this.ensureIndex("meta_config_params", { module: 1 }),
      this.ensureIndex("meta_config_params",
        { user_id: 1, module: 1 },
        { partialFilterExpression: { scope: "user" } },
      ),

      // ── meta_instance_upstream_config (v2 model group) ──
      this.ensureIndex("meta_instance_upstream_config",
        { group_id: 1 },
        { unique: true },
      ),
      // Singleton constraint: default / extraction have at most 1 row per instance.
      // Warning: MongoDB partial index filter only supports equality/$exists/$gt/$gte/$lt/$lte/$type/$and
      // (top level), and **does not support `$in`**. Previously using `partialFilterExpression: {group_type: {$in: [...]}}`
      // made mongo throw code=67 "unsupported expression", which ensureIndex silently swallowed with console.warn,
      // so in effect this unique index never existed → concurrent default seeds could insert 2 rows (mem-orooh93g
      // confirmed in production). Changed to two independent partial indexes whose filters use equality.
      // Explicit name to avoid name clashes for the same spec.
      this.ensureIndex("meta_instance_upstream_config",
        { group_type: 1 },
        { unique: true, partialFilterExpression: { group_type: "default" }, name: "ux_group_type_default" },
      ),
      this.ensureIndex("meta_instance_upstream_config",
        { group_type: 1 },
        { unique: true, partialFilterExpression: { group_type: "extraction" }, name: "ux_group_type_extraction" },
      ),
    ]);

    await this.migrateLegacyUserKeys();
  }

  /**
   * Safely create an index: an index creation failure does not abort the initialization flow, but is logged for online troubleshooting.
   *
   * ★ E11000 self-healing: when a partial unique index cannot be built because of existing dirty data (dupes),
   * detect whether the target spec is a singleton constraint we know (default / extraction singleton),
   * and if so call _dedupSingletonRows to pick a winner and delete the others, then retry createIndex.
   * Only takes effect for the group_type=1 spec of meta_instance_upstream_config; other collections
   * go through the silent error path (unrecognized specs, so we do not dare to delete data blindly).
   */
  private async ensureIndex(
    colName: string,
    spec: Record<string, number>,
    options?: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.col(colName).createIndex(spec, options);
      return;
    } catch (err: unknown) {
      const code = (err as { code?: number })?.code;
      const msg = (err as { errmsg?: string })?.errmsg
        ?? (err instanceof Error ? err.message : String(err));
      const specStr = `${colName}(${JSON.stringify(spec)})`;
      if (code === 85 || code === 86) {
        // The index already exists but with a different definition (e.g. options changed); index creation is skipped and functionality is unaffected
        console.warn(`[mongodb-adapter] ensureIndex skipped (index exists with different options) ${specStr}: ${msg}`);
        return;
      }
      if (code === 67) {
        // The index spec itself is invalid (e.g. the partial filter uses an unsupported operator such as $in / $or).
        // **This is a code bug**: the unique index was never built → concurrent writes at the application layer would bypass the constraint.
        // The earlier group_type $in partial filter was exactly this kind of bug (mem-orooh93g got 2 default rows).
        console.error(`[mongodb-adapter] ⚠ ensureIndex REJECTED (invalid spec — CODE BUG) ${specStr}: ${msg}`);
        return;
      }
      if (code === 11000) {
        // Try self-healing: recognize the default/extraction singleton constraint of meta_instance_upstream_config
        const partial = (options as { partialFilterExpression?: Record<string, unknown> } | undefined)?.partialFilterExpression;
        const targetGroupType =
          colName === "meta_instance_upstream_config" &&
          spec.group_type === 1 &&
          partial &&
          (partial.group_type === "default" || partial.group_type === "extraction")
            ? String(partial.group_type)
            : null;

        if (targetGroupType) {
          console.error(`[mongodb-adapter] ensureIndex blocked by duplicate ${targetGroupType} rows ${specStr}, attempting auto-heal…`);
          try {
            const kept = await this._dedupSingletonRows(targetGroupType);
            // Retry createIndex; hitting 11000 again after dedup means the dedup has a bug, so escalate to error
            await this.col(colName).createIndex(spec, options);
            console.warn(`[mongodb-adapter] ✅ auto-healed ${targetGroupType} singleton (kept group_id=${kept}) and index built`);
            return;
          } catch (retryErr: unknown) {
            const rcode = (retryErr as { code?: number })?.code;
            const rmsg = (retryErr as { errmsg?: string })?.errmsg
              ?? (retryErr instanceof Error ? retryErr.message : String(retryErr));
            console.error(`[mongodb-adapter] ⚠ auto-heal for ${targetGroupType} FAILED (code=${rcode}) ${specStr}: ${rmsg} — unique invariant still NOT enforced`);
            return;
          }
        }
        // E11000 on an unrecognized collection/spec: do not dare to delete data blindly, only alert
        console.error(`[mongodb-adapter] ⚠ ensureIndex BLOCKED by duplicate data ${specStr}: ${msg} — unique invariant is NOT enforced until dupes are cleaned`);
        return;
      }
      // Unexpected error (network timeout, insufficient permissions, etc.), needs manual investigation
      console.warn(`[mongodb-adapter] ensureIndex failed (unexpected error, code=${code}) ${specStr}: ${msg}`);
    }
  }

  /**
   * Auto-heal helper: when meta_instance_upstream_config has multiple rows of the same group_type (default/extraction)
   * (leftover from historical dirty data or concurrent double-seed), pick a winner to keep and delete the others.
   *
   * Winner rule (deterministic tiebreaker, consistent across runs):
   *   1. Earliest created_at (the first to be seeded stays -- in normal concurrent scenarios the first arrival is generally not updated)
   *   2. Tie → earliest updated_at
   *   3. Still tied → smallest id (auto-increment number)
   *
   * Returns the retained group_id. If there are only 0 or 1 rows, data is untouched and it returns the group_id of the row that may exist, or null.
   */
  private async _dedupSingletonRows(groupType: string): Promise<string | null> {
    const rows = await this.col<Document>("meta_instance_upstream_config")
      .find({ group_type: groupType } as Document, { projection: { _id: 1, id: 1, group_id: 1, created_at: 1, updated_at: 1 } as unknown as Document })
      .toArray();
    if (rows.length <= 1) return (rows[0] as { group_id?: string })?.group_id ?? null;

    // Deterministic sort, winner comes first
    rows.sort((a, b) => {
      const ca = String((a as Document).created_at ?? "");
      const cb = String((b as Document).created_at ?? "");
      if (ca !== cb) return ca.localeCompare(cb);
      const ua = String((a as Document).updated_at ?? "");
      const ub = String((b as Document).updated_at ?? "");
      if (ua !== ub) return ua.localeCompare(ub);
      const ia = Number((a as Document).id ?? Number.MAX_SAFE_INTEGER);
      const ib = Number((b as Document).id ?? Number.MAX_SAFE_INTEGER);
      return ia - ib;
    });
    const winner = rows[0] as Document;
    const loserIds = rows.slice(1).map((r) => (r as Document)._id);
    const loserGroupIds = rows.slice(1).map((r) => String((r as { group_id?: string }).group_id));
    console.warn(`[mongodb-adapter] dedup ${groupType}: keeping group_id=${(winner as { group_id?: string }).group_id} (created_at=${(winner as { created_at?: string }).created_at}), deleting ${loserIds.length}: ${loserGroupIds.join(",")}`);
    await this.col("meta_instance_upstream_config").deleteMany({ _id: { $in: loserIds } } as Document);
    return String((winner as { group_id?: string }).group_id);
  }

  private async migrateLegacyUserKeys(): Promise<void> {
    if (this.legacyUserKeysMigrated) return;
    // Only fetch users **that contain the legacy user_key field** (v2 users go through the meta_user_keys table
    // and have no such field at all). It used to be find({}) on the whole table → findOne(user_keys) one by one, N
    // network round trips (~1s for old existing databases; ~40ms for new ones but every store paid it needlessly the first time).
    // Switched to a $exists filter: old databases only fetch the few docs that really need migrating; fully-v2 instances get an empty array directly,
    // costing just one count-level query (~40ms) before marking done.
    const users = await this.col<UserEntity & { user_key?: string }>("meta_users")
      .find({ user_key: { $exists: true } } as Document, PROJECT_NO_ID)
      .toArray();
    for (const u of users) {
      const existing = await this.col<UserKeyEntity>("meta_user_keys").findOne({ user_id: u.user_id } as Document, PROJECT_NO_ID);
      if (existing) continue;
      const legacyKey = (u as { user_key?: string }).user_key;
      if (!legacyKey) continue;
      await this.insertUserKeyDoc({
        user_id: u.user_id,
        key_value: legacyKey,
        is_default: true,
        created_at: u.created_at,
      });
    }
    this.legacyUserKeysMigrated = true;
  }

  private async insertUserKeyDoc(input: {
    user_id: string;
    key_value: string;
    name?: string | null;
    is_default?: boolean;
    expires_at?: string | null;
    created_at?: string;
    metadata_json?: string;
  }): Promise<UserKeyEntity> {
    const now = input.created_at ?? nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const doc: UserKeyEntity = {
        key_id: generateId(ID_PREFIX.userKey),
        user_id: input.user_id,
        key_value: input.key_value,
        name: input.name ?? null,
        status: "active",
        is_default: input.is_default ?? false,
        last_used_at: null,
        expires_at: input.expires_at ?? null,
        created_at: now,
        revoked_at: null,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.col("meta_user_keys").insertOne({ ...doc });
        return doc;
      } catch (err) {
        if (isPkCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("user key PK collision after max retries");
  }

  async close(): Promise<void> {
    if (this.ownsClient) {
      await this.client.close();
    }
  }

  private async withTx<T>(fn: (session?: ClientSession) => Promise<T>): Promise<T> {
    if (!this.useTransactions) return fn(undefined);
    const session = this.client.startSession();
    try {
      let result!: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result;
    } finally {
      await session.endSession();
    }
  }

  // ============================================================
  // User
  // ============================================================
  async createUser(input: CreateUserInput): Promise<UserEntity> {
    const now = nowIso();
    const defaultKeyValue = input.default_key_value ?? generateUserKey();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const doc: UserEntity = {
        user_id: input.user_id ?? generateId(ID_PREFIX.user),
        password: input.password ?? null,
        auth_provider: input.auth_provider,
        external_id: input.external_id,
        username: input.username,
        display_name: input.display_name ?? null,
        raw_profile_json: input.raw_profile_json ?? "{}",
        status: input.status ?? "active",
        user_type: input.user_type ?? "normal",
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      if (input.email) {
        doc.email = input.email;
      }
      try {
        await this.col("meta_users").insertOne({ ...doc });
        await this.insertUserKeyDoc({
          user_id: doc.user_id,
          key_value: defaultKeyValue,
          is_default: true,
          created_at: now,
        });
        return doc;
      } catch (err) {
        // When the caller explicitly specifies default_key_value it hits UNIQUE: translate into a business error (HTTP 409), no retry.
        if (isUserKeyValueCollision(err)) {
          throw new DuplicateUserKeyError(defaultKeyValue);
        }
        if (isPkCollision(err) && !input.user_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getUserById(userId: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne({ user_id: userId } as Document, PROJECT_NO_ID) as Promise<UserEntity | null>;
  }

  async getUserByKey(userKey: string): Promise<UserEntity | null> {
    const keyDoc = await this.col<UserKeyEntity>("meta_user_keys").findOne(
      { key_value: userKey, status: "active" } as Document,
      PROJECT_NO_ID,
    ) as UserKeyEntity | null;
    if (!keyDoc || isUserKeyExpired(keyDoc.expires_at)) return null;
    await this.touchUserKeyUsage(keyDoc.key_id);
    return this.getUserById(keyDoc.user_id);
  }

  async getDefaultUserKey(userId: string): Promise<UserKeyEntity | null> {
    return this.col<UserKeyEntity>("meta_user_keys").findOne(
      { user_id: userId, is_default: true, status: "active" } as Document,
      PROJECT_NO_ID,
    ) as Promise<UserKeyEntity | null>;
  }

  async getUserByUsername(authProvider: string, username: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne(
      { auth_provider: authProvider, username } as Document,
      PROJECT_NO_ID,
    ) as Promise<UserEntity | null>;
  }

  async getUserByEmail(email: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne({ email } as Document, PROJECT_NO_ID) as Promise<UserEntity | null>;
  }

  async getUserByExternalId(authProvider: string, externalId: string): Promise<UserEntity | null> {
    return this.col<UserEntity>("meta_users").findOne(
      { auth_provider: authProvider, external_id: externalId } as Document,
      PROJECT_NO_ID,
    ) as Promise<UserEntity | null>;
  }

  async updateUser(userId: string, patch: Partial<UserEntity>): Promise<UserEntity | null> {
    // external_id / auth_provider: written when external auth (e.g. WOA) binds an existing account,
    // used to determine whether it is a first login next time. If the allowlist misses auth_provider, the binding "looks successful
    // but actually never wrote the domain", and the next reverse lookup by domain misses → 401, a silent failure; be sure to keep it.
    const allowed = ["password", "display_name", "email", "raw_profile_json", "status", "metadata_json", "username", "external_id", "auth_provider"];
    await this.patchOne("meta_users", { user_id: userId }, patch, allowed, true);
    return this.getUserById(userId);
  }

  async deleteUsers(userIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_users", "user_id", userIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_user_keys").deleteMany({ user_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_team_members").deleteMany({ user_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_asset_acl").deleteMany({ subject_type: "user", subject_id: { $in: result.deleted_ids } } as Document);
    }
    return result;
  }

  async listUsersByTeam(
    teamId: string,
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): Promise<ListPage<UserEntity>> {
    const joinedMatch: Document = {};
    if (filter?.user_ids?.length) joinedMatch.user_id = { $in: filter.user_ids };
    if (filter?.username) {
      joinedMatch.username = filter.username;
    }
    return this.paginatedJoin<UserEntity>(
      "meta_team_members",
      { team_id: teamId, status: "active" },
      "meta_users",
      "user_id",
      "user_id",
      { created_at: -1 },
      pagination,
      joinedMatch,
    );
  }

  async listUsers(
    pagination?: PaginationParams | null,
    filter?: InstanceUserListFilter,
  ): Promise<ListPage<UserEntity>> {
    const q: Document = {};
    if (filter?.status) q.status = filter.status;
    if (filter?.user_type) q.user_type = filter.user_type;
    if (filter?.user_ids?.length) q.user_id = { $in: filter.user_ids };
    if (filter?.username) {
      q.username = filter.username;
    }
    return this.paginatedFind("meta_users", q, pagination, { created_at: -1 }, (d) => d as UserEntity);
  }

  async countUsers(): Promise<number> {
    return this.col("meta_users").countDocuments({});
  }

  async countSystemAdmins(): Promise<number> {
    return this.col("meta_users").countDocuments({ user_type: "system_admin" } as Document);
  }

  async countTeams(): Promise<number> {
    return this.col("meta_teams").countDocuments({});
  }

  // ============================================================
  // UserKey
  // ============================================================
  async createUserKey(input: CreateUserKeyInput): Promise<UserKeyEntity> {
    if (input.is_default) {
      await this.col("meta_user_keys").updateMany(
        { user_id: input.user_id, status: "active" } as Document,
        { $set: { is_default: false } },
      );
    }
    return this.insertUserKeyDoc({
      user_id: input.user_id,
      key_value: input.key_value ?? generateUserKey(),
      name: input.name,
      is_default: input.is_default,
      expires_at: input.expires_at,
      metadata_json: input.metadata_json,
    });
  }

  async getUserKeyById(keyId: string): Promise<UserKeyEntity | null> {
    return this.col<UserKeyEntity>("meta_user_keys").findOne({ key_id: keyId } as Document, PROJECT_NO_ID) as Promise<UserKeyEntity | null>;
  }

  async listUserKeys(userId: string, pagination?: PaginationParams | null): Promise<ListPage<UserKeyEntity>> {
    return this.paginatedFind(
      "meta_user_keys",
      { user_id: userId },
      pagination,
      { created_at: -1 },
      (d) => d as UserKeyEntity,
    );
  }

  async countActiveUserKeys(userId: string): Promise<number> {
    return this.col("meta_user_keys").countDocuments({ user_id: userId, status: "active" } as Document);
  }

  async revokeUserKey(keyId: string, options?: { promoteNextDefault?: boolean }): Promise<UserKeyEntity | null> {
    const promoteNextDefault = options?.promoteNextDefault ?? true;
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;

    if (existing.is_default && promoteNextDefault) {
      const next = await this.col<UserKeyEntity>("meta_user_keys")
        .find({ user_id: existing.user_id, status: "active", key_id: { $ne: keyId } } as Document, PROJECT_NO_ID)
        .sort({ created_at: 1 })
        .limit(1)
        .next();
      if (next) {
        await this.col("meta_user_keys").updateOne({ key_id: next.key_id } as Document, { $set: { is_default: true } });
      }
    }

    await this.col("meta_user_keys").deleteOne({ key_id: keyId } as Document);
    return existing;
  }

  async updateUserKey(
    keyId: string,
    patch: Partial<Pick<UserKeyEntity, "name" | "expires_at" | "is_default" | "metadata_json">>,
  ): Promise<UserKeyEntity | null> {
    const existing = await this.getUserKeyById(keyId);
    if (!existing) return null;
    if (patch.is_default === true) {
      await this.col("meta_user_keys").updateMany(
        { user_id: existing.user_id, status: "active" } as Document,
        { $set: { is_default: false } },
      );
    }
    const $set: Record<string, unknown> = {};
    if (patch.name !== undefined) $set.name = patch.name;
    if (patch.expires_at !== undefined) $set.expires_at = patch.expires_at;
    if (patch.is_default !== undefined) $set.is_default = patch.is_default;
    if (patch.metadata_json !== undefined) $set.metadata_json = patch.metadata_json;
    if (Object.keys($set).length > 0) {
      await this.col("meta_user_keys").updateOne({ key_id: keyId } as Document, { $set });
    }
    return this.getUserKeyById(keyId);
  }

  async touchUserKeyUsage(keyId: string): Promise<void> {
    await this.col("meta_user_keys").updateOne({ key_id: keyId } as Document, { $set: { last_used_at: nowIso() } });
  }

  async revokeAllUserKeysForUser(userId: string): Promise<void> {
    await this.col("meta_user_keys").deleteMany(
      { user_id: userId, status: "active" } as Document,
    );
  }

  // ============================================================
  // Team
  // ============================================================
  async createTeam(input: CreateTeamInput): Promise<TeamEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const team: TeamEntity = {
        team_id: input.team_id ?? generateId(ID_PREFIX.team),
        name: input.name,
        description: input.description ?? null,
        owner_user_id: input.owner_user_id,
        status: input.status ?? "active",
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.withTx(async (session) => {
          await this.col("meta_teams").insertOne({ ...team }, { session });
          await this.col("meta_team_members").insertOne(
            {
              id: generateRelationId(),
              team_id: team.team_id,
              user_id: team.owner_user_id,
              role: "admin",
              joined_at: now,
              status: "active",
            },
            { session },
          );
        });
        return team;
      } catch (err) {
        if (isStorePkCollision(err) && !input.team_id) continue;
        if (isMongoRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getTeamById(teamId: string): Promise<TeamEntity | null> {
    return this.col<TeamEntity>("meta_teams").findOne({ team_id: teamId } as Document, PROJECT_NO_ID) as Promise<TeamEntity | null>;
  }

  async updateTeam(teamId: string, patch: Partial<TeamEntity>): Promise<TeamEntity | null> {
    await this.patchOne("meta_teams", { team_id: teamId }, patch, ["name", "description", "status", "metadata_json"], true);
    return this.getTeamById(teamId);
  }

  async deleteTeams(teamIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_teams", "team_id", teamIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_team_members").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_agents").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_tasks").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_assets").deleteMany({ team_id: { $in: result.deleted_ids } } as Document);
    }
    return result;
  }

  async listTeamsByUser(userId: string, pagination?: PaginationParams | null, filter?: { name?: string }): Promise<ListPage<TeamEntity>> {
    const joinedMatch: Document = {};
    if (filter?.name) joinedMatch.name = filter.name;
    return this.paginatedJoin<TeamEntity>(
      "meta_team_members",
      { user_id: userId, status: "active" },
      "meta_teams",
      "team_id",
      "team_id",
      { created_at: -1 },
      pagination,
      Object.keys(joinedMatch).length > 0 ? joinedMatch : undefined,
    );
  }

  // ============================================================
  // TeamMember
  // ============================================================
  async addTeamMember(input: AddTeamMemberInput): Promise<TeamMemberEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(input.id, isMongoRelationIdCollision, async (id) => {
      await this.col("meta_team_members").updateOne(
        { team_id: input.team_id, user_id: input.user_id },
        {
          $set: { role: input.role ?? "member", status: input.status ?? "active" },
          $setOnInsert: { id, team_id: input.team_id, user_id: input.user_id, joined_at: now },
        },
        { upsert: true },
      );
    });
    return (await this.getTeamMember(input.team_id, input.user_id))!;
  }

  async removeTeamMember(teamId: string, userId: string): Promise<void> {
    await this.col("meta_team_members").deleteOne({ team_id: teamId, user_id: userId });
  }

  async listTeamMembers(teamId: string, pagination?: PaginationParams | null): Promise<ListPage<TeamMemberEntity>> {
    return this.paginatedFind(
      "meta_team_members",
      { team_id: teamId, status: "active" },
      pagination,
      { joined_at: -1 },
      (d) => d as TeamMemberEntity,
    );
  }

  async getTeamMember(teamId: string, userId: string): Promise<TeamMemberEntity | null> {
    return this.col<TeamMemberEntity>("meta_team_members").findOne(
      { team_id: teamId, user_id: userId } as Document,
      PROJECT_NO_ID,
    ) as Promise<TeamMemberEntity | null>;
  }

  async listTeamMembersWithProfile(
    teamId: string,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<TeamMemberView>> {
    const match = { team_id: teamId, status: "active" };
    const c = this.col("meta_team_members");
    const countResult = await c.aggregate([{ $match: match }, { $count: "total" }]).toArray();
    const total = (countResult[0] as { total?: number })?.total ?? 0;
    const p = pagination ?? DEFAULT_PAGINATION;
    const docs = await c
      .aggregate([
        { $match: match },
        { $lookup: { from: "meta_users", localField: "user_id", foreignField: "user_id", as: "_user" } },
        {
          $addFields: {
            username: { $ifNull: [{ $arrayElemAt: ["$_user.username", 0] }, ""] },
          },
        },
        { $project: { _id: 0, _user: 0 } },
        { $sort: { joined_at: -1 } },
        { $skip: p.offset },
        { $limit: p.limit },
      ])
      .toArray();
    return { items: docs.map((d) => mapTeamMemberWithProfile(d as TeamMemberEntity & { username?: string })), total };
  }

  async getTeamMemberWithProfile(teamId: string, userId: string): Promise<TeamMemberView | null> {
    const member = await this.getTeamMember(teamId, userId);
    if (!member) return null;
    const user = await this.getUserById(userId);
    return mapTeamMemberWithProfile({ ...member, username: user?.username ?? "" });
  }

  // ============================================================
  // Agent
  // ============================================================
  async createAgent(input: CreateAgentInput): Promise<AgentEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const agent: AgentEntity = {
        agent_id: input.agent_id ?? generateId(ID_PREFIX.agent),
        team_id: input.team_id,
        owner_user_id: input.owner_user_id,
        name: input.name,
        description: input.description ?? null,
        prompt: input.prompt ?? null,
        visibility: input.visibility ?? "team",
        status: input.status ?? "active",
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.col("meta_agents").insertOne({ ...agent });
        return agent;
      } catch (err) {
        if (isPkCollision(err) && !input.agent_id) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getAgentById(agentId: string): Promise<AgentEntity | null> {
    return this.col<AgentEntity>("meta_agents").findOne({ agent_id: agentId } as Document, PROJECT_NO_ID) as Promise<AgentEntity | null>;
  }

  async updateAgent(agentId: string, patch: Partial<AgentEntity>): Promise<AgentEntity | null> {
    await this.patchOne("meta_agents", { agent_id: agentId }, patch, ["name", "description", "prompt", "visibility", "status", "metadata_json"], true);
    return this.getAgentById(agentId);
  }

  async deleteAgents(agentIds: string[]): Promise<BatchDeleteResult> {
    const agents = await this.col<AgentEntity>("meta_agents")
      .find({ agent_id: { $in: agentIds } } as Document, { projection: PROJECT_NO_ID })
      .toArray();
    const selfMemoryByAgent = new Map(
      agents.map((agent) => [agent.agent_id, buildChatMemoryAssetId(agent.team_id, agent.agent_id)]),
    );

    const result = await this.batchDelete("meta_agents", "agent_id", agentIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_task_agents").deleteMany({ agent_id: { $in: result.deleted_ids } } as Document);
      await this.col("meta_agent_fixed_assets").deleteMany({ agent_id: { $in: result.deleted_ids } } as Document);
      const selfMemoryAssetIds = result.deleted_ids
        .map((agentId) => selfMemoryByAgent.get(agentId))
        .filter((assetId): assetId is string => !!assetId);
      if (selfMemoryAssetIds.length > 0) {
        await this.deleteAssets(selfMemoryAssetIds);
      }
    }
    return result;
  }

  async listAgentsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AgentFilter): Promise<ListPage<AgentEntity>> {
    const q: Document = { team_id: teamId };
    if (filter?.status) q.status = filter.status;
    if (filter?.owner_user_id) q.owner_user_id = filter.owner_user_id;
    if (filter?.name) q.name = filter.name;
    return this.paginatedFind("meta_agents", q, pagination, { created_at: -1 }, (d) => d as AgentEntity);
  }

  async listAgentsByOwner(userId: string, pagination?: PaginationParams | null, filter?: AgentFilter): Promise<ListPage<AgentEntity>> {
    const q: Document = { owner_user_id: userId };
    if (filter?.status) q.status = filter.status;
    if (filter?.name) q.name = filter.name;
    return this.paginatedFind("meta_agents", q, pagination, { created_at: -1 }, (d) => d as AgentEntity);
  }

  // ============================================================
  // Task
  // ============================================================
  async createTask(input: CreateTaskInput): Promise<TaskEntity> {
    const now = nowIso();
    for (let attempt = 0; attempt < PK_RETRY_LIMIT; attempt++) {
      const task: TaskEntity = {
        task_id: input.task_id ?? generateId(ID_PREFIX.task),
        team_id: input.team_id,
        creator_user_id: input.creator_user_id,
        title: input.title,
        description: input.description ?? null,
        source_type: input.source_type ?? "manual",
        source_url: input.source_url ?? null,
        status: input.status ?? "running",
        auto_assign_floating_assets: input.auto_assign_floating_assets ?? false,
        risk_level: input.risk_level ?? null,
        created_at: now,
        updated_at: now,
        metadata_json: input.metadata_json ?? "{}",
      };
      try {
        await this.withTx(async (session) => {
          await this.col("meta_tasks").insertOne({ ...task }, { session });
          const links = input.linked_agents ?? [];
          if (links.length > 0) {
            await this.col("meta_task_agents").insertMany(
              links.map((l) => ({
                id: generateRelationId(),
                task_id: task.task_id,
                agent_id: l.agent_id,
                role_in_task: l.role_in_task ?? null,
                status: "active",
                created_at: now,
              })),
              { session },
            );
          }
        });
        return task;
      } catch (err) {
        if (isStorePkCollision(err) && !input.task_id) continue;
        if (isMongoRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("PK collision after max retries");
  }

  async getTaskById(taskId: string): Promise<TaskEntity | null> {
    return this.col<TaskEntity>("meta_tasks").findOne({ task_id: taskId } as Document, PROJECT_NO_ID) as Promise<TaskEntity | null>;
  }

  async updateTask(taskId: string, patch: Partial<TaskEntity>): Promise<TaskEntity | null> {
    await this.patchOne("meta_tasks", { task_id: taskId }, patch, ["title", "description", "source_type", "source_url", "status", "auto_assign_floating_assets", "risk_level", "metadata_json"], true);
    return this.getTaskById(taskId);
  }

  async deleteTasks(taskIds: string[]): Promise<BatchDeleteResult> {
    const result = await this.batchDelete("meta_tasks", "task_id", taskIds);
    if (result.deleted_ids.length > 0) {
      await this.col("meta_task_agents").deleteMany({ task_id: { $in: result.deleted_ids } } as Document);
    }
    return result;
  }

  async listTasksByTeam(teamId: string, pagination?: PaginationParams | null, filter?: TaskFilter): Promise<ListPage<TaskEntity>> {
    const q: Document = { team_id: teamId };
    if (filter?.status) q.status = filter.status;
    if (filter?.creator_user_id) q.creator_user_id = filter.creator_user_id;
    if (filter?.title) q.title = filter.title;
    return this.paginatedFind("meta_tasks", q, pagination, { created_at: -1 }, (d) => d as TaskEntity);
  }

  async listTasks(filter: TaskFilter, pagination?: PaginationParams | null): Promise<ListPage<TaskEntity>> {
    const q: Document = {};
    if (filter.status) q.status = filter.status;
    if (filter.creator_user_id) q.creator_user_id = filter.creator_user_id;
    if (filter.title) q.title = filter.title;
    return this.paginatedFind("meta_tasks", q, pagination, { created_at: -1 }, (d) => d as TaskEntity);
  }

  // ============================================================
  // TaskAgent
  // ============================================================
  async linkTaskAgent(taskId: string, agentId: string, roleInTask?: string): Promise<TaskAgentEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(undefined, isMongoRelationIdCollision, async (id) => {
      await this.col("meta_task_agents").updateOne(
        { task_id: taskId, agent_id: agentId },
        {
          $set: { role_in_task: roleInTask ?? null, status: "active" },
          $setOnInsert: { id, task_id: taskId, agent_id: agentId, created_at: now },
        },
        { upsert: true },
      );
    });
    return (await this.col<TaskAgentEntity>("meta_task_agents").findOne(
      { task_id: taskId, agent_id: agentId } as Document,
      PROJECT_NO_ID,
    )) as TaskAgentEntity;
  }

  async unlinkTaskAgent(taskId: string, agentId: string): Promise<void> {
    await this.col("meta_task_agents").deleteOne({ task_id: taskId, agent_id: agentId });
  }

  async listTaskAgents(taskId: string, pagination?: PaginationParams | null): Promise<ListPage<TaskAgentEntity>> {
    return this.paginatedFind(
      "meta_task_agents",
      { task_id: taskId, status: "active" },
      pagination,
      { created_at: -1 },
      (d) => d as TaskAgentEntity,
    );
  }

  // ============================================================
  // ParticipationLog
  // ============================================================
  async appendParticipationLog(input: AppendParticipationLogInput): Promise<ParticipationLogEntity> {
    const now = nowIso();
    const createdAt = input.created_at ?? now;
    const entity: ParticipationLogEntity = {
      id: generateRelationId(),
      team_id: input.team_id,
      task_id: input.task_id,
      agent_id: input.agent_id,
      user_id: input.user_id,
      source: input.source ?? "unknown",
      metadata_json: input.metadata_json ?? "{}",
      created_at: createdAt,
      updated_at: createdAt,
    };
    await this.col("meta_participation_logs").insertOne(entity);
    return entity;
  }

  async listParticipationLogs(
    filter: ParticipationLogFilter,
    pagination?: PaginationParams | null,
  ): Promise<ListPage<ParticipationLogEntity>> {
    const match = this.buildParticipationLogMatch(filter);
    const p = pagination ?? DEFAULT_PAGINATION;
    if (filter.dedupe) {
      const pipeline: Document[] = [
        { $match: match },
        { $sort: { created_at: -1, id: -1 } },
        { $group: { _id: "$user_id", doc: { $first: "$$ROOT" } } },
        { $replaceRoot: { newRoot: "$doc" } },
        { $sort: { created_at: -1, id: -1 } },
        {
          $facet: {
            items: [{ $skip: p.offset }, { $limit: p.limit }],
            total: [{ $count: "total" }],
          },
        },
      ];
      const [result] = await this.col("meta_participation_logs").aggregate(pipeline).toArray();
      const facet = result as { items?: Document[]; total?: Array<{ total: number }> };
      return {
        items: (facet.items ?? []).map((d) => d as ParticipationLogEntity),
        total: facet.total?.[0]?.total ?? 0,
      };
    }
    return this.paginatedFind(
      "meta_participation_logs",
      match,
      pagination,
      { created_at: -1, id: -1 },
      (d) => d as ParticipationLogEntity,
    );
  }

  private buildParticipationLogMatch(filter: ParticipationLogFilter): Document {
    const q: Document = { team_id: filter.team_id };
    if (filter.task_id) q.task_id = filter.task_id;
    if (filter.agent_id) q.agent_id = filter.agent_id;
    if (filter.user_id) q.user_id = filter.user_id;
    if (filter.created_after) q.created_at = { ...(q.created_at as Document), $gte: filter.created_after };
    if (filter.created_before) {
      q.created_at = { ...(q.created_at as Document), $lte: filter.created_before };
    }
    return q;
  }

  // ============================================================
  // Asset
  // ============================================================
  async createAsset(input: CreateAssetInput): Promise<AssetEntity> {
    const now = nowIso();
    const asset: AssetEntity = {
      asset_id: input.asset_id,
      team_id: input.team_id,
      asset_type: input.asset_type,
      name: input.name,
      description: input.description ?? null,
      owner_user_id: input.owner_user_id,
      source_type: input.source_type,
      source_ref: input.source_ref ?? null,
      version: 1,
      visibility: input.visibility ?? "team",
      status: input.status ?? "draft",
      confidence: input.confidence ?? null,
      expires_at: input.expires_at ?? null,
      last_used_at: null,
      usage_count: 0,
      content_ref: input.content_ref ?? null,
      created_at: now,
      updated_at: now,
      metadata_json: input.metadata_json ?? "{}",
    };
    await this.col("meta_assets").insertOne({ ...asset });
    return asset;
  }

  async getAssetById(assetId: string): Promise<AssetEntity | null> {
    return this.col<AssetEntity>("meta_assets").findOne({ asset_id: assetId } as Document, PROJECT_NO_ID) as Promise<AssetEntity | null>;
  }

  async updateAsset(assetId: string, patch: Partial<AssetEntity>): Promise<AssetEntity | null> {
    await this.patchOne("meta_assets", { asset_id: assetId }, patch, ["name", "description", "visibility", "status", "confidence", "expires_at", "content_ref", "version", "source_ref", "metadata_json"], true);
    return this.getAssetById(assetId);
  }

  async deleteAssets(assetIds: string[]): Promise<BatchDeleteResult> {
    // Physically delete meta_assets, and cascade-clean bindings and ACLs.
    // Already absent counts as idempotent success (the Skill hook/handler dual channel will call twice).
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of assetIds) {
      const existing = await this.getAssetById(id);
      if (!existing) {
        result.deleted_ids.push(id);
        continue;
      }
      await this.withTx(async (session) => {
        await this.col("meta_agent_fixed_assets").deleteMany({ asset_id: id }, { session });
        await this.col("meta_asset_acl").deleteMany({ asset_id: id }, { session });
        await this.col("meta_assets").deleteOne({ asset_id: id }, { session });
      });
      result.deleted_ids.push(id);
    }
    return result;
  }

  async listAssetsByTeam(teamId: string, pagination?: PaginationParams | null, filter?: AssetFilter): Promise<ListPage<AssetEntity>> {
    const q: Document = { team_id: teamId };
    if (filter?.asset_type) q.asset_type = filter.asset_type;
    if (filter?.status) q.status = filter.status;
    if (filter?.owner_user_id) q.owner_user_id = filter.owner_user_id;
    if (filter?.visibility) q.visibility = filter.visibility;
    return this.paginatedFind("meta_assets", q, pagination, { created_at: -1 }, (d) => d as AssetEntity);
  }

  async touchAssetUsage(assetId: string): Promise<void> {
    await this.col("meta_assets").updateOne(
      { asset_id: assetId },
      { $inc: { usage_count: 1 }, $set: { last_used_at: nowIso() } },
    );
  }

  // ============================================================
  // AgentFixedAsset (full replace)
  // ============================================================
  async setAgentFixedAssets(agentId: string, bindings: FixedAssetBindingInput[]): Promise<void> {
    const now = nowIso();
    for (let attempt = 0; attempt < RELATION_ID_RETRY_LIMIT; attempt++) {
      try {
        await this.withTx(async (session) => {
          await this.col("meta_agent_fixed_assets").deleteMany({ agent_id: agentId }, { session });
          if (bindings.length > 0) {
            await this.col("meta_agent_fixed_assets").insertMany(
              bindings.map((b) => ({
                id: generateRelationId(),
                agent_id: agentId,
                asset_id: b.asset_id,
                asset_type: b.asset_type,
                injection_mode: b.injection_mode ?? "summary",
                priority: b.priority ?? 50,
                created_by: b.created_by,
                created_at: now,
              })),
              { session },
            );
          }
        });
        return;
      } catch (err) {
        if (isMongoRelationIdCollision(err)) continue;
        throw err;
      }
    }
    throw new Error("relation id collision after max retries");
  }

  async addAgentFixedAsset(agentId: string, b: FixedAssetBindingInput): Promise<void> {
    // There is a unique index on (agent_id, asset_id) (see initIndexes). Conflict = already exists
    // → treated as a no-op, naturally idempotent.
    try {
      await this.col("meta_agent_fixed_assets").insertOne({
        id: generateRelationId(),
        agent_id: agentId,
        asset_id: b.asset_id,
        asset_type: b.asset_type,
        injection_mode: b.injection_mode ?? "summary",
        priority: b.priority ?? 50,
        created_by: b.created_by,
        created_at: nowIso(),
      });
    } catch (err) {
      // E11000 on (agent_id, asset_id) → already bound, ignore
      if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
        return;
      }
      throw err;
    }
  }

  async listAgentFixedAssets(
    agentId: string,
    pagination?: PaginationParams | null,
    filter?: { assetTypes?: readonly string[] },
  ): Promise<ListPage<FixedAssetBindingEntity>> {
    const types = filter?.assetTypes ?? [];
    if (types.length === 0) {
      return this.paginatedFind(
        "meta_agent_fixed_assets",
        { agent_id: agentId },
        pagination,
        { priority: -1, created_at: -1 },
        (d) => d as FixedAssetBindingEntity,
      );
    }
    // Type filter: first get the asset_id set by asset_type, then use it to filter bindings.
    const assetIds = await this.col("meta_assets")
      .find({ asset_type: { $in: [...types] } } as Document, { projection: { asset_id: 1 } })
      .map((d) => (d as { asset_id: string }).asset_id)
      .toArray();
    if (assetIds.length === 0) {
      return { items: [], total: 0 };
    }
    return this.paginatedFind(
      "meta_agent_fixed_assets",
      { agent_id: agentId, asset_id: { $in: assetIds } },
      pagination,
      { priority: -1, created_at: -1 },
      (d) => d as FixedAssetBindingEntity,
    );
  }

  async getAgentFixedAsset(agentId: string, assetId: string): Promise<FixedAssetBindingEntity | null> {
    return this.col<FixedAssetBindingEntity>("meta_agent_fixed_assets").findOne(
      { agent_id: agentId, asset_id: assetId } as Document,
      PROJECT_NO_ID,
    ) as Promise<FixedAssetBindingEntity | null>;
  }

  async summarizeAgentFixedAssetsByAgents(
    agentIds: string[],
    options?: { assetId?: string },
  ): Promise<AgentFixedAssetCountRow[]> {
    if (agentIds.length === 0) return [];
    const match: Document = { agent_id: { $in: agentIds } };
    if (options?.assetId) match.asset_id = options.assetId;
    const rows = await this.col("meta_agent_fixed_assets")
      .aggregate<{ _id: { agent_id: string; asset_type: string }; cnt: number }>([
        { $match: match },
        {
          $group: {
            _id: { agent_id: "$agent_id", asset_type: "$asset_type" },
            assets: { $addToSet: "$asset_id" },
          },
        },
        {
          $project: {
            _id: 1,
            cnt: { $size: "$assets" },
          },
        },
      ])
      .toArray();
    return rows.map((r) => ({
      agent_id: r._id.agent_id,
      asset_type: r._id.asset_type as AssetType,
      cnt: r.cnt,
    }));
  }

  // ============================================================
  // ACL
  // ============================================================
  async grantAcl(input: GrantAclInput): Promise<AclEntity> {
    const now = nowIso();
    await runWithGeneratedRelationId(input.id, isMongoRelationIdCollision, async (id) => {
      await this.col("meta_asset_acl").updateOne(
        { asset_id: input.asset_id, subject_type: input.subject_type, subject_id: input.subject_id, permission: input.permission },
        {
          $set: { effect: input.effect ?? "allow", granted_by: input.granted_by, updated_at: now },
          $setOnInsert: {
            id,
            asset_id: input.asset_id,
            subject_type: input.subject_type,
            subject_id: input.subject_id,
            permission: input.permission,
            created_at: now,
          },
        },
        { upsert: true },
      );
    });
    return (await this.col<AclEntity>("meta_asset_acl").findOne(
      { asset_id: input.asset_id, subject_type: input.subject_type, subject_id: input.subject_id, permission: input.permission } as Document,
      PROJECT_NO_ID,
    )) as AclEntity;
  }

  async getAclById(id: string): Promise<AclEntity | null> {
    return (await this.col<AclEntity>("meta_asset_acl").findOne({ id } as Document, PROJECT_NO_ID)) as AclEntity | null;
  }

  async revokeAcl(id: string): Promise<void> {
    await this.col("meta_asset_acl").deleteOne({ id });
  }

  async listAclByAsset(assetId: string, pagination?: PaginationParams | null): Promise<ListPage<AclEntity>> {
    return this.paginatedFind("meta_asset_acl", { asset_id: assetId }, pagination, { created_at: -1 }, (d) => d as AclEntity);
  }

  async listAclBySubject(subjectType: string, subjectId: string, pagination?: PaginationParams | null): Promise<ListPage<AclEntity>> {
    return this.paginatedFind(
      "meta_asset_acl",
      { subject_type: subjectType, subject_id: subjectId },
      pagination,
      { created_at: -1 },
      (d) => d as AclEntity,
    );
  }

  // ============================================================
  // Helpers
  // ============================================================
  private async patchOne(
    collection: string,
    filter: Document,
    patch: Record<string, unknown>,
    allowed: string[],
    touchUpdatedAt: boolean,
  ): Promise<void> {
    const set: Record<string, unknown> = {};
    for (const k of allowed) {
      if (k in patch && patch[k] !== undefined) set[k] = patch[k];
    }
    if (touchUpdatedAt) set.updated_at = nowIso();
    if (Object.keys(set).length === 0) return;
    await this.col(collection).updateOne(filter, { $set: set });
  }

  private async batchDelete(collection: string, pkCol: string, ids: string[]): Promise<BatchDeleteResult> {
    const result: BatchDeleteResult = { deleted_ids: [], failed: [] };
    for (const id of ids) {
      const res = await this.col(collection).deleteOne({ [pkCol]: id });
      if (res.deletedCount && res.deletedCount > 0) result.deleted_ids.push(id);
      else result.failed.push({ id, reason: "not_found" });
    }
    return result;
  }

  // ============================================================
  // ConfigParam
  // ============================================================

  private async nextConfigParamId(): Promise<number> {
    const result = await this.col("meta_counters").findOneAndUpdate(
      { _id: "meta_config_params" } as any,
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    return (result as any).seq as number;
  }

  async getConfigParam(
    scope: "global" | "user",
    userId: string | null,
    module: string,
    paramName: string,
  ): Promise<ConfigParamEntity | null> {
    const filter: Document =
      scope === "global"
        ? { scope: "global", user_id: null, module, param_name: paramName }
        : { scope: "user", user_id: userId, module, param_name: paramName };
    const doc = await this.col("meta_config_params").findOne(filter, PROJECT_NO_ID);
    return doc ? (doc as unknown as ConfigParamEntity) : null;
  }

  async upsertConfigParam(input: UpsertConfigParamInput): Promise<ConfigParamEntity> {
    const now = nowIso();
    const filter: Document =
      input.scope === "global"
        ? { scope: "global", user_id: null, module: input.module, param_name: input.param_name }
        : { scope: "user", user_id: input.user_id, module: input.module, param_name: input.param_name };

    const id = await this.nextConfigParamId();
    await this.col("meta_config_params").findOneAndUpdate(
      filter,
      {
        $set: {
          param_value: input.param_value,
          description: input.description,
          updated_at: now,
        },
        $setOnInsert: {
          id,
          scope: input.scope,
          user_id: input.scope === "user" ? input.user_id : null,
          module: input.module,
          param_name: input.param_name,
          created_at: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    const result = await this.getConfigParam(
      input.scope,
      input.scope === "user" ? input.user_id! : null,
      input.module,
      input.param_name,
    );
    return result!;
  }

  async listConfigParams(filter: ListConfigParamsFilter): Promise<ConfigParamEntity[]> {
    const query: Document = { module: filter.module };

    if (filter.scope) {
      query.scope = filter.scope;
    }
    if (filter.userId) {
      query.$or = [
        { scope: "global" },
        { scope: "user", user_id: filter.userId },
      ];
    }
    if (filter.paramNames && filter.paramNames.length > 0) {
      query.param_name = { $in: filter.paramNames };
    }

    const docs = await this.col("meta_config_params")
      .find(query, PROJECT_NO_ID)
      .sort({ scope: 1, param_name: 1 })
      .toArray();
    return docs as unknown as ConfigParamEntity[];
  }

  // ── InstanceUpstreamConfig (v2 model group) ─────────────────────────────────
  //
  // Semantically equivalent to the SQLite implementation; concurrent writes are backstopped by the `version` optimistic lock + the singleton UNIQUE index.
  // The agents global-uniqueness check uses SELECT-all → in-memory computation; writes use findOneAndUpdate({version}),
  // and on match failure (optimistic lock conflict) retry up to 3 times, then throw version_mismatch if still failing.

  private async nextInstanceUpstreamConfigId(): Promise<number> {
    const result = await this.col("meta_counters").findOneAndUpdate(
      { _id: "meta_instance_upstream_config" } as any,
      { $inc: { seq: 1 } },
      { upsert: true, returnDocument: "after" },
    );
    return (result as any).seq as number;
  }

  async getInstanceUpstreamGroup(groupId: string): Promise<InstanceUpstreamConfigEntity | null> {
    return this.col<InstanceUpstreamConfigEntity>("meta_instance_upstream_config").findOne(
      { group_id: groupId } as Document,
      PROJECT_NO_ID,
    ) as Promise<InstanceUpstreamConfigEntity | null>;
  }

  async listInstanceUpstreamGroups(
    filter?: InstanceUpstreamConfigFilter,
    seedIfEmpty?: SupportedAgent[],
  ): Promise<InstanceUpstreamConfigEntity[]> {
    // v1 legacy cleanup: the v1-era field names (agent_source/type) are completely different from v2 (group_id/group_type).
    // Existing data is not migrated on upgrade to v2 (design doc §10.3 explicitly says "rollback cost is acceptable"); this is the safety net:
    // one-time delete of old documents in the database without group_id, to avoid confusing the seed check and the groups_list result.
    // Idempotent operation; on a new database deletedCount=0 with no side effects.
    await this._sweepLegacyV1Docs();

    if (seedIfEmpty && seedIfEmpty.length > 0) {
      await this.ensureDefaultSeeded(seedIfEmpty);
      // default already exists → go through diff-append sync (option E, semantically equivalent to SQLite)
      await this._syncDefaultAgentsWithSnapshotMongo(seedIfEmpty);
    }

    const query: Document = {};
    if (filter?.group_type) query.group_type = filter.group_type;
    const docs = await this.col("meta_instance_upstream_config")
      .find(query, PROJECT_NO_ID)
      .toArray();
    // Ordering: default → custom → extraction, and within the same type updated_at DESC
    const rank: Record<string, number> = { default: 0, custom: 1, extraction: 2 };
    docs.sort((a, b) => {
      const ra = rank[String((a as Document).group_type)] ?? 9;
      const rb = rank[String((b as Document).group_type)] ?? 9;
      if (ra !== rb) return ra - rb;
      return String((b as Document).updated_at).localeCompare(String((a as Document).updated_at));
    });
    return docs.map((d) => this.mapMongoGroup(d as Document));
  }

  /**
   * Idempotent seed: if the default row does not exist, write one row (agents=supported, mode=official).
   * Shared by list and all write paths (create/update/toggle/delete + extraction/*).
   * Semantically equivalent to SQLite ensureDefaultSeeded.
   */
  async ensureDefaultSeeded(supported: SupportedAgent[]): Promise<void> {
    if (!supported || supported.length === 0) return;
    const hasDefault = await this.col("meta_instance_upstream_config").findOne(
      { group_type: "default" } as Document,
      { projection: { _id: 1 } },
    );
    if (hasDefault) return;
    // Use the UNIQUE partial index (group_type='default') as a concurrency backstop: failure means someone else just finished seeding.
    try {
      const id = await this.nextInstanceUpstreamConfigId();
      const now = nowIso();
      const agentsList = Array.from(new Set(supported.map((a) => a.agent_source))).sort();
      await this.col("meta_instance_upstream_config").insertOne({
        id,
        group_id: this.newGroupId("default"),
        group_type: "default",
        name: DEFAULT_GROUP_NAME,
        agents: agentsList,
        enabled: true,
        mode: "official",
        base_url: "",
        api_key: "",
        model_id: "",
        description: "",
        version: 1,
        supported_agents_snapshot: agentsList,   // at seed time snapshot = agents
        created_at: now,
        updated_at: now,
      } as Document);
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 11000) throw err;
      // else: concurrent seed → ignore
    }
  }

  async createInstanceUpstreamGroup(
    input: CreateInstanceUpstreamGroupInput,
  ): Promise<InstanceUpstreamConfigEntity> {
    const agents = input.agents ?? [];

    // 1. Singleton constraint
    if (input.group_type === "default" || input.group_type === "extraction") {
      const existing = await this.col("meta_instance_upstream_config").findOne(
        { group_type: input.group_type } as Document,
        { projection: { _id: 1 } },
      );
      if (existing) {
        throw new InstanceUpstreamWriteConflictError(
          input.group_type === "default" ? "default_already_exists" : "extraction_already_exists",
          `${input.group_type} group already exists in this instance`,
        );
      }
    }

    // 2. agents global uniqueness
    if (input.group_type !== "extraction") {
      await this.assertAgentsNotOverlapMongo(agents, null);
    }

    // 2b. Group name global uniqueness (custom only; default/extraction use the fixed names from seed and do not trigger it)
    //     Historical dirty data is not cleaned, only new writes are blocked -- see design doc §5.3 (v2.8).
    if (input.group_type === "custom") {
      await this.assertGroupNameUniqueMongo(input.name ?? "", null);
    }

    const now = nowIso();
    const id = await this.nextInstanceUpstreamConfigId();
    const groupId = this.newGroupId(input.group_type);
    try {
      await this.col("meta_instance_upstream_config").insertOne({
        id,
        group_id: groupId,
        group_type: input.group_type,
        name: input.name ?? "",
        agents,
        enabled: input.enabled === false ? false : true,
        mode: input.mode,
        base_url: input.base_url ?? "",
        api_key: input.api_key ?? "",
        model_id: input.model_id ?? "",
        description: input.description ?? "",
        version: 1,
        supported_agents_snapshot: [],   // custom/extraction always []; default is written by the seed path
        created_at: now,
        updated_at: now,
      } as Document);
    } catch (err) {
      const code = (err as { code?: number })?.code;
      const keyPattern = (err as { keyPattern?: Record<string, unknown> })?.keyPattern;
      if (code === 11000 && keyPattern && "group_type" in keyPattern) {
        // Concurrent create of default/extraction
        throw new InstanceUpstreamWriteConflictError(
          input.group_type === "default" ? "default_already_exists" : "extraction_already_exists",
          `${input.group_type} group already exists (concurrent write)`,
        );
      }
      throw err;
    }
    return (await this.getInstanceUpstreamGroup(groupId))!;
  }

  async updateInstanceUpstreamGroup(
    input: UpdateInstanceUpstreamGroupInput,
  ): Promise<InstanceUpstreamConfigEntity> {
    // 3 optimistic lock retries
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.getInstanceUpstreamGroup(input.group_id);
      if (!current) {
        throw new InstanceUpstreamWriteConflictError(
          "group_not_found",
          `group not found: ${input.group_id}`,
        );
      }
      if (current.group_type !== input.expected_group_type) {
        throw new InstanceUpstreamWriteConflictError(
          "group_type_mismatch",
          `expected ${input.expected_group_type}, actual ${current.group_type}`,
          { expected: input.expected_group_type, actual: current.group_type },
        );
      }
      const effectiveExpectedVersion = input.expected_version ?? current.version;
      if (input.expected_version !== undefined && input.expected_version !== current.version) {
        throw new InstanceUpstreamWriteConflictError(
          "version_mismatch",
          `version mismatch: expected ${input.expected_version}, actual ${current.version}`,
          { expected: input.expected_version, actual: current.version },
        );
      }
      const nextAgents = input.agents ?? current.agents;
      if (input.agents !== undefined && current.group_type !== "extraction") {
        await this.assertAgentsNotOverlapMongo(nextAgents, current.group_id);
      }

      // name change → validate global uniqueness (custom only; default/extraction are blocked by the service layer, with a safety check here)
      //
      // Historical dirty data exemption: if the trimmed name equals current.name (the frontend sends back the original value), do not trigger the duplicate check,
      // avoiding breaking the "ignore what was already duplicated before" convention via the update path. See §5.3 (v2.8).
      if (
        input.name !== undefined
        && current.group_type === "custom"
        && (input.name ?? "").trim() !== (current.name ?? "").trim()
      ) {
        await this.assertGroupNameUniqueMongo(input.name, current.group_id);
      }

      const now = nowIso();
      const setDoc: Document = { updated_at: now };
      if (input.name !== undefined) setDoc.name = input.name;
      if (input.agents !== undefined) setDoc.agents = input.agents;
      if (input.enabled !== undefined) setDoc.enabled = input.enabled;
      if (input.mode !== undefined) setDoc.mode = input.mode;
      if (input.base_url !== undefined) setDoc.base_url = input.base_url;
      if (input.api_key !== undefined) setDoc.api_key = input.api_key;
      if (input.model_id !== undefined) setDoc.model_id = input.model_id;
      if (input.description !== undefined) setDoc.description = input.description;

      const result = await this.col("meta_instance_upstream_config").updateOne(
        { group_id: input.group_id, version: effectiveExpectedVersion } as Document,
        { $set: setDoc, $inc: { version: 1 } },
      );
      if ((result.matchedCount ?? 0) === 1) {
        return (await this.getInstanceUpstreamGroup(input.group_id))!;
      }
      // Match failed: a concurrent write got there first. If expected_version was explicitly passed → conflict immediately, otherwise retry.
      if (input.expected_version !== undefined) {
        throw new InstanceUpstreamWriteConflictError(
          "version_mismatch",
          `concurrent write during update`,
          { attempt },
        );
      }
    }
    throw new InstanceUpstreamWriteConflictError(
      "version_mismatch",
      "concurrent write exceeded retry limit",
    );
  }

  async toggleInstanceUpstreamGroup(
    input: ToggleInstanceUpstreamGroupInput,
  ): Promise<InstanceUpstreamConfigEntity> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.getInstanceUpstreamGroup(input.group_id);
      if (!current) {
        throw new InstanceUpstreamWriteConflictError(
          "group_not_found",
          `group not found: ${input.group_id}`,
        );
      }
      const effectiveExpectedVersion = input.expected_version ?? current.version;
      if (input.expected_version !== undefined && input.expected_version !== current.version) {
        throw new InstanceUpstreamWriteConflictError(
          "version_mismatch",
          `version mismatch: expected ${input.expected_version}, actual ${current.version}`,
          { expected: input.expected_version, actual: current.version },
        );
      }
      const now = nowIso();
      const result = await this.col("meta_instance_upstream_config").updateOne(
        { group_id: input.group_id, version: effectiveExpectedVersion } as Document,
        { $set: { enabled: input.enabled, updated_at: now }, $inc: { version: 1 } },
      );
      if ((result.matchedCount ?? 0) === 1) {
        return (await this.getInstanceUpstreamGroup(input.group_id))!;
      }
      if (input.expected_version !== undefined) {
        throw new InstanceUpstreamWriteConflictError(
          "version_mismatch",
          `concurrent write during toggle`,
        );
      }
    }
    throw new InstanceUpstreamWriteConflictError(
      "version_mismatch",
      "concurrent write exceeded retry limit",
    );
  }

  async deleteInstanceUpstreamGroup(input: DeleteInstanceUpstreamGroupInput): Promise<boolean> {
    const result = await this.col("meta_instance_upstream_config").deleteOne(
      { group_id: input.group_id } as Document,
    );
    return (result.deletedCount ?? 0) > 0;
  }

  private async assertAgentsNotOverlapMongo(
    candidate: string[],
    selfGroupId: string | null,
  ): Promise<void> {
    if (candidate.length === 0) return;
    const candidateSet = new Set(candidate);
    const rows = await this.col("meta_instance_upstream_config")
      .find({ group_type: { $in: ["default", "custom"] } } as Document, {
        projection: { _id: 0, group_id: 1, group_type: 1, name: 1, agents: 1 },
      })
      .toArray();
    const conflicts: Array<{ group_id: string; group_type: string; name: string; overlapping_agents: string[] }> = [];
    for (const r of rows) {
      const doc = r as Document;
      const gid = String(doc.group_id);
      if (gid === selfGroupId) continue;
      const existing = Array.isArray(doc.agents) ? (doc.agents as string[]) : [];
      const overlap = existing.filter((a) => candidateSet.has(a));
      if (overlap.length > 0) {
        conflicts.push({
          group_id: gid,
          group_type: String(doc.group_type),
          name: String(doc.name ?? ""),
          overlapping_agents: overlap,
        });
      }
    }
    if (conflicts.length > 0) {
      throw new InstanceUpstreamWriteConflictError(
        "agents_overlap",
        `agents overlap with ${conflicts.length} existing group(s)`,
        { conflict_groups: conflicts },
      );
    }
  }

  /**
   * Validate that the group name (after trim) does not conflict with any other group (including the reserved names of default / extraction).
   * SQLite-symmetric version: case-sensitive, exact match after whitespace trim. History dirty data is not cleaned, only new writes are blocked.
   * See design doc §5.3 (v2.8).
   */
  private async assertGroupNameUniqueMongo(
    candidateName: string,
    selfGroupId: string | null,
  ): Promise<void> {
    const candidate = (candidateName ?? "").trim();
    if (!candidate) return;
    const rows = await this.col("meta_instance_upstream_config")
      .find({} as Document, {
        projection: { _id: 0, group_id: 1, group_type: 1, name: 1 },
      })
      .toArray();
    for (const r of rows) {
      const doc = r as Document;
      const gid = String(doc.group_id);
      if (gid === selfGroupId) continue;
      if (String(doc.name ?? "").trim() === candidate) {
        throw new InstanceUpstreamWriteConflictError(
          "name_duplicate",
          `group name "${candidate}" is already used by another group in this instance`,
          {
            conflict_group: {
              group_id: gid,
              group_type: String(doc.group_type),
              name: String(doc.name ?? ""),
            },
          },
        );
      }
    }
  }

  /**
   * Clean up v1 leftovers: documents + the v1 UNIQUE(agent_source,type) index.
   *
   * If the `agent_source_1_type_1` index created in the v1 era is not dropped, v2 writes (missing agent_source/type) would be
   * treated by MongoDB as `{agent_source: null, type: null}` → the second v2 insert hits E11000.
   *
   * Three idempotent steps, run only once per process (tracked with legacyV1Swept):
   *   1. dropIndex('agent_source_1_type_1') -- IndexNotFound (code 27) silently swallowed when absent
   *   2. deleteMany({group_id: {\$exists: false}}) -- v1 documents have no group_id
   *   3. later calls to ensureIndex will restore the (group_id / group_type) indexes that v2 needs
   *
   * v1→v2 is a historical migration action; after the data plane switches to v2 there will be no more v1 writes, and scanning once at process start
   * is enough. Previously running on every list cost 2 Mongo network round trips (~150ms), the main contributor
   * to the ~400ms steady-state list latency. A process restart runs it once more as a safety net, leaving no window.
   */
  private async _sweepLegacyV1Docs(): Promise<void> {
    if (this.legacyV1Swept) return; // this process has already swept, return directly

    // 1. Drop the v1 UNIQUE index (if still there)
    try {
      await this.col("meta_instance_upstream_config").dropIndex("agent_source_1_type_1");
      console.warn("[metadata-mongo] dropped v1-legacy index agent_source_1_type_1");
    } catch (err) {
      const code = (err as { code?: number })?.code;
      if (code !== 27 && code !== 26) {
        // 27 = IndexNotFound, 26 = NamespaceNotFound (the collection has not even been created)
        console.warn(
          `[metadata-mongo] dropIndex agent_source_1_type_1 unexpected code=${code}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // 2. Delete v1 leftover documents
    try {
      const result = await this.col("meta_instance_upstream_config").deleteMany(
        { group_id: { $exists: false } } as Document,
      );
      const deleted = result.deletedCount ?? 0;
      if (deleted > 0) {
        console.warn(
          `[metadata-mongo] swept ${deleted} v1-legacy instance-upstream docs (no group_id field)`,
        );
      }
    } catch (err) {
      console.warn(
        `[metadata-mongo] _sweepLegacyV1Docs deleteMany failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // After finishing this pass (dropIndex success or IndexNotFound both count as done) → mark, and later lists in this process skip it directly.
    // Mark even if deleteMany fails: retrying repeatedly is pointless for 500-class errors, a process restart is more appropriate.
    this.legacyV1Swept = true;
  }

  /**
   * Option E: diff-append sync between default.agents and the full supported-agents set (Mongo version).
   * Semantics are exactly the same as SqliteMetadataStore._syncDefaultAgentsWithSnapshot.
   * Concurrency: updateOne WHERE version=<the one read>, failing silently (the next list will retry).
   */
  private async _syncDefaultAgentsWithSnapshotMongo(supported: SupportedAgent[]): Promise<void> {
    const supportedNames = Array.from(new Set(supported.map((a) => a.agent_source))).sort();
    const supportedSet = new Set(supportedNames);

    const doc = await this.col("meta_instance_upstream_config").findOne(
      { group_type: "default" } as Document,
      { projection: { _id: 0, id: 1, group_id: 1, agents: 1, supported_agents_snapshot: 1, version: 1 } },
    );
    if (!doc) return;
    const d = doc as Document;
    const currentAgents = Array.isArray(d.agents) ? (d.agents as string[]) : [];
    const currentSnapshot = Array.isArray(d.supported_agents_snapshot)
      ? (d.supported_agents_snapshot as string[]) : [];
    const version = Number(d.version ?? 1);
    const now = nowIso();

    // Scenario B: snapshot empty (existing instance migration) → only fill snapshot, do not change agents
    if (currentSnapshot.length === 0) {
      await this.col("meta_instance_upstream_config").updateOne(
        { group_type: "default", version } as Document,
        { $set: { supported_agents_snapshot: supportedNames, updated_at: now } },
      );
      return;
    }

    // Scenario C/D/E: diff computation
    const newAgents = supportedNames.filter((a) => !currentSnapshot.includes(a));
    const snapshotShrunk = currentSnapshot.some((a) => !supportedSet.has(a));
    if (newAgents.length === 0 && !snapshotShrunk) return;

    // Compute the new agents, excluding those already occupied by a custom group
    const nextAgents = [...currentAgents];
    if (newAgents.length > 0) {
      const customDocs = await this.col("meta_instance_upstream_config")
        .find({ group_type: "custom" } as Document, { projection: { _id: 0, agents: 1 } })
        .toArray();
      const customUsed = new Set<string>();
      for (const c of customDocs) {
        const arr = Array.isArray((c as Document).agents) ? ((c as Document).agents as string[]) : [];
        for (const a of arr) customUsed.add(a);
      }
      for (const a of newAgents) {
        if (!customUsed.has(a) && !nextAgents.includes(a)) nextAgents.push(a);
      }
    }

    await this.col("meta_instance_upstream_config").updateOne(
      { group_type: "default", version } as Document,
      {
        $set: {
          agents: nextAgents,
          supported_agents_snapshot: supportedNames,
          updated_at: now,
        },
        $inc: { version: 1 },
      },
    );
  }

  private newGroupId(gt: GroupType): string {
    const prefix = gt === "default" ? "dflt" : gt === "extraction" ? "ext" : "grp";
    return generateId(prefix);
  }

  private mapMongoGroup(doc: Document): InstanceUpstreamConfigEntity {
    return {
      id: Number(doc.id),
      group_id: String(doc.group_id),
      group_type: String(doc.group_type) as GroupType,
      name: String(doc.name ?? ""),
      agents: Array.isArray(doc.agents) ? (doc.agents as string[]) : [],
      enabled: Boolean(doc.enabled),
      mode: String(doc.mode) as UpstreamMode,
      base_url: String(doc.base_url ?? ""),
      api_key: String(doc.api_key ?? ""),
      model_id: String(doc.model_id ?? ""),
      description: String(doc.description ?? ""),
      version: Number(doc.version ?? 1),
      supported_agents_snapshot: Array.isArray(doc.supported_agents_snapshot)
        ? (doc.supported_agents_snapshot as string[]) : [],
      created_at: String(doc.created_at),
      updated_at: String(doc.updated_at),
    };
  }
}
