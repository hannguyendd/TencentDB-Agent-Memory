/**
 * per-key mutex -- makes async operations on the same key run serially, while different keys run fully concurrently.
 *
 * Used for R-M-W operations such as KvBindingRepo.touchLastSeen / KvExtractStore.incrBy,
 * eliminating contention **within a single node**. For the cross-node scenario see the analysis in migration plan section 6.2 (the business can accept the precision loss).
 *
 * Implementation idea: maintain a Promise chain per key; withPerKeyLock appends the new task to the old chain's tail.
 * After the task finishes, if it is still the chain tail, delete it -- avoiding holding dead entries long-term.
 */
const inflight = new Map<string, Promise<unknown>>();

export function withPerKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(key) ?? Promise.resolve();
  // Use fn in both positions -- both reject/fulfill must wait serially, to prevent a later task
  // from leaking ahead of the old chain after one throws.
  const cur = prev.then(fn, fn) as Promise<T>;
  // tail is used to register the chain tail & clean up; convert rejection to resolved to avoid "unhandled rejection" warnings.
  // The real error is still returned to the caller via cur.
  const tail: Promise<void> = cur.then(() => {}, () => {}).finally(() => {
    if (inflight.get(key) === tail) inflight.delete(key);
  });
  inflight.set(key, tail);
  return cur;
}

/** Test only: clear all in-flight locks (does not wait for completion; await them yourself afterwards). */
export function __resetPerKeyLocksForTests(): void {
  inflight.clear();
}
