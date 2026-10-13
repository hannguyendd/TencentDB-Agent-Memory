/**
 * WikiService — async orchestration of wiki assets (symmetric with CodeGraphService).
 *
 * IKnowledgeStore (metadata/state) + BuildQueue (background serial) + an injectable worker
 * (the actual ingest / index building). State machine: pending → processing(scanning/ingesting)
 * → ready / failed(+sync_error). memory + team isolation, idempotency (same memory+team+name returns the existing one),
 * soft delete + directory cleanup. Physical directory {dataRoot}/{service_id}/{team_id}/{wiki_id}/ (001 multi-tenancy).
 *
 * File layer (finalized in doc 11): raw / page each have a set of ls/read/write/rm, aligned with the L2 Scenario.
 * - raw/* only operates on raw/sources/, does not trigger ingest.
 * - page/* operates on wiki/; writes automatically inject frontmatter `locked: true`; delete calls
 *   the lib-layer cascadeDeleteWikiPagesWithRefs for reference-level cascading.
 */

import { join, resolve, normalize, dirname } from "node:path";
import {
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
} from "node:fs";
import { randomUUID } from "node:crypto";

import type {
  AuditAction,
  IKnowledgeStore,
  WikiRow,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import {
  initIndexDb,
  withWriteDb,
  getReadDb,
  evictWikiDb,
  upsertSource,
  listSources,
  deleteSources,
  sha256,
  type SourceStatus,
} from "../engines/wiki/index-db.js";

export interface WikiBuildContext {
  wikiId: string;
  serviceId: string;
  teamId: string;
  name: string;
  dir: string;
  setInternalStatus: (s: string) => void;
  /** Single ingest generation; shared by progress/terminal callbacks, to guard against late packets at Panel */
  ingestRunId: string;
}

export interface WikiBuildResult {
  pageCount?: number;
}

export type WikiWorker = (ctx: WikiBuildContext) => Promise<WikiBuildResult | void>;

/**
 * ingest result (discriminated union):
 *   - ok        enqueued for rebuild (no in-flight task);
 *   - queued    already in flight; per onBusy:'replace' the old task is cancelled and the new task queued (design 2026-09-21 §3.3);
 *   - not_found memory/team/id mismatch;
 *   - busy      currently pending/processing and onBusy:'reject' (concurrent rejection, maps to HTTP 409),
 *               step is the internal phase (may be null).
 */
export type IngestResult =
  | { kind: "ok"; row: WikiRow }
  | { kind: "queued"; row: WikiRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

/**
 * ingest behavior options (design 2026-09-21 §3.3).
 * onBusy only takes effect when the wiki already has an in-flight task (status ∈ {pending, processing}):
 *   - 'reject' (default): reject, return busy (original semantics; auto-sync/CLI/sync alias remain unchanged);
 *   - 'replace': set the cancelled marker + internal_status='cancelling', and put the new task
 *     into the SerialQueue (FIFO). After the old worker returns, the checkpoint does preserveRaw wrap-up.
 */
export interface IngestOptions {
  onBusy?: "reject" | "replace";
}

export interface WikiServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface WikiServiceOptions {
  store: IKnowledgeStore;
  dataRoot: string;
  worker: WikiWorker;
  queue?: BuildQueue;
  logger?: WikiServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: {
    tmcCallbackUrl: string;
    /** Per-instance LLM resolver for summary generation (keyed by service_id). */
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
}

export interface CreateWikiParams {
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

// ── File layer result types (aligned with yaml schema) ──

export interface RawFileEntry {
  filename: string;
  size: number;
  /** Source file lifecycle status (uploaded/ingested/failed, design 003). */
  status: SourceStatus;
  /** First upload time (unchanged afterwards). */
  created_at: string;
  /** Time of the most recent content change. */
  updated_at: string;
  /** user_id of the last modifier (no history log). */
  last_modified_by: string | null;
  /** Time of the most recent successful extraction (null if never extracted). */
  ingested_at: string | null;
  /** @deprecated Compatibility with the old field; equals created_at. */
  uploaded_at: string;
}

export interface RawWriteResult {
  filename: string;
  size: number;
}

export interface RawReadItem {
  filename: string;
  content?: string;
  not_found?: boolean;
}

export interface RawWriteManyItem {
  filename: string;
  size: number;
}

export interface RawRmResult {
  deleted_files: string[];
  deleted_pages: string[];
  rewritten_pages: number;
}

/**
 * Import filename mapping file structure (`<wikiDir>/import-map.json`).
 * providerId → (externalId → on-disk filename).
 * Compatible with two value shapes: a string (current write form) or { filename } (historical/future extension).
 */
export interface ImportNameMapFile {
  version: 1;
  providers: Record<
    string,
    Record<string, string | { filename: string; title?: string }>
  >;
}

export interface PageWriteResult {
  ref: string;
  locked_injected: boolean;
}

export interface PageReadItem {
  ref: string;
  content?: string;
  not_found?: boolean;
}

export interface PageWriteManyItem {
  ref: string;
  locked_injected: boolean;
}

export interface PageRmResult {
  deleted_pages: string[];
  rewritten_files: number;
}

/**
 * Return wrapper for write operations:
 * - `null`: wiki does not exist or does not belong to memory/team
 * - `"processing"`: wiki is currently in processing state, write rejected
 * - `"invalid_path"`: path traversal validation failed
 * - `"forbidden_path"`: wrote to a forbidden path such as a structural file
 * - `"too_large"`: exceeded the size limit
 * - otherwise: the actual result object
 */
export type WriteOutcome<T> =
  | T
  | null
  | "processing"
  | "invalid_path"
  | "forbidden_path"
  | "too_large";

const PAGE_WRITE_MAX_BYTES = 512 * 1024;
const RAW_WRITE_MAX_BYTES = 5 * 1024 * 1024;
const PAGE_RM_MAX = 20;
const RAW_RM_MAX = 50;
const RAW_READ_MAX = 50;
const RAW_WRITE_MAX = 50;
const PAGE_READ_MAX = 20;
const PAGE_WRITE_MAX = 20;

/** Structural files under wiki/ that page/write and page/rm may not touch (with or without .md). */
const PAGE_FORBIDDEN_REFS = new Set([
  "index",
  "schema",
  "purpose",
  "wiki/index",
  "wiki/schema",
  "wiki/purpose",
]);

export class WikiService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: WikiWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: WikiServiceLogger;
  private readonly callbackConfig?: {
    tmcCallbackUrl: string;
    resolveLlm: (serviceId: string) => import("../config.js").LlmConfig;
  };
  /**
   * Abort marker (generational, design 2026-09-21 §3.3).
   *
   * key = wiki_id, value = the version of the ingest **generation that was aborted**.
   *
   * Why generational: onBusy:'replace' **immediately enqueues the new task** after setting the marker, and
   * in the SerialQueue the old and new tasks share the same wiki_id key. If it only checked "is there a marker",
   * the new task's runBuild entry checkpoint would treat itself as "aborted" and abort directly,
   * leaving the wiki stuck in draft and ingest never executing. With version:
   *   - the old task carries version=N, the marker holds N → hit, abort;
   *   - the new task carries version=N+1, the marker still holds N → no hit, runs normally.
   *
   * When delete() triggers, -1 is used as a sentinel (matches any generation, because the row will be hard-deleted,
   * and all subsequently queued tasks should abort).
   *
   * In-memory only (same id is serialized by SerialQueue + Node being single-threaded, so reads/writes have no concurrency).
   * Removed after wrap-up.
   */
  private readonly cancelled = new Map<string, number>();

  /** Abort sentinel for delete: matches any generation. */
  private static readonly CANCEL_ALL_VERSIONS = -1;

  constructor(opts: WikiServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
  }

  dirFor(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dataRoot, serviceId, teamId, wikiId);
  }

  /**
   * Create wiki metadata + directory shell. **Does not auto-ingest**.
   * Idempotent: the same (service_id, team_id, name) returns the existing row.
   */
  create(params: CreateWikiParams): { row: WikiRow; existed: boolean } {
    const { row, existed } = this.store.createWiki(params);
    if (!existed) {
      const dir = this.dirFor(row.service_id, row.team_id, row.wiki_id);
      mkdirSync(join(dir, "raw", "sources"), { recursive: true });
      // Explicitly create index.db (4 tables, including source) — afterwards rawWrite/rawLs read/write the source table directly (design 006/003).
      try {
        initIndexDb(dir);
      } catch (err) {
        this.logger?.warn?.(`[wiki] initIndexDb failed for ${row.wiki_id}: ${String(err)}`);
      }
      this.audit(row, "create", `create wiki ${row.name}`, params.user_id);
    }
    return { row, existed };
  }

  /** Persist service_url for a wiki. Returns updated row or null. */
  updateServiceUrl(serviceId: string, wikiId: string, serviceUrl: string): WikiRow | null {
    this.store.updateWikiStatus(serviceId, wikiId, { service_url: serviceUrl });
    return this.store.getWikiById(serviceId, wikiId);
  }

  /** Update wiki metadata (name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, wikiId: string, patch: { name?: string; summary?: string | null }): WikiRow | null {
    return this.store.updateWikiMeta(serviceId, wikiId, patch);
  }

  /**
   * Explicitly trigger ingest (LLM processes raw → page + builds index).
   * Returns immediately; runs asynchronously in the background. memory/team mismatch returns not_found.
   *
   * When there is already an in-flight task (pending/processing), behavior is decided by opts.onBusy (design 2026-09-21 §3.3):
   *   - 'reject' (default): return busy (HTTP 409), do not overwrite state, do not write audit — original semantics;
   *   - 'replace': set the cancelled marker + internal_status='cancelling', and put the new task into
   *     the SerialQueue (FIFO). When the old worker returns, the runBuild checkpoint does preserveRaw wrap-up
   *     (status reset to draft, keeping the wiki row and raw); after the new task is dequeued it proceeds normally with scanning.
   *     This way "cancel the old task + queue the new task" completes atomically within one call, with no intermediate dirty state.
   */
  ingest(
    serviceId: string,
    teamId: string,
    wikiId: string,
    requesterUserId?: string,
    opts?: IngestOptions,
  ): IngestResult {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return { kind: "not_found" };

    const inFlightStatus = row.status === "pending" || row.status === "processing" ? row.status : null;
    if (inFlightStatus && opts?.onBusy !== "replace") {
      // Concurrent rejection: reject directly if queued/executing; do not overwrite state, do not re-enqueue, do not write audit.
      return { kind: "busy", status: inFlightStatus, step: row.internal_status };
    }
    const inFlight = inFlightStatus !== null;

    if (inFlight) {
      // replace semantics: abort only **the current generation** (row.version); the new task at version+1 is unaffected;
      // also set the cancelling intermediate state for the frontend to perceive.
      this.cancelled.set(wikiId, row.version);
      this.store.updateWikiStatus(serviceId, wikiId, { internal_status: "cancelling" });
    }

    const nextVersion = row.version + 1;
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", inFlight ? "ingest (replace)" : "manual ingest", requesterUserId);
    const fresh = this.store.getWiki(serviceId, teamId, wikiId);
    if (fresh) this.enqueueBuild(fresh);
    if (!fresh) return { kind: "not_found" };
    return inFlight ? { kind: "queued", row: fresh } : { kind: "ok", row: fresh };
  }

  /** sync semantics = re-run ingest (explicitly triggered by the admin plane). Keeps reject semantics unchanged. */
  sync(serviceId: string, teamId: string, wikiId: string, requesterUserId?: string): IngestResult {
    return this.ingest(serviceId, teamId, wikiId, requesterUserId);
  }

  get(serviceId: string, teamId: string, wikiId: string): WikiRow | null {
    return this.store.getWiki(serviceId, teamId, wikiId);
  }

  /** Query by globally unique wiki_id (still converge by service_id to prevent cross-tenant). Dedicated to the spec id-only endpoints. */
  getById(serviceId: string, wikiId: string): WikiRow | null {
    return this.store.getWikiById(serviceId, wikiId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): WikiRow[] {
    return this.store.listWikis(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countWikis(serviceId, teamId, opts);
  }

  /**
   * Delete a wiki (008 / 007 §5.5). Can be deleted in any state (including pending/processing).
   * memory/team mismatch returns false; otherwise hard delete + four-kind resource cleanup, returns true.
   *
   * If the resource is queued/executing, first set the cancelled marker to notify the worker to abort at a checkpoint, then immediately
   * hard delete + clean up (without waiting for the worker). Before the worker finishes it re-checks and, on finding it deleted, skips ready/callbacks and does
   * one more idempotent cleanup, leaving no residue.
   */
  delete(serviceId: string, teamId: string, wikiId: string): boolean {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return false;

    if (row.status === "pending" || row.status === "processing") {
      // Sentinel -1: delete hard-deletes the row, so all queued generations should abort.
      this.cancelled.set(wikiId, WikiService.CANCEL_ALL_VERSIONS);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, wikiId);
    // The cancelled marker is not deleted here (covers the window where delete precedes the worker checkpoint);
    // finishCancelled removes it when the worker finishes. cleanup is idempotent, so repeating is harmless.
    return true;
  }

  /**
   * Idempotent cleanup of four kinds of resources (order: release connections first, then delete disk). Each step has its own try/catch, exception-safe.
   *   1. index.db read connection pool: evictWikiDb (idempotent; the worker's withWriteDb finally already closes the write connection)
   *   2. metadata row: hard delete (safe even when 0 rows are hit, supporting double cleanup by worker + delete)
   *   3. disk directory (wiki/ raw/ index.db and -wal/-shm): rmSync recursive+force (idempotent)
   * BuildQueue queued tasks skip by the runBuild entry check of cancelled/row existence; nothing to handle here.
   */
  private cleanupResources(serviceId: string, teamId: string, wikiId: string): void {
    try {
      evictWikiDb(wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] evict index.db failed ${wikiId}: ${String(err)}`);
    }
    try {
      this.store.deleteWiki(serviceId, teamId, wikiId);
    } catch (err) {
      this.logger?.warn?.(`[wiki] hard-delete row failed ${wikiId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, wikiId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[wiki] rm dir failed ${wikiId}: ${String(err)}`);
    }
  }

  /**
   * Worker checkpoint: whether this build should abort.
   *
   * Dual criteria (covering both the delete-during-run and delete-already-done timings):
   *   1. The generational cancelled marker hit: the marker generation is -1 (delete sentinel, matches any generation),
   *      or equals the version at the time this task was enqueued (replace precisely hits the old generation);
   *   2. The row no longer exists in the DB.
   *
   * Generation comparison ensures the **new task enqueued by replace is not harmed by the marker it triggered itself**.
   */
  private isDeleted(serviceId: string, wikiId: string, version: number): boolean {
    const marked = this.cancelled.get(wikiId);
    const cancelledHit =
      marked !== undefined &&
      (marked === WikiService.CANCEL_ALL_VERSIONS || marked === version);
    return cancelledHit || this.store.getWikiById(serviceId, wikiId) === null;
  }

  /**
   * Wrap-up after the worker checkpoint judges "should abort" (idempotent).
   *
   * opts.preserveRaw=true (design 2026-09-21 §3.3.2, triggered by ingest(onBusy:'replace')):
   *   only reset status to draft — keep the wiki metadata row, raw, and already-ready pages,
   *   for the subsequent new task to continue via incremental diff. No deletion is performed.
   *
   * opts.preserveRaw=false or omitted (original delete trigger):
   *   evict the read connection pool + hard delete the metadata row + rmSync the disk directory (the cleanupResources trio).
   *
   * Both branches remove the cancelled marker.
   */
  private finishCancelled(
    serviceId: string,
    teamId: string,
    wikiId: string,
    opts?: { preserveRaw?: boolean },
  ): void {
    if (opts?.preserveRaw) {
      // Reset to draft only if "the current row is still of this generation (version <= the cancelled generation)".
      //
      // If the new task has already bumped the version (on replace, ingest() immediately does version+1 and sets
      // pending), the new task has taken over this row — in that case we **must never** reset, otherwise the new
      // task's pending would be overwritten into draft, and the frontend would see a false window of "to be processed/queued",
      // when in fact the old worker overwrote the new task's state. Just yield and do nothing; the new task's state is driven by itself.
      const current = this.store.getWikiById(serviceId, wikiId);
      const cancelledVersion = this.cancelled.get(wikiId);
      const superseded =
        current !== null &&
        cancelledVersion !== undefined &&
        cancelledVersion !== WikiService.CANCEL_ALL_VERSIONS &&
        current.version > cancelledVersion;
      if (superseded) {
        this.logger?.info?.(
          `[wiki] ${wikiId} old build aborted; newer ingest (v${current?.version}) already owns status, leaving as-is`,
        );
      } else {
        this.store.updateWikiStatus(serviceId, wikiId, {
          status: "draft",
          internal_status: null,
          sync_error: "cancelled by user",
        });
        this.logger?.info?.(`[wiki] ${wikiId} build aborted (replaced by newer ingest; raw preserved)`);
      }
    } else {
      this.cleanupResources(serviceId, teamId, wikiId);
      this.logger?.info?.(`[wiki] ${wikiId} build aborted (deleted during processing)`);
    }
    this.cancelled.delete(wikiId);
  }

  /**
   * Determine the trigger source of this abort:
   *   - wiki row still exists → triggered by ingest(onBusy:'replace') → preserveRaw (keep raw);
   *   - wiki row already deleted → triggered by delete() → hard delete.
   *
   * Note: cannot distinguish directly with isDeleted() (it is a dual criterion of cancelled marker OR row missing);
   * must check separately whether the row exists.
   */
  private isCancelledByReplace(serviceId: string, wikiId: string): boolean {
    return this.store.getWikiById(serviceId, wikiId) !== null;
  }

  /** Write a wiki audit record. Failure does not block the main flow. */
  private audit(row: WikiRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendWikiAudit({
        service_id: row.service_id,
        asset_id: row.wiki_id,
        version: row.version,
        action,
        // Prefer recording the trigger (the initiator of ingest/create), fall back to the row's creator.
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] audit ${action} failed: ${String(err)}`);
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // File layer — raw/* (materials under raw/sources/)
  // ═══════════════════════════════════════════════════════════════════

  /** List material files under raw/sources/ (now queries the source table, design 003 §3.5). Returns null if the wiki does not exist. */
  rawLs(serviceId: string, teamId: string, wikiId: string): RawFileEntry[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      const db = getReadDb(wikiId, dir);
      return listSources(db).map((s) => ({
        filename: s.filename,
        size: s.size,
        status: s.status,
        created_at: s.created_at,
        updated_at: s.updated_at,
        last_modified_by: s.last_modified_by,
        ingested_at: s.ingested_at,
        uploaded_at: s.created_at, // compat with the old field
      }));
    } catch {
      // index.db has not been created yet (old wiki / never rawWrite) → no source registration.
      return [];
    }
  }

  /** Read the original text of a single raw file. Returns null if the file does not exist (including when the wiki does not exist). */
  rawRead(serviceId: string, teamId: string, wikiId: string, filename: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Batch read raw files.
   * - wiki does not exist → null
   * - any filename path traversal → "invalid_path"
   * - exceeds RAW_READ_MAX → throws (router converts to 400)
   * A single missing file is not an error; the corresponding item is marked not_found:true (spec: the whole is still 200).
   */
  rawReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): WriteOutcome<RawReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (filenames.length > RAW_READ_MAX) {
      throw new Error(`filenames exceeds max ${RAW_READ_MAX}`);
    }
    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    // Validate path legality for all first (if any is illegal the whole batch is 400)
    const safePaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: RawReadItem[] = [];
    for (let i = 0; i < filenames.length; i++) {
      const filename = filenames[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ filename, content });
      } catch {
        items.push({ filename, not_found: true });
      }
    }
    return items;
  }

  /**
   * Write/overwrite a single raw file (upsert) + register in the source table (design 003 §3.4).
   * - wiki does not exist → null
   * - in processing → "processing"
   * - path traversal → "invalid_path"
   * - over 5MB → "too_large"
   */
  rawWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filename: string,
    content: string,
    userId?: string,
  ): WriteOutcome<RawWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    // Note: this **deliberately does not block processing**. The design 2026-09-21 "import and extract" requires
    // "a new import overrides the old import": while extraction is in progress, importing again must be allowed to write raw, otherwise
    // 409 "wiki is processing; cannot write/delete" would block the import.
    // Safety: the following ingest(onBusy:'replace') cancels the old task, and the page
    // results it produced are discarded by the runBuild checkpoint; the new task rescans all raw by sha256 diff
    // (skipping those already ingested with unchanged sha), so no dirty data lands in the DB.

    const size = Buffer.byteLength(content, "utf-8");
    if (size > RAW_WRITE_MAX_BYTES) return "too_large";

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    const safe = this.resolveRawPath(sourcesDir, filename);
    if (!safe) return "invalid_path";

    mkdirSync(sourcesDir, { recursive: true });
    writeFileSync(safe, content, "utf-8");
    this.registerSources(serviceId, teamId, wikiId, [{ filename, content, size }], userId);
    return { filename, size };
  }

  /**
   * Batch write raw files (the whole batch is atomic).
   * - Validate all first: path traversal → "invalid_path"; any item over 5MB → "too_large"
   * - After all pass, write to disk file by file; if any write fails, roll back files already written (delete the ones that did not previously exist,
   *   restore the others), ensuring the whole batch either all succeeds or none takes effect.
   * Error codes same as rawWrite.
   */
  rawWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string }[],
    userId?: string,
  ): WriteOutcome<RawWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    // Same as above (rawWrite): deliberately does not block processing, to support overwrite-writing on "re-import during extraction".
    if (files.length > RAW_WRITE_MAX) {
      throw new Error(`files exceeds max ${RAW_WRITE_MAX}`);
    }

    const sourcesDir = join(this.dirFor(serviceId, teamId, wikiId), "raw", "sources");
    type Plan = {
      filename: string;
      safePath: string;
      content: string;
      size: number;
      preExistingContent: string | null; // record pre-existing content before writing, to restore on rollback
    };
    const plans: Plan[] = [];
    for (const { filename, content } of files) {
      if (typeof content !== "string") return "invalid_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > RAW_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolveRawPath(sourcesDir, filename);
      if (!safe) return "invalid_path";
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ filename, safePath: safe, content, size, preExistingContent: pre });
    }

    mkdirSync(sourcesDir, { recursive: true });
    const written: Plan[] = [];
    try {
      for (const p of plans) {
        writeFileSync(p.safePath, p.content, "utf-8");
        written.push(p);
      }
    } catch (err) {
      // Rollback: restore each written file's old content (delete if it did not exist)
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // If rollback also fails, the only option is to log and let the caller re-run ingest as a fallback
        }
      }
      throw err;
    }

    // After all writes succeed, register in the source table (query first then update; idempotent when sha is unchanged).
    this.registerSources(
      serviceId,
      teamId,
      wikiId,
      plans.map((p) => ({ filename: p.filename, content: p.content, size: p.size })),
      userId,
    );
    // After the pull lands on disk, bump version + update last_sync_at (design §3.1 ⑥).
    // - version is used by downstream change detection (at ingest, compare source file version vs the extracted version)
    // - last_sync_at is used as an external-sync observation point ("last pull time")
    // Idempotent: even if all files' contents are identical, writing to disk + registering still runs, and the version still advances;
    //   this is the SoT (wiki table state) expected behavior: once raw has been written it counts as a new version,
    //   and downstream ingest decides whether to really re-extract (skip if sha is the same).
    if (plans.length > 0) {
      this.store.updateWikiStatus(serviceId, wikiId, {
        version: row.version + 1,
        last_sync_at: new Date().toISOString(),
      });
    }
    return plans.map(({ filename, size }) => ({ filename, size }));
  }

  // ─────────────────────────────────────────────────────────────
  // Import filename mapping (externalId → filename)
  //
  // Background: the on-disk filename of wiki import (wiki-source) is taken from the document **title** (good readability),
  // but titles change, and a "title" is not a stable identity. Scheduled sync re-pulls everything each round, and the dedupe group is only valid within a single round,
  // so after a remote rename the following happens: the new title → a new file is created; another doc still using the old title → reuses the old filename and overwrites it,
  // causing content mix-up + leftover junk files, with no warning at all.
  //
  // Solution: persist provider+externalId → filename into import-map.json under the wiki directory.
  // Already-imported documents reuse the old filename; the title is only for display. Storage lives here (rather than in import-runner) because
  // only this class holds dataRoot / dirFor(), so callers needn't pass the path through.
  // ─────────────────────────────────────────────────────────────

  /** Mapping file path: `<wikiDir>/import-map.json`. */
  private importMapPath(serviceId: string, teamId: string, wikiId: string): string {
    return join(this.dirFor(serviceId, teamId, wikiId), "import-map.json");
  }

  /**
   * Read a provider's filename mapping.
   * File missing/corrupt → return an empty object (degrades to the old "generate by title" behavior, does not block the import).
   */
  readImportNameMap(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
  ): Record<string, string> {
    try {
      const p = this.importMapPath(serviceId, teamId, wikiId);
      if (!existsSync(p)) return {};
      const parsed = JSON.parse(readFileSync(p, "utf-8")) as ImportNameMapFile | null;
      const providers = parsed?.providers;
      if (!providers || typeof providers !== "object") return {};
      const m = providers[providerId];
      // Compatible with the old structure: the value may be a { filename } object
      if (!m || typeof m !== "object") return {};
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(m)) {
        const fn = typeof v === "string" ? v : v?.filename;
        if (typeof fn === "string" && fn) out[k] = fn;
      }
      return out;
    } catch {
      return {};
    }
  }

  /**
   * Write back a provider's filename mapping (overwrite the whole thing).
   * Write failure is only logged — the file itself is already on disk; losing the mapping only affects name reuse in the next round, and does not block the current import.
   */
  writeImportNameMap(
    serviceId: string,
    teamId: string,
    wikiId: string,
    providerId: string,
    map: Record<string, string>,
  ): void {
    try {
      const p = this.importMapPath(serviceId, teamId, wikiId);
      let file: ImportNameMapFile = { version: 1, providers: {} };
      if (existsSync(p)) {
        try {
          const parsed = JSON.parse(readFileSync(p, "utf-8")) as ImportNameMapFile | null;
          if (parsed && typeof parsed === "object" && parsed.providers) file = parsed;
        } catch {
          // Rebuild entirely if corrupt
        }
      }
      file.providers[providerId] = map;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(file, null, 2), "utf-8");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger?.warn?.(`import-map write failed: ${msg}`);
    }
  }

  /**
   * Batch delete raw files + cascade cleanup of downstream pages.
   * Calls the lib-layer deleteSourceFiles, which decides the pages' fate internally.
   * - wiki does not exist → null
   * - processing → "processing"
   * - filenames contain path traversal → "invalid_path"
   * - over 50 → throws (router converts to 400)
   */
  async rawRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    filenames: string[],
  ): Promise<WriteOutcome<RawRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (filenames.length > RAW_RM_MAX) {
      throw new Error(`filenames exceeds max ${RAW_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const sourcesDir = join(projectPath, "raw", "sources");
    const fullPaths: string[] = [];
    for (const fn of filenames) {
      const safe = this.resolveRawPath(sourcesDir, fn);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    // Custom cascade delete: delete the raw source and clean up pages referencing it (driven by frontmatter sources).
    const { deleteSourceFiles } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await deleteSourceFiles(projectPath, fullPaths, {
      logReason: "wiki/raw/rm",
    });

    // Delete the corresponding source rows (matching the file-level cascade delete, design 003 §5).
    try {
      initIndexDb(projectPath);
      withWriteDb(projectPath, (db) => deleteSources(db, filenames));
    } catch (err) {
      this.logger?.warn?.(`[wiki] source rows delete failed: ${String(err)}`);
    }

    return {
      deleted_files: filenames,
      deleted_pages: result.deletedWikiPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_pages: result.rewrittenSourcePages,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // File layer — page/* (processed pages under wiki/)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * List page files under wiki/ (recursive scan of .md to take frontmatter).
   * Returns an empty array when status≠ready.
   */
  pageLs(serviceId: string, teamId: string, wikiId: string): { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status !== "ready") return [];

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const wikiDir = join(projectPath, "wiki");
    if (!existsSync(wikiDir)) return [];

    const items: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[] = [];
    this.scanPagesRecursive(wikiDir, wikiDir, items);
    return items;
  }

  /** Read the original text of a single page. ref can be a page id or relPath. */
  pageRead(serviceId: string, teamId: string, wikiId: string, ref: string): string | null {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref);
    if (!safe) return null;
    try {
      return readFileSync(safe, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Batch read page originals.
   * - wiki does not exist → null
   * - any ref path traversal → "invalid_path"
   * - exceeds PAGE_READ_MAX → throws
   * A single missing ref is not an error; the corresponding item is marked not_found:true (spec: the whole is still 200).
   */
  pageReadMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): WriteOutcome<PageReadItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (refs.length > PAGE_READ_MAX) {
      throw new Error(`refs exceeds max ${PAGE_READ_MAX}`);
    }
    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safePaths: string[] = [];
    for (const r of refs) {
      // Reading can't use allowMissing — not_found must also be a legal path, so here
      // distinguish "path legal but file doesn't exist (not_found)" from "path illegal (invalid_path)"
      const safe = this.resolvePageRef(projectPath, r, { allowMissing: true });
      if (!safe) return "invalid_path";
      safePaths.push(safe);
    }
    const items: PageReadItem[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      try {
        const content = readFileSync(safePaths[i], "utf-8");
        items.push({ ref, content });
      } catch {
        items.push({ ref, not_found: true });
      }
    }
    return items;
  }

  /**
   * Write/overwrite a single page (upsert). Automatically injects `locked: true` into frontmatter.
   * - wiki does not exist → null
   * - processing → "processing"
   * - path traversal → "invalid_path"
   * - structural file → "forbidden_path"
   * - over 512KB → "too_large"
   */
  pageWrite(
    serviceId: string,
    teamId: string,
    wikiId: string,
    ref: string,
    content: string,
  ): WriteOutcome<PageWriteResult> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";

    const size = Buffer.byteLength(content, "utf-8");
    if (size > PAGE_WRITE_MAX_BYTES) return "too_large";

    if (this.isForbiddenPageRef(ref)) return "forbidden_path";

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
    if (!safe) return "invalid_path";

    const { content: finalContent, lockedInjected } = injectLockedTrue(content);

    mkdirSync(join(safe, ".."), { recursive: true });
    writeFileSync(safe, finalContent, "utf-8");
    return { ref, locked_injected: lockedInjected };
  }

  /**
   * Batch write pages (the whole batch is atomic). Each item automatically gets frontmatter `locked: true` injected.
   * - Validate all first: processing → "processing"; path traversal → "invalid_path";
   *   structural file → "forbidden_path"; over 512KB → "too_large"
   * - After all pass, write to disk file by file; if any fails, roll back files already written.
   */
  pageWriteMany(
    serviceId: string,
    teamId: string,
    wikiId: string,
    pages: { ref: string; content: string }[],
  ): WriteOutcome<PageWriteManyItem[]> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (pages.length > PAGE_WRITE_MAX) {
      throw new Error(`pages exceeds max ${PAGE_WRITE_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    type Plan = {
      ref: string;
      safePath: string;
      finalContent: string;
      lockedInjected: boolean;
      preExistingContent: string | null;
    };
    const plans: Plan[] = [];
    for (const { ref, content } of pages) {
      if (typeof content !== "string") return "invalid_path";
      if (this.isForbiddenPageRef(ref)) return "forbidden_path";
      const size = Buffer.byteLength(content, "utf-8");
      if (size > PAGE_WRITE_MAX_BYTES) return "too_large";
      const safe = this.resolvePageRef(projectPath, ref, { allowMissing: true });
      if (!safe) return "invalid_path";
      const { content: finalContent, lockedInjected } = injectLockedTrue(content);
      let pre: string | null = null;
      try {
        pre = readFileSync(safe, "utf-8");
      } catch {
        pre = null;
      }
      plans.push({ ref, safePath: safe, finalContent, lockedInjected, preExistingContent: pre });
    }

    const written: Plan[] = [];
    try {
      for (const p of plans) {
        mkdirSync(join(p.safePath, ".."), { recursive: true });
        writeFileSync(p.safePath, p.finalContent, "utf-8");
        written.push(p);
      }
    } catch (err) {
      for (const p of written) {
        try {
          if (p.preExistingContent === null) {
            rmSync(p.safePath, { force: true });
          } else {
            writeFileSync(p.safePath, p.preExistingContent, "utf-8");
          }
        } catch {
          // best-effort rollback
        }
      }
      throw err;
    }

    return plans.map(({ ref, lockedInjected }) => ({ ref, locked_injected: lockedInjected }));
  }

  /**
   * Batch delete pages + cascade cleanup of references. Calls the lib-layer cascadeDeleteWikiPagesWithRefs.
   * - wiki does not exist → null
   * - processing → "processing"
   * - contains path traversal → "invalid_path"
   * - contains structural files → "forbidden_path"
   * - over 20 → throws
   */
  async pageRm(
    serviceId: string,
    teamId: string,
    wikiId: string,
    refs: string[],
  ): Promise<WriteOutcome<PageRmResult>> {
    const row = this.store.getWiki(serviceId, teamId, wikiId);
    if (!row) return null;
    if (row.status === "processing") return "processing";
    if (refs.length > PAGE_RM_MAX) {
      throw new Error(`refs exceeds max ${PAGE_RM_MAX}`);
    }

    const projectPath = this.dirFor(serviceId, teamId, wikiId);
    const fullPaths: string[] = [];
    for (const r of refs) {
      if (this.isForbiddenPageRef(r)) return "forbidden_path";
      const safe = this.resolvePageRef(projectPath, r);
      if (!safe) return "invalid_path";
      fullPaths.push(safe);
    }

    const { cascadeDeleteWikiPagesWithRefs } = await import(
      "../engines/wiki/ingest-v2/cascade.js"
    );
    const result = await cascadeDeleteWikiPagesWithRefs(projectPath, fullPaths);

    return {
      deleted_pages: result.deletedPaths.map((p: string) =>
        this.absToPageRef(projectPath, p),
      ),
      rewritten_files: result.rewrittenFiles,
    };
  }

  // ═══════════════════════════════════════════════════════════════════
  // Internal helpers
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Register a batch of source files in the source table (used by rawWrite/rawWriteMany).
   * Ensures index.db exists (idempotent initIndexDb); in one write transaction upsertSource for each file
   * (query first then update: create as uploaded / reset to uploaded if sha changed / idempotent if sha unchanged).
   * Registration failure does not block the main write-to-disk flow (the file is already on disk) — log a warn, and leave it to later ingest/rawLs as a fallback.
   */
  private registerSources(
    serviceId: string,
    teamId: string,
    wikiId: string,
    files: { filename: string; content: string; size: number }[],
    userId?: string,
  ): void {
    const dir = this.dirFor(serviceId, teamId, wikiId);
    try {
      initIndexDb(dir);
      withWriteDb(dir, (db) => {
        for (const f of files) {
          upsertSource(db, {
            filename: f.filename,
            sha256: sha256(f.content),
            size: f.size,
            userId: userId ?? null,
          });
        }
      });
    } catch (err) {
      this.logger?.warn?.(`[wiki] source register failed for ${wikiId}: ${String(err)}`);
    }
  }

  private resolveRawPath(sourcesDir: string, filename: string): string | null {
    if (!filename || filename.includes("..") || filename.startsWith("/")) return null;
    const normalized = normalize(filename);
    if (normalized.startsWith("..") || normalized.startsWith("/")) return null;
    // resolve(sourcesDir) converts to an absolute path, to avoid a failed comparison against the resolved absolute path
    // when sourcesDir is relative (e.g. KNOWLEDGE_DATA_DIR=./data).
    const base = resolve(sourcesDir);
    const safe = resolve(base, normalized);
    const dirWithSep = base.endsWith("/") ? base : base + "/";
    if (safe !== base && !safe.startsWith(dirWithSep)) return null;
    return safe;
  }

  /**
   * Resolve a page ref (id or relPath) → absolute path. Must fall under the wiki/ subtree.
   * - allowMissing=true is for write; a non-existent path is still allowed
   * - allowMissing=false is for read/rm; requires the file to exist
   */
  private resolvePageRef(
    projectPath: string,
    ref: string,
    opts: { allowMissing?: boolean } = {},
  ): string | null {
    if (!ref || ref.includes("..") || ref.startsWith("/")) return null;
    const cleanRef = ref.replace(/^wiki\//, "");
    if (cleanRef.includes("..")) return null;

    // resolve into an absolute path, to avoid a failed comparison when projectPath is relative.
    const wikiDir = resolve(projectPath, "wiki");
    const wikiDirSep = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";

    // Try as-is first, then try appending the .md extension.
    const candidates = cleanRef.endsWith(".md") ? [cleanRef] : [cleanRef + ".md", cleanRef];
    for (const c of candidates) {
      const safe = resolve(wikiDir, c);
      if (safe !== wikiDir && !safe.startsWith(wikiDirSep)) continue;
      if (opts.allowMissing) {
        // write path appends .md: allow either one
        return c.endsWith(".md") ? safe : null;
      }
      if (existsSync(safe)) return safe;
    }
    if (opts.allowMissing) {
      // When no .md candidate matched, force appending .md
      const safe = resolve(wikiDir, cleanRef.endsWith(".md") ? cleanRef : cleanRef + ".md");
      if (safe === wikiDir || !safe.startsWith(wikiDirSep)) return null;
      return safe;
    }
    return null;
  }

  /** Convert an absolute wiki/.../page.md path back to a ref (e.g. "concepts/redis"). */
  private absToPageRef(projectPath: string, abs: string): string {
    const wikiDir = resolve(projectPath, "wiki");
    const prefix = wikiDir.endsWith("/") ? wikiDir : wikiDir + "/";
    if (!abs.startsWith(prefix)) return abs;
    return abs.slice(prefix.length).replace(/\.md$/, "");
  }

  private isForbiddenPageRef(ref: string): boolean {
    const cleanRef = ref.replace(/^wiki\//, "").replace(/\.md$/, "");
    return PAGE_FORBIDDEN_REFS.has(cleanRef) || PAGE_FORBIDDEN_REFS.has(`wiki/${cleanRef}`);
  }

  private scanPagesRecursive(
    baseDir: string,
    dir: string,
    out: { id: string; title: string; type: string; path: string; description?: string; locked?: boolean }[],
  ): void {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (entry === "media") continue;
        this.scanPagesRecursive(baseDir, full, out);
        continue;
      }
      if (!entry.endsWith(".md")) continue;
      let content = "";
      try {
        content = readFileSync(full, "utf-8");
      } catch {
        continue;
      }
      const rel = full.slice(baseDir.length + 1).replace(/\\/g, "/");
      const id = rel.replace(/\.md$/, "");
      const fm = parseFrontmatterMin(content);
      out.push({
        id,
        title: fm.title || entry.replace(/\.md$/, "").replace(/-/g, " "),
        type: fm.type || "other",
        path: `wiki/${rel}`,
        ...(fm.description ? { description: fm.description } : {}),
        locked: fm.locked,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════

  private enqueueBuild(row: WikiRow): void {
    // The generational version is enqueued with the task: runBuild compares it against the cancelled marker,
    // so a replace-newly-enqueued task (larger version) is not harmed by an old generation's marker.
    const version = row.version;
    this.queue.enqueue(row.wiki_id, () =>
      this.runBuild(row.service_id, row.wiki_id, row.team_id, row.name, version),
    );
  }

  private async runBuild(
    serviceId: string,
    wikiId: string,
    teamId: string,
    name: string,
    version: number,
  ): Promise<void> {
    // Entry checkpoint: aborted while pending → skip, do not set processing, do not ingest.
    // preserveRaw is decided by the trigger source: replace (row still exists) keeps raw, delete (row gone) hard deletes.
    if (this.isDeleted(serviceId, wikiId, version)) {
      this.finishCancelled(serviceId, teamId, wikiId, {
        preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
      });
      return;
    }
    this.store.updateWikiStatus(serviceId, wikiId, {
      status: "processing",
      internal_status: "scanning",
      sync_error: null,
    });
    // Progress/terminal callbacks share the same generation, so Panel can reject late progress after a clear
    const ingestRunId = randomUUID();
    try {
      const result = await this.worker({
        wikiId,
        serviceId,
        teamId,
        name,
        dir: this.dirFor(serviceId, teamId, wikiId),
        setInternalStatus: (s) =>
          this.store.updateWikiStatus(serviceId, wikiId, { status: "processing", internal_status: s }),
        ingestRunId,
      });
      // Pre-finish checkpoint: aborted while processing → skip ready/audit/callbacks, idempotent wrap-up.
      if (this.isDeleted(serviceId, wikiId, version)) {
        this.finishCancelled(serviceId, teamId, wikiId, {
          preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
        });
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        page_count: result?.pageCount ?? null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getWikiById(serviceId, wikiId);
      if (synced) {
        this.audit(synced, "ready", result?.pageCount != null ? `pages: ${result.pageCount}` : null);
      }
      this.logger?.info?.(`[wiki] ${wikiId} ready (pages: ${result?.pageCount ?? '?'})`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, ingestRunId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The worker threw, but if it was aborted in the meantime, treat as cancellation rather than failure: skip failed state/callbacks, do wrap-up.
      if (this.isDeleted(serviceId, wikiId, version)) {
        this.finishCancelled(serviceId, teamId, wikiId, {
          preserveRaw: this.isCancelledByReplace(serviceId, wikiId),
        });
        return;
      }
      this.store.updateWikiStatus(serviceId, wikiId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getWikiById(serviceId, wikiId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[wiki] ${wikiId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, ingestRunId);
    }
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: WikiRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    ingestRunId?: string,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via LLM (attempted even if some sources failed — generated as long as there are pages)
      try {
        const pages = this.pageLs(row.service_id, row.team_id, row.wiki_id) ?? [];
        this.logger?.info?.(`[wiki] summary generation start (wikiId=${row.wiki_id}, pages=${pages.length}, status=${status})`);
        const { generateWikiSummary } = await import("../callback.js");
        summary = await generateWikiSummary(
          row.wiki_id,
          row.name,
          pages.map((p) => ({ title: p.title, description: p.description })),
          this.callbackConfig.resolveLlm(row.service_id),
        );
        this.logger?.info?.(`[wiki] summary generation done (wikiId=${row.wiki_id}, len=${summary?.length ?? 0}, empty=${!summary})`);
        if (summary) {
          this.store.updateWikiStatus(row.service_id, row.wiki_id, { summary });
        }
      } catch (err) {
        this.logger?.warn?.(`[wiki] summary generation failed: ${String(err)}`);
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.wiki_id,
        service_id: row.service_id,
        type: "wiki",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
        ...(ingestRunId ? { run_id: ingestRunId } : {}),
      },
      this.callbackConfig,
    );
  }

  async onIdle(wikiId?: string): Promise<void> {
    await this.queue.onIdle(wikiId);
  }
}

// ─── Module-level helpers (no class state dependency, easy to unit-test) ───

/** Minimal frontmatter parsing (take title/type/description/locked), in the same style as manager. */
function parseFrontmatterMin(content: string): { title: string; type: string; description: string; locked: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  const fm = fmMatch ? fmMatch[1] : "";
  const titleMatch = fm.match(/^title:\s*["']?(.+?)["']?\s*$/m);
  const typeMatch = fm.match(/^type:\s*["']?(.+?)["']?\s*$/m);
  // description is written by ingest-v2 (see engines/wiki/ingest-v2/frontmatter.ts),
  // a one-sentence summary of the page — better at conveying content than the title, used to generate the wiki summary.
  const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);
  const lockedMatch = fm.match(/^locked:\s*(true|false)\s*$/m);
  return {
    title: titleMatch ? titleMatch[1].trim() : "",
    type: typeMatch ? typeMatch[1].trim().toLowerCase() : "",
    description: descMatch ? descMatch[1].trim() : "",
    locked: lockedMatch ? lockedMatch[1] === "true" : false,
  };
}

/**
 * Inject `locked: true` into frontmatter:
 * - With frontmatter: if a locked: field already exists, force it to true; otherwise append a line at the end of frontmatter
 * - Without frontmatter: wrap a frontmatter at the very top of the file (containing only locked: true)
 *
 * Returns { content, lockedInjected }; lockedInjected indicates whether **this time** the locked
 * field was actually added/changed (already true counts as lockedInjected=false, since nothing changed).
 */
function injectLockedTrue(content: string): { content: string; lockedInjected: boolean } {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    const wrapped = `---\nlocked: true\n---\n${content.startsWith("\n") ? content.slice(1) : content}`;
    return { content: wrapped, lockedInjected: true };
  }
  const fmBody = fmMatch[1];
  const lockedMatch = fmBody.match(/^locked:\s*(true|false)\s*$/m);
  if (lockedMatch) {
    if (lockedMatch[1] === "true") return { content, lockedInjected: false };
    const newFmBody = fmBody.replace(/^locked:\s*(true|false)\s*$/m, "locked: true");
    return {
      content: content.replace(fmBody, newFmBody),
      lockedInjected: true,
    };
  }
  const newFmBody = fmBody.endsWith("\n") ? `${fmBody}locked: true` : `${fmBody}\nlocked: true`;
  return {
    content: content.replace(fmBody, newFmBody),
    lockedInjected: true,
  };
}

export const __testing = { parseFrontmatterMin, injectLockedTrue };
