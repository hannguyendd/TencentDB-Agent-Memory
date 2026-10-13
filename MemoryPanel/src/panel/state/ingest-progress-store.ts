/**
 * Fine-grained Wiki ingest progress (in-process memory).
 * Written by KS -> status-callback(event=ingest_progress);
 * read and aggregated by wiki/get; cleared on terminal ready/failed.
 *
 * B-2: carries run_id generation + TTL, to avoid a late "indexing/98" being written back after a terminal clear,
 * which would cause the next round's extracting/0 to be dropped by the monotonic rule and leave the progress bar stuck at 98%.
 *
 * cleared keeps, per wiki, a set of recently cleared runIds (not just the last one),
 * to prevent: clear(run-1) -> write run-2 -> a late run-1 being misjudged as a "new generation" and overwriting.
 */

export interface IngestProgress {
  phase: 'extracting' | 'merging' | 'indexing';
  total: number;
  completed: number;
  failed: number;
  skipped: number;
  percent: number;
}

const PHASE_ORDER = { extracting: 0, merging: 1, indexing: 2 } as const;

/** Default 30min; stale stuck processing leftovers do not occupy a slot forever. */
export const DEFAULT_INGEST_PROGRESS_TTL_MS = 30 * 60 * 1000;

interface StoreEntry {
  runId: string | null;
  progress: IngestProgress;
  updatedAt: number;
}

export interface IngestProgressStoreOptions {
  ttlMs?: number;
  /** Injectable clock, for TTL unit tests */
  now?: () => number;
}

export class IngestProgressStore {
  private readonly store = new Map<string, StoreEntry>();
  /** wikiId -> (runId -> clearedAt); late progress of these generations is rejected */
  private readonly cleared = new Map<string, Map<string, number>>();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts?: IngestProgressStoreOptions) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_INGEST_PROGRESS_TTL_MS;
    this.now = opts?.now ?? Date.now;
  }

  /**
   * Monotonic update: the higher phase wins;
   * for the same phase the higher percent wins;
   * when percent is equal (rounding collision), the larger completed+failed wins, to avoid counts stalling.
   *
   * runId：
   * - falls in the cleared set -> discard (including cross-generation late packets);
   * - same as the current entry (or neither has one) -> apply the monotonic rule;
   * - differs from the current entry and non-empty -> treated as a new ingest round, overwrite directly.
   */
  update(wikiId: string, incoming: IngestProgress, runId?: string | null): void {
    const rid = normalizeRunId(runId);
    this.pruneCleared(wikiId);

    const clearedRuns = this.cleared.get(wikiId);
    if (clearedRuns && clearedRuns.size > 0) {
      if (rid && clearedRuns.has(rid)) return; // late packet of a generation already cleaned at terminal state
      if (!rid) {
        // This wiki was just cleared: late packets without a runId are also discarded, to avoid writing back 98% after clear
        return;
      }
    }

    const prev = this.store.get(wikiId);
    const ts = this.now();
    if (!prev || this.isExpired(prev)) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }

    // New runId -> allowed to restart from extracting/0 (and that rid is not in the cleared set)
    if (rid && prev.runId && rid !== prev.runId) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }
    // Current has no runId, incoming has a runId: treated as a new generation overwriting (upgrade path)
    if (rid && !prev.runId) {
      this.store.set(wikiId, { runId: rid, progress: incoming, updatedAt: ts });
      return;
    }

    const prevOrder = PHASE_ORDER[prev.progress.phase];
    const inOrder = PHASE_ORDER[incoming.phase];
    if (inOrder > prevOrder) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
      return;
    }
    if (inOrder < prevOrder) return;
    if (incoming.percent > prev.progress.percent) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
      return;
    }
    if (incoming.percent < prev.progress.percent) return;
    const prevDone = prev.progress.completed + prev.progress.failed;
    const inDone = incoming.completed + incoming.failed;
    if (inDone > prevDone) {
      this.store.set(wikiId, { runId: prev.runId ?? rid, progress: incoming, updatedAt: ts });
    }
  }

  get(wikiId: string): IngestProgress | null {
    const entry = this.store.get(wikiId);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(wikiId);
      return null;
    }
    return entry.progress;
  }

  /**
   * Terminal cleanup. If a runId is provided (or already on the entry), record it in the cleared set and reject late packets of that generation.
   */
  clear(wikiId: string, runId?: string | null): void {
    const prev = this.store.get(wikiId);
    this.store.delete(wikiId);
    const rid = normalizeRunId(runId) ?? prev?.runId ?? null;
    if (rid) {
      let m = this.cleared.get(wikiId);
      if (!m) {
        m = new Map();
        this.cleared.set(wikiId, m);
      }
      m.set(rid, this.now());
    }
    this.pruneCleared(wikiId);
  }

  private isExpired(entry: StoreEntry): boolean {
    return this.now() - entry.updatedAt > this.ttlMs;
  }

  private pruneCleared(wikiId?: string): void {
    const cutoff = this.now() - this.ttlMs;
    const keys = wikiId ? [wikiId] : [...this.cleared.keys()];
    for (const id of keys) {
      const m = this.cleared.get(id);
      if (!m) continue;
      for (const [run, at] of m) {
        if (at < cutoff) m.delete(run);
      }
      if (m.size === 0) this.cleared.delete(id);
    }
  }
}

function normalizeRunId(runId: string | null | undefined): string | null {
  if (typeof runId !== 'string') return null;
  const t = runId.trim();
  return t.length > 0 ? t : null;
}
