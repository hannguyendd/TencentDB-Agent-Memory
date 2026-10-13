/**
 * Per-wiki `index.db` connection management (design 006).
 *
 * Each wiki has its own SQLite file `index.db`, placed under that wiki's data directory (same directory and
 * lifecycle as the body `.md` files), holding all of this wiki's private index data:
 *   - `wiki_fts`   FTS5 pre-tokenized inverted index (BM25 full-text search)
 *   - `page_meta`  page metadata (title/type/rel_path/snippet; body is not stored in the DB, it stays on disk)
 *   - `graph_edge` directed edges of the knowledge graph (for multi-hop BFS)
 *   - `source`     source file as a first-class entity (incremental decisions + lifecycle; DDL is created this round, read/write methods are in phase 003)
 *
 * Connection strategy (design §4):
 *   - Write (ingest/sync: rebuild FTS5 + graph_edge + update source): **dedicated connection**, finished within a transaction
 *     -> `wal_checkpoint(TRUNCATE)` -> `close()`, not put in the pool, avoiding races with read-pool LRU eviction.
 *   - Read (search/graph): goes through the **LRU connection pool**; hot wikis stay resident, cold wikis are evicted.
 *
 * Memory cap = POOL_MAX x cache_size (about 600MB), decoupled from the total number of wikis; opening a SQLite connection
 * is sub-millisecond and data is loaded lazily per page rather than "fully into memory on open", which is exactly what cures the MiniSearch 20GB OOM.
 *
 * fd constraint (design §4.3): WAL takes 3 fds per connection (db+wal+shm), so `POOL_MAX × 3 + headroom` must be <= ulimit -n.
 * POOL_MAX is tied to the deployment ulimit, default 300 (about 900 fds; ulimit -n >= 2048 recommended).
 */

import Database from "better-sqlite3";
import { LRUCache } from "lru-cache";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Read connection pool cap. Tied to the deployment ulimit (WAL takes 3 fds per connection; need ulimit -n >= POOL_MAX*3 + headroom).
 * Can be overridden via an environment variable (only for tests or special deployment environments), default 300.
 */
const POOL_MAX = (() => {
  const raw = process.env.KNOWLEDGE_WIKI_POOL_MAX;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 300;
})();

/** Per-connection page cache cap (KB); cache_size uses a negative number to mean KB. */
const CACHE_KB = 2000;

/** Evict/close a read connection: checkpoint first to merge the WAL, then close. Fails silently (the connection may be corrupted). */
function disposeDb(db: Database.Database): void {
  try {
    if (db.open) {
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.close();
    }
  } catch {
    /* best-effort: the connection may already be closed or the file deleted */
  }
}

/**
 * Read connection LRU pool (lru-cache, MIT): hot wiki connections stay resident, cold wikis are evicted.
 * Both eviction (exceeding max) and explicit `delete` (wiki deletion) trigger `dispose` -> checkpoint + close.
 */
const readPool = new LRUCache<string, Database.Database>({
  max: POOL_MAX,
  dispose: (db) => disposeDb(db),
});

/** Pragmas set uniformly when each connection is opened (design §4.2). */
function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL"); // many readers, single writer; ingest does not block reads during search
  db.pragma("synchronous = NORMAL"); // safe and fast under WAL
  db.pragma(`cache_size = -${CACHE_KB}`); // per-connection page cache cap (negative = KB)
  db.pragma("busy_timeout = 5000"); // wait at most 5s for the write lock, avoiding occasional SQLITE_BUSY
}

/** Create the 4 tables (idempotent). Only called by initIndexDb (explicit wiki creation). */
function initSchema(db: Database.Database): void {
  // (1) BM25: FTS5 virtual table. Stores the pre-tokenized space-separated token string; the Chinese bigram logic stays in JS tokenize(),
  //    FTS5 uses unicode61 and only splits on whitespace/punctuation (consistent with the config verified in __tests__/bm25-comparison).
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
       page_id UNINDEXED,
       title_tok,
       content_tok,
       tokenize = 'unicode61 remove_diacritics 0'
     );`,
  );

  // (2) Page metadata (returned with search results, excludes body; the body is the .md on disk).
  db.exec(
    `CREATE TABLE IF NOT EXISTS page_meta (
       page_id   TEXT PRIMARY KEY,
       title     TEXT,
       type      TEXT,
       rel_path  TEXT,
       snippet   TEXT
     );`,
  );

  // (3) Graph directed edges (for multi-hop BFS; the small graph is built in memory at query time, graph data is small).
  db.exec(
    `CREATE TABLE IF NOT EXISTS graph_edge (
       source_id TEXT NOT NULL,
       target_id TEXT NOT NULL,
       PRIMARY KEY (source_id, target_id)
     );`,
  );

  // (4) Source management table (003: source file as a first-class entity). The DDL is created this round to keep the schema stable,
  //    read/write methods (readSources/writeSource/markIngested/deleteSource) are added in phase 003.
  db.exec(
    `CREATE TABLE IF NOT EXISTS source (
       filename          TEXT PRIMARY KEY,
       sha256            TEXT NOT NULL,
       size              INTEGER NOT NULL,
       status            TEXT NOT NULL,
       created_at        TEXT NOT NULL,
       updated_at        TEXT NOT NULL,
       last_modified_by  TEXT,
       ingested_at       TEXT,
       ingest_error      TEXT
     );`,
  );
}

function dbPath(wikiDir: string): string {
  return join(wikiDir, "index.db");
}

/**
 * Explicit DB creation: call once in the wiki creation endpoint to create the 4 tables. Idempotent (IF NOT EXISTS).
 * After that, getReadDb / withWriteDb only open existing DBs and do not create tables.
 */
export function initIndexDb(wikiDir: string): void {
  const db = new Database(dbPath(wikiDir));
  applyPragmas(db);
  try {
    initSchema(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

/**
 * Read connection (search/graph): goes through the pool and is reused. The DB must already have been created by initIndexDb.
 * DB does not exist -> throw (treated as "wiki not created correctly / data corrupted"; no silent lazy creation).
 */
export function getReadDb(wikiId: string, wikiDir: string): Database.Database {
  let db = readPool.get(wikiId);
  if (!db || !db.open) {
    const path = dbPath(wikiDir);
    if (!existsSync(path)) {
      throw new Error(`index.db missing (wiki not created?): ${wikiId}`);
    }
    db = new Database(path, { readonly: false });
    applyPragmas(db);
    readPool.set(wikiId, db);
  }
  return db;
}

/**
 * Write connection (ingest/sync/rawWrite): created independently, checkpoint + close after finishing within a transaction, not put in the pool.
 * The rebuild inside `fn` (FTS5 + graph_edge + page_meta + source) completes atomically in the same transaction.
 */
export function withWriteDb<T>(wikiDir: string, fn: (db: Database.Database) => T): T {
  const path = dbPath(wikiDir);
  if (!existsSync(path)) {
    throw new Error(`index.db missing (wiki not created?): ${wikiDir}`);
  }
  const db = new Database(path);
  applyPragmas(db);
  try {
    const out = db.transaction(fn)(db);
    db.pragma("wal_checkpoint(TRUNCATE)");
    return out;
  } finally {
    db.close();
  }
}

/** Wiki deletion: close the read connection first (dispose does checkpoint+close internally), then the caller does rmSync on the directory. */
export function evictWikiDb(wikiId: string): void {
  readPool.delete(wikiId);
}

/** Number of connections currently in the read pool (for tests/observability). */
export function readPoolSize(): number {
  return readPool.size;
}

// ═══════════════════════════════════════════════════════════════════
// source table read/write (design 003: source file as a first-class entity + incremental extraction)
// ═══════════════════════════════════════════════════════════════════

/** Lifecycle status of a single source file (file granularity, unrelated to the wiki-level status). */
export type SourceStatus = "uploaded" | "ingested" | "failed";

/** One row of the source table (returned by rawLs, used for incremental decisions). */
export interface SourceRow {
  filename: string;
  sha256: string;
  size: number;
  status: SourceStatus;
  created_at: string;
  updated_at: string;
  last_modified_by: string | null;
  ingested_at: string | null;
  ingest_error: string | null;
}

/** Compute the content SHA-256 (incremental decisions and source registration share the same sha). */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * rawWrite registers the source (design §3.4, look up then update, not a blind UPSERT). Must be called inside a withWriteDb transaction.
 * - New file -> INSERT, status=uploaded, last_modified_by=creator;
 * - sha changed -> UPDATE, **keeps created_at**, resets to uploaded, records the last modifier, clears ingest_error;
 * - sha unchanged -> idempotent, nothing is touched (same content uploaded again, option a).
 */
export function upsertSource(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; userId?: string | null },
): "created" | "updated" | "unchanged" {
  const now = new Date().toISOString();
  const old = db.prepare("SELECT sha256 FROM source WHERE filename = ?").get(entry.filename) as
    | { sha256: string }
    | undefined;
  if (!old) {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, 'uploaded', ?, ?, ?, NULL, NULL)`,
    ).run(entry.filename, entry.sha256, entry.size, now, now, entry.userId ?? null);
    return "created";
  }
  if (old.sha256 !== entry.sha256) {
    db.prepare(
      `UPDATE source SET sha256 = ?, size = ?, status = 'uploaded', updated_at = ?, last_modified_by = ?, ingest_error = NULL
       WHERE filename = ?`,
    ).run(entry.sha256, entry.size, now, entry.userId ?? null, entry.filename);
    return "updated";
  }
  return "unchanged";
}

/** Read all source rows (rawLs), sorted by filename. */
export function listSources(db: Database.Database): SourceRow[] {
  return db
    .prepare(
      `SELECT filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error
       FROM source ORDER BY filename`,
    )
    .all() as SourceRow[];
}

/** Read the filename -> {sha256, status} map (used for incremental decisions). */
export function readSourceStates(
  db: Database.Database,
): Map<string, { sha256: string; status: SourceStatus }> {
  const rows = db.prepare("SELECT filename, sha256, status FROM source").all() as Array<{
    filename: string;
    sha256: string;
    status: SourceStatus;
  }>;
  const m = new Map<string, { sha256: string; status: SourceStatus }>();
  for (const r of rows) m.set(r.filename, { sha256: r.sha256, status: r.status });
  return m;
}

/** Delete a source row (rawRm / file has disappeared at ingest). Called inside a transaction. */
export function deleteSources(db: Database.Database, filenames: string[]): void {
  if (filenames.length === 0) return;
  const stmt = db.prepare("DELETE FROM source WHERE filename = ?");
  for (const fn of filenames) stmt.run(fn);
}

/**
 * Register the extraction result of a single source after ingest (design §3.6 step 6, called in the same transaction as the index rebuild).
 * - Row exists: only updates status/ingested_at/ingest_error, **does not touch** created_at/updated_at/sha256/size
 *   (sha is maintained by rawWrite and the content is unchanged; updated_at means "content changed", and extraction is not a content change);
 * - No row (source file written to disk directly without rawWrite): INSERT with the on-disk values (created_at=updated_at=now).
 * ok=true -> ingested + ingested_at; ok=false -> failed + ingest_error.
 */
export function recordSourceIngestResult(
  db: Database.Database,
  entry: { filename: string; sha256: string; size: number; ok: boolean; error?: string | null },
): void {
  const now = new Date().toISOString();
  const status: SourceStatus = entry.ok ? "ingested" : "failed";
  const ingestedAt = entry.ok ? now : null;
  const ingestError = entry.ok ? null : (entry.error ?? "unknown").slice(0, 500);
  const exists = db.prepare("SELECT 1 FROM source WHERE filename = ?").get(entry.filename);
  if (exists) {
    db.prepare(
      "UPDATE source SET status = ?, ingested_at = ?, ingest_error = ? WHERE filename = ?",
    ).run(status, ingestedAt, ingestError, entry.filename);
  } else {
    db.prepare(
      `INSERT INTO source(filename, sha256, size, status, created_at, updated_at, last_modified_by, ingested_at, ingest_error)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    ).run(entry.filename, entry.sha256, entry.size, status, now, now, ingestedAt, ingestError);
  }
}

/**
 * Incremental classification (design §3.6 step 3, pure function, easy to unit test):
 * Compare "source files on disk" with "the source table's last state" and decide what happens to each file.
 * - toIngest: new || not successfully extracted (status≠ingested, including uploaded/failed) || sha changed -> needs extraction;
 * - skipped : status=ingested and sha unchanged -> skip the LLM (save tokens);
 * - deleted : present in the table but gone from disk -> to be cascade-deleted + delete the source row.
 */
export function classifySources(
  disk: Array<{ filename: string; sha256: string }>,
  oldStates: Map<string, { sha256: string; status: SourceStatus }>,
): { toIngest: string[]; skipped: string[]; deleted: string[] } {
  const diskNames = new Set(disk.map((d) => d.filename));
  const deleted = [...oldStates.keys()].filter((fn) => !diskNames.has(fn));
  const toIngest: string[] = [];
  const skipped: string[] = [];
  for (const d of disk) {
    const prev = oldStates.get(d.filename);
    if (!prev || prev.status !== "ingested" || prev.sha256 !== d.sha256) toIngest.push(d.filename);
    else skipped.push(d.filename);
  }
  return { toIngest, skipped, deleted };
}
