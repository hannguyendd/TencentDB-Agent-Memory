/**
 * WorkerPermitPool — concurrency semaphore for the memory PipelineWorker.
 *
 * History: it used to be shared across modules (memory PipelineWorker + the old skill V2 worker);
 * after the 2026-07-17 skill refactor the skill side uses an agent-level extract-lock for its concurrency cap,
 * and no longer depends on the semaphore. This pool now has only one consumer, the memory pipeline,
 * and is kept because the memory side still needs it as a queue when concurrency > 1.
 *
 * Semantics:
 *   - capacity is a hard cap
 *   - acquire queues when full; release wakes waiters in FIFO order
 *   - more release than acquire throws (helps locate bugs with unpaired calls)
 *   - destroy wakes all waiters and rejects them (for graceful shutdown)
 */

const TAG = "[worker-permit-pool]";

export class WorkerPermitPool {
  readonly capacity: number;
  private _inFlight = 0;
  private readonly waiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];
  private destroyed = false;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`${TAG} capacity must be a positive integer, got: ${capacity}`);
    }
    this.capacity = capacity;
  }

  /**
   * Acquire a permit. If in-flight has reached capacity, suspend until a release() wakes it.
   * After destroy, acquire rejects immediately.
   */
  acquire(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error(`${TAG} pool destroyed`));
    }
    if (this._inFlight < this.capacity) {
      this._inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  /**
   * Return a permit. If there is a waiter, dequeue it and resolve (in-flight count unchanged);
   * otherwise decrement in-flight.
   *
   * More release than acquire is treated as a programming error and throws to help locate the leak.
   */
  release(): void {
    if (this._inFlight <= 0 && this.waiters.length === 0) {
      throw new Error(`${TAG} release() called with no in-flight permit (unbalanced acquire/release)`);
    }
    const next = this.waiters.shift();
    if (next) {
      // Hand the in-flight slot over to the waiter; the count is unchanged
      next.resolve();
    } else {
      this._inFlight--;
    }
  }

  /** Number of permits currently held. */
  inFlight(): number {
    return this._inFlight;
  }

  /** Number of permits that can be obtained immediately. */
  available(): number {
    return Math.max(0, this.capacity - this._inFlight);
  }

  /** Number of acquires currently queued and waiting. */
  waiting(): number {
    return this.waiters.length;
  }

  /**
   * Destroy the pool: reject all waiters; afterwards acquire rejects immediately.
   * Idempotent.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    const err = new Error(`${TAG} pool destroyed`);
    while (this.waiters.length > 0) {
      const w = this.waiters.shift();
      w?.reject(err);
    }
  }
}
