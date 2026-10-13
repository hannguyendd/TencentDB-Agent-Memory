/**
 * pending-writes - tracks in-flight L0 writes + provides a SIGTERM flush hook + retries.
 *
 * Background: in streaming scenarios recordTdaiTurn must be fire-and-forget (it cannot block closing the SSE
 * stream, otherwise the tail end after the first token feels slow). But fire-and-forget has two ways to lose data:
 *   1. On SIGTERM during a pod rolling update, promises in the event loop are not yet flushed
 *      -> the node process exits directly -> L0 lost
 *   2. The tdai kernel briefly returns 503 / network jitter -> a single failed POST is not retried -> L0 lost
 *
 * This module has two countermeasures:
 *   - `trackWrite(promise)`: registers an in-flight promise in the pending set and removes it on settle.
 *     `flushPendingWrites(deadlineMs)` waits for all in-flight writes to finish or time out.
 *     The SIGTERM handler in index.ts calls it once before shutdown.
 *   - `withL0Retry(fn)`: wraps a single write with up to 3 attempts of exponential-backoff retry, absorbing transient kernel outages.
 *
 * Unchanged:
 *   - The non-streaming path still awaits (tracking also works with await here, with no extra overhead).
 *   - When `recordTdaiTurn(client, identity=null | userMessage=null)`, the client returns
 *     directly and this module does not get involved.
 *
 * Duplicate-write risk: if the first POST reached the tdai kernel but the client timed out reading a 5xx and retried,
 * the kernel may receive two L0 entries with identical content (tdai `/v3/conversation/add` currently has no
 * idempotency-key). Acceptable: better duplicated than lost; and both POST payloads are identical,
 * the L1/L2/L3 distillation pipeline is idempotent (one entry per hash), so only L0 is redundant in observation.
 */

const pendingWrites = new Set<Promise<unknown>>();

/**
 * Registers an in-flight write. Returns the same promise for easy chaining.
 * Removed from the set automatically on settle.
 *
 * Note: `.finally` returns a new promise; if the original p is rejected and the new chain has no catch,
 * Node reports UnhandledRejection (and with --unhandled-rejections=strict even
 * exits the process). Use catch(noop) to swallow the cleanup chain; the original p is left to the caller
 * to catch (the handler does call .catch with pipe.error("TDAI_L0", ...)).
 */
export function trackWrite<T>(p: Promise<T>): Promise<T> {
  pendingWrites.add(p);
  p.finally(() => pendingWrites.delete(p)).catch(() => { /* caller owns rejection */ });
  return p;
}

/** Current number of in-flight writes (for observability/tests). */
export function pendingWriteCount(): number {
  return pendingWrites.size;
}

/**
 * Waits for all in-flight writes to finish or the deadline to expire.
 * Called by the SIGTERM handler; after a timeout it returns the unfinished count for logging (does not block exit).
 */
export async function flushPendingWrites(deadlineMs: number = 10_000): Promise<{
  drained: boolean;
  remaining: number;
}> {
  if (pendingWrites.size === 0) return { drained: true, remaining: 0 };
  const snapshot = [...pendingWrites];
  const settled = Promise.allSettled(snapshot);
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), deadlineMs));
  const outcome = await Promise.race([settled.then(() => "ok" as const), timeout]);
  return { drained: outcome === "ok", remaining: pendingWrites.size };
}

/**
 * Exponential-backoff retry wrapper. For transient tdai kernel outages.
 *
 * Default parameters: 3 total attempts, intervals 500ms -> 1s -> 2s (with jitter).
 * Total max ~3.5s; the pod SIGTERM grace period is usually 30s and flushPendingWrites
 * defaults to a 10s fallback, enough to finish 3 retries.
 *
 * Only retries errors "worth retrying" (network, 5xx, 408, 429); 4xx client errors are thrown directly.
 */
export async function withL0Retry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      const wait = baseMs * (2 ** i) + Math.floor(Math.random() * 200);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr;
}

/**
 * Simple rule: network errors, 5xx, 408/429 are worth retrying; others (400/401/403/404/422) are abandoned immediately.
 * TdaiClient errors are currently of the form `throw new Error(\`tdai POST ... HTTP <code>: <body>\`)`;
 * a regex extracts the status code. If none is found (network drop/timeout), retry by default.
 */
function isRetryable(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Network class: AbortError / ENOTFOUND / ECONNRESET / ETIMEDOUT / fetch failed
  if (/abort|econnreset|enotfound|etimedout|fetch failed|network|timeout/i.test(msg)) return true;
  // HTTP status code class
  const m = msg.match(/HTTP (\d{3})/);
  if (!m) return true; // no status code info -> conservatively retry
  const code = Number(m[1]);
  return code >= 500 || code === 408 || code === 429;
}
