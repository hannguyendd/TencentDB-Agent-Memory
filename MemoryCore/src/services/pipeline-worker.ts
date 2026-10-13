/**
 * PipelineWorker — competing consumption of Pipeline tasks
 *
 * Requirement #12 Worker competing consumption + #13 dead-letter queue and failure handling
 *
 * Architecture doc section Plan C:
 * - XREADGROUP Consumer Group competing consumption of tasks (single queue)
 * - Distributed lock protection: per-session (L1/L2), per-instance (L3)
 * - Lock renewal: renew every 30s, abort on renewal failure
 * - LLM execution + writes: take buffer → call LLM → write VDB/COS
 * - Cascade scheduling: L1→L2 (advance timer via onL1Complete), L2→L3 (enqueue directly)
 * - Dead-letter queue: exceeding the retry limit → write to the dead letters
 * - Retry policy: on lock acquisition failure re-deliver after 5s, LLM timeout exponential backoff 5s/15s/45s
 * - Idempotency: VDB upsert by record_id, COS overwrite
 */

import type { IStateBackend, TaskPayload } from "../core/state/types.js";
import { buildPipelineTimerMember } from "../core/state/timer-member.js";
import { serializeTraceContext } from "../core/report/trace-propagation.js";
import { obsLogger } from "../core/report/obs-logger.js";

// ============================
// Types
// ============================

interface Logger {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
}

/** L1/L2/L3 task executor (the concrete LLM + VDB logic is injected by the upper layer)
 *
 * H-11 Step 2: methods optionally accept an AbortSignal. When the worker loses
 * its distributed lock mid-execution, it aborts the signal so the executor
 * can promptly tear down in-flight LLM calls. Executors that ignore the
 * signal still work (the worker will skip ACK after lockLost), but they
 * waste compute / tokens until the LLM call naturally returns.
 */
export interface TaskExecutor {
  executeL1(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeL2(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeL3(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeFlush?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL1?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL15?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
  executeOffloadL2?(task: TaskPayload, signal?: AbortSignal): Promise<void>;
}

export interface PipelineWorkerConfig {
  /** Worker node ID */
  workerId?: string;
  /** Number of concurrent consumer coroutines (default: 60). Each coroutine consumes tasks independently; different sessions run in parallel. */
  concurrency?: number;
  /** Consume poll interval ms (default: 200) */
  pollIntervalMs?: number;
  /**
   * Lock TTL ms (default: 600000 = 10min).
   * Must be >= 2 x max(LLM timeout): the default LLM timeout is 120s,
   * leaving enough buffer so that even if the renewal timer misses 1-2
   * ticks due to GC / event-loop blocking, the lock will not expire and be taken by someone else.
   *
   * When many sessions of the same agent queue up under massive import, the TTL must cover normal task execution and lock renewal.
   * Lock conflicts themselves back off via the local parked scheduler, no longer ACK + re-enqueue.
   */
  lockTtlMs?: number;
  /** Lock renewal interval ms (default: 30000 = 1/8 of the TTL, to avoid renewal failure) */
  lockRenewIntervalMs?: number;
  /** Max retry count (default: 3) */
  maxRetries?: number;
  /** Retry base delay ms (default: 5000, exponential backoff) */
  retryBaseDelayMs?: number;
  /** Pending message recovery interval ms (default: 30000) */
  pendingRecoveryIntervalMs?: number;
  /** Pending message timeout threshold ms (default: 300000 = 5min, must be > lockTtlMs) */
  pendingStaleMs?: number;
  /** Backoff sequence for the parked queue head on lock conflict (default: 200/600/1800/5000ms) */
  lockRetryDelaysMs?: readonly number[];
  /** Jitter ratio of parked retry delay; 0 can be used for deterministic tests (default: 0.2) */
  lockRetryJitterRatio?: number;
  /** Global cap on lock scopes retried at the same time (default: min(concurrency, 8)) */
  lockRetryConcurrency?: number;
  /** Cap on the local parked message capacity; when full, consumeLoop applies backpressure before fetching (default: max(concurrency*4, 64)) */
  maxParkedTasks?: number;
  /** Heartbeat interval for the parked PEL claim (default: pendingStaleMs / 3, min 50ms) */
  parkedClaimHeartbeatMs?: number;
  /** Dead-letter task persistence callback */
  onDeadLetter?: (task: TaskPayload, error: string, retryCount: number) => Promise<void>;
  /**
   * Callback after L1 completes, used to advance the L2 timer (solves the L2 fast path).
   * Injected by server.ts as statefulManager.advanceL2TimerAfterL1.
   * If not injected, L2 relies only on maxInterval as a backstop.
   */
  onL1Complete?: (sessionId: string, instanceId: string, teamId?: string, agentId?: string) => Promise<void>;
  /**
   * Callback after L2 completes, used to set the L2 maxInterval timer.
   * Injected by server.ts as statefulManager.armL2MaxInterval.
   */
  onL2Complete?: (sessionId: string, instanceId: string, teamId?: string, agentId?: string) => Promise<void>;
  /**
   * Distributed lock granularity (default: "session")
   * - "session": L1/L2 per-session lock, L3 per-instance lock (original behavior, max concurrency)
   * - "instance": L1/L2/L3 all per-instance lock (CR-1 temporary mitigation: prevents different sessions of the same instance
   *   from concurrently appending to the daily JSONL shared key. The cost is that tasks within a single instance are fully serialized.)
   *
   * Switching this value does not affect persistent state (the lock is a temporary key with TTL=120s).
   * During gray rollout all workers must be switched together within lockTtlMs, to avoid new and old workers holding locks with different keys at the same time.
   */
  lockGranularity?: "session" | "instance";

  /**
   * Concurrency semaphore inside PipelineWorker. Historically shared across the memory + skill V2 workers,
   * after the 2026-07-17 skill refactor the skill side no longer uses the semaphore as a concurrency cap; now only the memory
   * pipeline is a consumer. Behavior is unchanged when not injected. acquire at the processTask entry, release in finally.
   */
  permitPool?: import("./worker-permit-pool.js").WorkerPermitPool;
}

export interface DeadLetterEntry {
  task: TaskPayload;
  error: string;
  retryCount: number;
  deadAt: number;
}

const TAG = "[pipeline-worker]";

interface ClaimedTask extends TaskPayload {
  _msgId?: string;
  _ownerId?: string;
  _stream?: string;
}

interface ParkedTask {
  task: ClaimedTask;
  lockKey: string;
  attempt: number;
  nextRetryAt: number;
  ownershipLost: boolean;
}

// ============================
// PipelineWorker
// ============================

export class PipelineWorker {
  private backend: IStateBackend;
  private executor: TaskExecutor;
  private config: Required<Omit<PipelineWorkerConfig, "onDeadLetter" | "onL1Complete" | "onL2Complete" | "permitPool">> & {
    onDeadLetter?: PipelineWorkerConfig["onDeadLetter"];
    onL1Complete?: PipelineWorkerConfig["onL1Complete"];
    onL2Complete?: PipelineWorkerConfig["onL2Complete"];
    permitPool?: PipelineWorkerConfig["permitPool"];
  };
  private logger: Logger;

  private running = false;
  private destroyed = false;
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;
  private recoveryRunning = false;
  private recoveryPromise: Promise<void> | null = null;
  private consumeLoopPromises = new Set<Promise<void>>();
  private parkedRetryPromises = new Set<Promise<void>>();
  private parkedSchedulerTimer: ReturnType<typeof setTimeout> | null = null;
  private parkedHeartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private parkedHeartbeatRunning = false;
  private parkedHeartbeatPromise: Promise<void> | null = null;
  private claimRefreshes = new Set<Promise<boolean>>();
  private parkedByScope = new Map<string, ParkedTask[]>();
  private retryingScopes = new Set<string>();
  private parkedTaskCount = 0;
  private parkedCapacityReservations = 0;
  private parkedCapacityWaiters = new Set<() => void>();

  // Active locks tracked for graceful shutdown
  private activeLocks = new Set<string>();

  // In-flight tasks (consumed but not yet completed/failed/dropped). Used by
  // standalone /v2/pipeline/status to compute per-L-type running stats.
  // Service mode never reads this — it just costs a Map.set/delete per task.
  private runningTasks = new Map<string, TaskPayload>();

  // Dead letter queue (in-process + optional callback persistence)
  private deadLetterQueue: DeadLetterEntry[] = [];

  // Metrics
  private metrics = {
    tasksConsumed: 0,
    tasksCompleted: 0,
    tasksFailed: 0,
    tasksRetried: 0,
    tasksDeadLettered: 0,
    lockConflicts: 0,
    /** H-11: number of times renewLock callback failed → lockLost=true was set. */
    lockRenewFailed: 0,
    /** H-11: number of times execution finished but lockLost was true → task left in PENDING for another worker. */
    lockLostDuringExecution: 0,
    /** H-11 Step 2: number of times an executor was aborted via AbortSignal due to lockLost. */
    executionAborted: 0,
    /** Number of stream messages moved to a local lock-scope parked queue. */
    tasksParked: 0,
    /** Number of parked queue-head lock acquisition attempts. */
    parkedRetryAttempts: 0,
    /** Number of tasks dropped locally after their PEL ownership was lost. */
    taskOwnershipLost: 0,
    /** Number of parked/active claim heartbeat calls that failed or lost ownership. */
    claimRefreshFailed: 0,
  };

  constructor(backend: IStateBackend, executor: TaskExecutor, config?: PipelineWorkerConfig, logger?: Logger) {
    this.backend = backend;
    this.executor = executor;
    this.logger = logger ?? { info: console.log, warn: console.warn, error: console.error };

    const concurrency = config?.concurrency ?? 60;
    const lockTtlMs = config?.lockTtlMs ?? 600000;
    const lockRenewIntervalMs = config?.lockRenewIntervalMs ?? 30000;
    const requestedPendingStaleMs = config?.pendingStaleMs ?? 300000;
    // A healthy task must never become claimable while its distributed lock is
    // still valid. Automatically converge invalid deployments rather than rely
    // on an operational convention that the previous defaults violated.
    const minimumPendingStaleMs = lockTtlMs + (lockRenewIntervalMs * 2);
    const pendingStaleMs = Math.max(requestedPendingStaleMs, minimumPendingStaleMs);
    const maxParkedTasks = config?.maxParkedTasks ?? Math.max(concurrency * 4, 64);
    const lockRetryDelaysMs = config?.lockRetryDelaysMs ?? [200, 600, 1800, 5000];
    const lockRetryJitterRatio = config?.lockRetryJitterRatio ?? 0.2;
    const requestedRetryConcurrency = config?.lockRetryConcurrency ?? Math.max(1, Math.min(concurrency, 8));
    const parkedClaimHeartbeatMs = config?.parkedClaimHeartbeatMs
      ?? Math.max(50, Math.floor(pendingStaleMs / 3));

    if (!Number.isInteger(concurrency) || concurrency <= 0) {
      throw new RangeError(`${TAG} concurrency must be a positive integer`);
    }
    if (!Number.isFinite(lockTtlMs) || lockTtlMs <= 0) {
      throw new RangeError(`${TAG} lockTtlMs must be positive`);
    }
    if (!Number.isFinite(lockRenewIntervalMs) || lockRenewIntervalMs <= 0 || lockRenewIntervalMs >= lockTtlMs) {
      throw new RangeError(`${TAG} lockRenewIntervalMs must be positive and less than lockTtlMs`);
    }
    if (!Number.isFinite(requestedPendingStaleMs) || requestedPendingStaleMs <= 1) {
      throw new RangeError(`${TAG} pendingStaleMs must be greater than 1ms`);
    }
    if (!Number.isInteger(maxParkedTasks) || maxParkedTasks <= 0) {
      throw new RangeError(`${TAG} maxParkedTasks must be a positive integer`);
    }
    if (lockRetryDelaysMs.length === 0 || lockRetryDelaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
      throw new RangeError(`${TAG} lockRetryDelaysMs must contain finite non-negative delays`);
    }
    if (!Number.isFinite(lockRetryJitterRatio) || lockRetryJitterRatio < 0 || lockRetryJitterRatio > 1) {
      throw new RangeError(`${TAG} lockRetryJitterRatio must be between 0 and 1`);
    }
    if (!Number.isInteger(requestedRetryConcurrency) || requestedRetryConcurrency <= 0) {
      throw new RangeError(`${TAG} lockRetryConcurrency must be a positive integer`);
    }
    if (!Number.isFinite(parkedClaimHeartbeatMs) || parkedClaimHeartbeatMs <= 0
      || parkedClaimHeartbeatMs >= pendingStaleMs) {
      throw new RangeError(`${TAG} parkedClaimHeartbeatMs must be positive and less than pendingStaleMs`);
    }

    if (pendingStaleMs !== requestedPendingStaleMs) {
      this.logger.warn(
        `${TAG} pendingStaleMs=${requestedPendingStaleMs} is not greater than lockTtlMs=${lockTtlMs}; ` +
        `automatically raised to ${pendingStaleMs}`,
      );
    }

    this.config = {
      workerId: config?.workerId ?? `worker-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      concurrency,
      pollIntervalMs: config?.pollIntervalMs ?? 200,
      lockTtlMs,
      lockRenewIntervalMs,
      maxRetries: config?.maxRetries ?? 3,
      retryBaseDelayMs: config?.retryBaseDelayMs ?? 5000,
      pendingRecoveryIntervalMs: config?.pendingRecoveryIntervalMs ?? 30000,
      pendingStaleMs,
      lockRetryDelaysMs,
      lockRetryJitterRatio,
      lockRetryConcurrency: Math.min(requestedRetryConcurrency, maxParkedTasks),
      maxParkedTasks,
      parkedClaimHeartbeatMs,
      onDeadLetter: config?.onDeadLetter,
      onL1Complete: config?.onL1Complete,
      onL2Complete: config?.onL2Complete,
      lockGranularity: config?.lockGranularity ?? "session",
      permitPool: config?.permitPool,
    };
  }

  // ============================
  // Lifecycle
  // ============================

  async start(): Promise<void> {
    if (this.destroyed || this.running) return;
    this.running = true;

    this.logger.info(`${TAG} Starting (workerId=${this.config.workerId}, concurrency=${this.config.concurrency})`);

    // Start the pending message recovery loop
    this.startPendingRecovery();

    // Start N concurrent consumer coroutines, and keep the Promises so stop can wait for in-flight consume/execution to finish.
    for (let i = 0; i < this.config.concurrency; i++) {
      const loop = this.consumeLoop();
      this.consumeLoopPromises.add(loop);
      void loop.finally(() => this.consumeLoopPromises.delete(loop));
    }
  }

  async stop(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.running = false;

    // Stop pending recovery / parked scheduling and heartbeat.
    if (this.recoveryTimer) { clearInterval(this.recoveryTimer); this.recoveryTimer = null; }
    if (this.parkedSchedulerTimer) { clearTimeout(this.parkedSchedulerTimer); this.parkedSchedulerTimer = null; }
    if (this.parkedHeartbeatTimer) { clearInterval(this.parkedHeartbeatTimer); this.parkedHeartbeatTimer = null; }

    // First wake and wait for all in-flight paths. After observing destroyed they must not execute new claims;
    // new messages returned by consume/recovery after shutdown will immediately age the claim to stale.
    this.wakeParkedCapacityWaiters();
    await Promise.allSettled([
      ...Array.from(this.consumeLoopPromises),
      ...Array.from(this.parkedRetryPromises),
      ...(this.recoveryPromise ? [this.recoveryPromise] : []),
      ...(this.parkedHeartbeatPromise ? [this.parkedHeartbeatPromise] : []),
    ]);
    if (this.claimRefreshes.size > 0) await Promise.allSettled(Array.from(this.claimRefreshes));

    // Proactively age the parked/retrying claims, to avoid continuing to hold PEL ownership after shutdown.
    const parked = Array.from(this.parkedByScope.values()).flat();
    await Promise.allSettled(parked.map((entry) => this.refreshTaskClaim(entry.task, this.config.pendingStaleMs)));
    this.parkedByScope.clear();
    this.parkedTaskCount = 0;

    // Release all active locks
    for (const lockKey of this.activeLocks) {
      try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
    }
    this.activeLocks.clear();

    this.logger.info(
      `${TAG} Stopped (consumed=${this.metrics.tasksConsumed}, completed=${this.metrics.tasksCompleted}, ` +
      `failed=${this.metrics.tasksFailed}, deadLettered=${this.metrics.tasksDeadLettered})`,
    );
  }

  getMetrics() {
    let parkedTasks = 0;
    for (const queue of this.parkedByScope.values()) parkedTasks += queue.length;
    return {
      ...this.metrics,
      workerId: this.config.workerId,
      deadLetterCount: this.deadLetterQueue.length,
      parkedTasks,
      parkedCapacity: this.config.maxParkedTasks,
      parkedBackpressured: this.parkedTaskCount >= this.config.maxParkedTasks,
      parkedScopes: this.parkedByScope.size,
      retryingScopes: this.retryingScopes.size,
    };
  }

  /**
   * Snapshot of tasks currently being executed by this worker (after lock
   * acquisition, before completion/failure). Used by standalone
   * /v2/pipeline/status to compute per-L-type running stats. Service mode
   * never calls this. Returns a fresh array (Map values copy).
   */
  getRunningTasks(): TaskPayload[] {
    return Array.from(this.runningTasks.values());
  }

  getDeadLetterQueue(): readonly DeadLetterEntry[] {
    return this.deadLetterQueue;
  }

  // ============================
  // Consume Loop
  // ============================

  private async consumeLoop(): Promise<void> {
    while (this.running && !this.destroyed) {
      let capacityReserved = false;
      try {
        capacityReserved = await this.reserveParkedCapacity();
        if (!capacityReserved || !this.running || this.destroyed) return;
        const task = await this.backend.consumeTask(this.config.workerId, this.config.pollIntervalMs);
        if (!task) continue;
        if (this.destroyed) {
          await this.refreshTaskClaim(task as ClaimedTask, this.config.pendingStaleMs);
          return;
        }

        this.metrics.tasksConsumed++;
        await this.processTask(task);
      } catch (err) {
        if (!this.destroyed) {
          this.logger.error(`${TAG} Consume loop error: ${err instanceof Error ? err.message : String(err)}`);
          await this.sleep(1000); // avoid frantic retries
        }
      } finally {
        if (capacityReserved) this.releaseParkedCapacityReservation();
      }
    }
  }

  // ============================
  // Task Processing
  // ============================

  private async processTask(
    task: TaskPayload,
    resumed?: { lockKey: string; lockAcquired: true; permitAcquired: true },
  ): Promise<void> {
    const claimedTask = task as ClaimedTask;
    const lockKey = resumed?.lockKey ?? this.getLockKey(task);
    const retryCount = (task.data?.retryCount as number) ?? 0;

    // permitPool acquire: concurrency limiting inside the memory pipeline. For parked retries, the scheduler
    // passes permitAcquired after acquire, to avoid acquiring twice. Both paths return it via releasePermitOnce.
    const permitPool = this.config.permitPool;
    if (permitPool && !resumed?.permitAcquired) {
      await permitPool.acquire();
    }
    let permitReleased = false;
    const releasePermitOnce = (): void => {
      if (permitReleased) return;
      permitReleased = true;
      if (permitPool) {
        try { permitPool.release(); }
        catch (err) {
          this.logger.warn(`${TAG} permitPool release error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };

    // stop() may race with a parked retry after it acquired the lock. Do not
    // start new work during shutdown; release both resources and make the PEL
    // message immediately eligible for another live worker.
    if (this.destroyed) {
      if (resumed?.lockAcquired && lockKey) {
        try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
      }
      await this.refreshTaskClaim(claimedTask, this.config.pendingStaleMs);
      releasePermitOnce();
      return;
    }

    // consumeTask or a parked retry may be taken over by another node while waiting for a permit.
    // Before executing, the PEL owner must be refreshed and verified; on failure it must not execute or ACK.
    if (!resumed) {
      const owned = await this.refreshTaskClaim(claimedTask);
      if (!owned || this.destroyed) {
        if (this.destroyed) {
          await this.refreshTaskClaim(claimedTask, this.config.pendingStaleMs);
        } else {
          this.noteOwnershipLost(claimedTask, "before execution");
        }
        releasePermitOnce();
        return;
      }
    }

    // Lock-free tasks still need a PEL heartbeat. Without it, a long offload
    // can be XAUTOCLAIMed and executed concurrently even though no lock exists.
    if (lockKey === null) {
      this.runningTasks.set(task.id, task);
      const abortController = new AbortController();
      let claimLost = false;
      let heartbeatPromise: Promise<void> | null = null;
      const heartbeatTimer = setInterval(() => {
        // Keep heartbeating during graceful stop while this execution is still
        // awaited; a hard process exit naturally stops the timer and enables recovery.
        if (heartbeatPromise || claimLost) return;
        const heartbeat = (async () => {
          try {
            if (await this.refreshTaskClaim(claimedTask, undefined, true)) return;
            this.noteOwnershipLost(claimedTask, "lock-free claim heartbeat");
          } catch (err) {
            this.logger.warn(
              `${TAG} lock-free claim heartbeat failed (task=${task.id}): ` +
              `${err instanceof Error ? err.message : String(err)}`,
            );
          }
          claimLost = true;
          this.metrics.claimRefreshFailed++;
          if (!abortController.signal.aborted) {
            this.metrics.executionAborted++;
            abortController.abort(new Error("pipeline-worker: lock-free task claim lost"));
          }
        })();
        heartbeatPromise = heartbeat;
        void heartbeat.then(() => {
          if (heartbeatPromise === heartbeat) heartbeatPromise = null;
        });
      }, this.config.parkedClaimHeartbeatMs);
      heartbeatTimer.unref?.();
      const stopHeartbeat = async (): Promise<void> => {
        clearInterval(heartbeatTimer);
        if (heartbeatPromise) await heartbeatPromise;
      };

      try {
        await this.executeTask(task, abortController.signal);
        await stopHeartbeat();
        if (claimLost) return;

        // ACK must be atomically checked against the PEL owner; after losing ownership, do not record completed or continue side effects.
        if (!(await this.ackTaskIfOwned(claimedTask))) {
          this.noteOwnershipLost(claimedTask, "lock-free ACK");
          (task as any)._deferredEnqueue = undefined;
          return;
        }

        this.metrics.tasksCompleted++;
        this.logger?.debug?.(`${TAG} Task completed (lock-free): ${task.type} [${task.instanceId}/${task.sessionId}]`);
      } catch (err) {
        await stopHeartbeat();
        if (claimLost) {
          this.metrics.tasksFailed++;
          return;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        this.metrics.tasksFailed++;

        if (retryCount < this.config.maxRetries) {
          const delay = this.config.retryBaseDelayMs * Math.pow(3, retryCount);
          this.logger.warn(`${TAG} Task failed (lock-free, retry ${retryCount + 1}/${this.config.maxRetries}, delay=${delay}ms): ${errMsg}`);
          await this.sleep(delay);
          if (this.destroyed) return;
          const replacement = this.buildRetryTask(task, retryCount + 1);
          if (!(await this.replacePendingTaskIfOwned(claimedTask, replacement))) {
            this.noteOwnershipLost(claimedTask, "lock-free retry replace");
            (task as any)._deferredEnqueue = undefined;
            return;
          }
          this.metrics.tasksRetried++;
        } else {
          await this.moveToDeadLetter(task, errMsg, retryCount);
        }
      } finally {
        clearInterval(heartbeatTimer);
        this.runningTasks.delete(task.id);
        releasePermitOnce();

        // Deferred enqueue (same as locked path)
        const deferred = (task as any)._deferredEnqueue as TaskPayload[] | undefined;
        if (deferred?.length) {
          for (const dTask of deferred) {
            try {
              await this.backend.enqueueTask(dTask);
              this.logger?.debug?.(`${TAG} Deferred enqueue: ${dTask.type} [${dTask.id}]`);
            } catch (err) {
              this.logger?.warn?.(`${TAG} Deferred enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }
      }
      return;
    }

    // Step 1: acquire the distributed lock. On first conflict, switch slots immediately: the original message stays in the PEL,
    // no ACK, no re-XADD; after being parked FIFO by lock scope, return the permit right away.
    const locked = resumed?.lockAcquired
      ?? await this.backend.acquireLock(lockKey, this.config.workerId, this.config.lockTtlMs);
    if (!locked) {
      this.metrics.lockConflicts++;
      this.parkTask(claimedTask, lockKey);
      releasePermitOnce();
      return;
    }

    this.activeLocks.add(lockKey);
    // Track in-flight task — used by standalone /v2/pipeline/status. Done after
    // lock acquisition so lock-conflict drops don't pollute the running set.
    this.runningTasks.set(task.id, task);
    let lockLost = false;
    // H-11 Step 2: AbortController so renewLock failure can immediately interrupt
    // long-running LLM calls inside the executor (saves token cost and avoids
    // writing data after the lock has been transferred to another worker).
    const abortController = new AbortController();

    // Step 2: start lock renewal (local timer, independent per task)
    const renewTimer = setInterval(async () => {
      try {
        const renewed = await this.backend.renewLock(lockKey, this.config.workerId, this.config.lockTtlMs);
        if (!renewed) {
          this.metrics.lockRenewFailed++;
          this.logger.warn(
            `${TAG} Lock renew failed for ${lockKey} (worker=${this.config.workerId}); ` +
            `marking lockLost and aborting executor`,
          );
          lockLost = true;
          clearInterval(renewTimer);
          // H-11 Step 2: signal the executor to abort. Any in-flight LLM / VDB call
          // wired to this signal will throw an AbortError and tear down cleanly.
          if (!abortController.signal.aborted) {
            this.metrics.executionAborted++;
            abortController.abort(new Error("pipeline-worker: lock lost during execution"));
          }
          return;
        }

        // While the lock still belongs to this worker, synchronously refresh the Redis Stream PEL claim, to prevent long tasks from being taken by stale recovery.
        if (!(await this.refreshTaskClaim(claimedTask))) {
          this.metrics.claimRefreshFailed++;
          this.noteOwnershipLost(claimedTask, "active claim heartbeat");
          lockLost = true;
          clearInterval(renewTimer);
          if (!abortController.signal.aborted) {
            this.metrics.executionAborted++;
            abortController.abort(new Error("pipeline-worker: task claim lost during execution"));
          }
        }
      } catch (e) {
        this.metrics.lockRenewFailed++;
        this.logger.warn(
          `${TAG} Lock renew threw for ${lockKey}: ${e instanceof Error ? e.message : String(e)}`,
        );
        lockLost = true;
        clearInterval(renewTimer);
        if (!abortController.signal.aborted) {
          this.metrics.executionAborted++;
          abortController.abort(new Error("pipeline-worker: lock renew exception"));
        }
      }
    }, this.config.lockRenewIntervalMs);

    // Step 3: execute the task
    try {
      await this.executeTask(task, abortController.signal);

      // H-11 Step 1: re-check lockLost after successful executeTask.
      // If the lock was lost mid-execution we must NOT ack and NOT cascade
      // because another worker has already (or will) take over via XPENDING/XCLAIM
      // recovery, and ACK'ing here would cause a silent partial-failure where the
      // task is removed from the stream while only half of its side effects landed.
      if (lockLost) {
        this.metrics.lockLostDuringExecution++;
        this.logger.warn(
          `${TAG} Lock lost during execution but task body returned; ` +
          `skipping ACK + cascadeSchedule so another worker can re-process: ` +
          `${task.type} [${task.instanceId}/${task.sessionId}]`,
        );
        // NOTE: rely on L1/L2/L3 idempotency (vectorStore.upsert by memoryId
        // is idempotent; jsonl appends use ETag/append-position so concurrent
        // writers don't corrupt). Hard rollback not feasible for COS objects.
        (task as any)._deferredEnqueue = undefined;
        return;
      }

      // Step 4: successor state / cascade must complete first; on failure the original message is still in the PEL and can be
      // atomically replaced with a retry via replacePendingTask; it is forbidden to find a cascade failure only after ACK.
      if (!(await this.refreshTaskClaim(claimedTask))) {
        this.noteOwnershipLost(claimedTask, "before cascade");
        (task as any)._deferredEnqueue = undefined;
        return;
      }
      await this.cascadeSchedule(task);

      // Step 5: ACK only after all side effects succeed. If ownership is lost at the last moment, do not count completed.
      if (!(await this.ackTaskIfOwned(claimedTask))) {
        this.noteOwnershipLost(claimedTask, "completion ACK");
        (task as any)._deferredEnqueue = undefined;
        return;
      }

      this.metrics.tasksCompleted++;
      this.logger?.debug?.(`${TAG} Task completed: ${task.type} [${task.instanceId}/${task.sessionId}]`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);

      // Check whether the lock was lost → if lost, do not retry (avoid duplicate execution)
      if (lockLost) {
        this.logger.warn(`${TAG} Lock lost during execution, aborting: ${task.type} [${task.instanceId}/${task.sessionId}]`);
        this.metrics.tasksFailed++;
        return;
      }

      this.metrics.tasksFailed++;

      // Exponential backoff retry
      if (retryCount < this.config.maxRetries) {
        const delay = this.config.retryBaseDelayMs * Math.pow(3, retryCount); // 5s, 15s, 45s
        this.logger.warn(
          `${TAG} Task failed (retry ${retryCount + 1}/${this.config.maxRetries}, delay=${delay}ms): ${errMsg}`,
        );
        await this.sleep(delay);
        const replacement = this.buildRetryTask(task, retryCount + 1);
        if (!(await this.replacePendingTaskIfOwned(claimedTask, replacement))) {
          this.noteOwnershipLost(claimedTask, "retry replace");
          (task as any)._deferredEnqueue = undefined;
          return;
        }
        this.metrics.tasksRetried++;
      } else {
        await this.moveToDeadLetter(task, errMsg, retryCount);
      }
    } finally {
      // Step 6: stop renewal + release the lock
      clearInterval(renewTimer);
      this.activeLocks.delete(lockKey);
      this.runningTasks.delete(task.id);
      try { await this.backend.releaseLock(lockKey, this.config.workerId); } catch { /* best effort */ }
      releasePermitOnce();

      // Step 7: deferred enqueue — the executor can stash, via task._deferredEnqueue, tasks that must be enqueued only after the lock is released,
      // to avoid unnecessary lock conflicts when a new task is consumed immediately while the same session lock is still held.
      const deferred = (task as any)._deferredEnqueue as TaskPayload[] | undefined;
      if (deferred?.length) {
        for (const dTask of deferred) {
          try {
            await this.backend.enqueueTask(dTask);
            this.logger?.debug?.(`${TAG} Deferred enqueue: ${dTask.type} [${dTask.id}]`);
          } catch (err) {
            this.logger?.warn?.(`${TAG} Deferred enqueue failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }
  }

  // ============================
  // Lock-conflict parking / PEL ownership
  // ============================

  private async reserveParkedCapacity(): Promise<boolean> {
    while (!this.destroyed) {
      if (this.parkedTaskCount + this.parkedCapacityReservations < this.config.maxParkedTasks) {
        this.parkedCapacityReservations++;
        return true;
      }
      await new Promise<void>((resolve) => {
        this.parkedCapacityWaiters.add(resolve);
        if (this.destroyed) {
          this.parkedCapacityWaiters.delete(resolve);
          resolve();
        }
      });
    }
    return false;
  }

  private releaseParkedCapacityReservation(): void {
    this.parkedCapacityReservations = Math.max(0, this.parkedCapacityReservations - 1);
    this.wakeParkedCapacityWaiters();
  }

  private wakeParkedCapacityWaiters(): void {
    for (const resolve of this.parkedCapacityWaiters) resolve();
    this.parkedCapacityWaiters.clear();
  }

  private parkTask(task: ClaimedTask, lockKey: string): void {
    const queue = this.parkedByScope.get(lockKey) ?? [];
    queue.push({
      task,
      lockKey,
      attempt: 0,
      nextRetryAt: Date.now() + this.getParkedRetryDelay(0),
      ownershipLost: false,
    });
    this.parkedByScope.set(lockKey, queue);
    this.parkedTaskCount++;
    this.metrics.tasksParked++;
    this.logger?.debug?.(
      `${TAG} Parked after lock conflict [${task.type}] (task=${task.id}, scope=${lockKey}, depth=${queue.length})`,
    );
    this.ensureParkedHeartbeat();
    this.scheduleParkedRetries();
  }

  private getParkedRetryDelay(attempt: number): number {
    const delays = this.config.lockRetryDelaysMs;
    const base = delays[Math.min(attempt, delays.length - 1)] ?? 5000;
    const jitter = Math.max(0, this.config.lockRetryJitterRatio);
    if (jitter === 0) return Math.max(0, base);
    const factor = 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(0, Math.round(base * factor));
  }

  private scheduleParkedRetries(): void {
    if (this.destroyed) return;
    if (this.parkedSchedulerTimer) {
      clearTimeout(this.parkedSchedulerTimer);
      this.parkedSchedulerTimer = null;
    }

    const capacity = this.config.lockRetryConcurrency - this.retryingScopes.size;
    const now = Date.now();
    const candidates = Array.from(this.parkedByScope.entries())
      .filter(([scope, queue]) => queue.length > 0 && !this.retryingScopes.has(scope))
      .sort((a, b) => a[1][0]!.nextRetryAt - b[1][0]!.nextRetryAt);

    let started = 0;
    for (const [scope, queue] of candidates) {
      if (started >= capacity || queue[0]!.nextRetryAt > now) break;
      started++;
      this.retryingScopes.add(scope);
      const retry = this.retryParkedScope(scope);
      this.parkedRetryPromises.add(retry);
      void retry.finally(() => {
        this.parkedRetryPromises.delete(retry);
        this.retryingScopes.delete(scope);
        this.scheduleParkedRetries();
      });
    }

    if (started > 0 || this.retryingScopes.size >= this.config.lockRetryConcurrency) return;
    const next = candidates.find(([scope]) => !this.retryingScopes.has(scope));
    if (!next) return;
    const waitMs = Math.max(0, next[1][0]!.nextRetryAt - Date.now());
    this.parkedSchedulerTimer = setTimeout(() => {
      this.parkedSchedulerTimer = null;
      this.scheduleParkedRetries();
    }, waitMs);
    this.parkedSchedulerTimer.unref?.();
  }

  private async retryParkedScope(scope: string): Promise<void> {
    const queue = this.parkedByScope.get(scope);
    const entry = queue?.[0];
    if (!queue || !entry || this.destroyed) return;

    if (entry.ownershipLost || !(await this.refreshTaskClaim(entry.task))) {
      this.removeParkedHead(scope, entry);
      if (!entry.ownershipLost) this.noteOwnershipLost(entry.task, "before parked retry");
      return;
    }

    const permitPool = this.config.permitPool;
    let permitAcquired = false;
    try {
      if (permitPool) {
        await permitPool.acquire();
        permitAcquired = true;
      }
      if (this.destroyed) return;

      // acquire() may queue for a long time; after obtaining the permit the owner must be verified again.
      if (!(await this.refreshTaskClaim(entry.task))) {
        this.removeParkedHead(scope, entry);
        this.noteOwnershipLost(entry.task, "after parked permit wait");
        return;
      }

      this.metrics.parkedRetryAttempts++;
      const acquired = await this.backend.acquireLock(scope, this.config.workerId, this.config.lockTtlMs);
      if (this.destroyed) {
        if (acquired) {
          try { await this.backend.releaseLock(scope, this.config.workerId); } catch { /* best effort */ }
        }
        return;
      }
      if (!acquired) {
        entry.attempt++;
        entry.nextRetryAt = Date.now() + this.getParkedRetryDelay(entry.attempt);
        this.metrics.lockConflicts++;
        return;
      }

      this.removeParkedHead(scope, entry);
      // Transfer permit ownership before awaiting: processTask releases it in
      // its own finally even when retry replacement or DLQ persistence throws.
      permitAcquired = false;
      await this.processTask(entry.task, { lockKey: scope, lockAcquired: true, permitAcquired: true });
    } catch (err) {
      this.logger.warn(
        `${TAG} Parked retry failed (task=${entry.task.id}, scope=${scope}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
      if (!this.destroyed && this.parkedByScope.get(scope)?.[0] === entry) {
        entry.attempt++;
        entry.nextRetryAt = Date.now() + this.getParkedRetryDelay(entry.attempt);
      }
    } finally {
      if (permitAcquired && permitPool) {
        try { permitPool.release(); } catch { /* best effort */ }
      }
    }
  }

  private removeParkedHead(scope: string, expected: ParkedTask): void {
    this.removeParkedEntry(scope, expected);
  }

  private removeParkedEntry(scope: string, expected: ParkedTask): void {
    const queue = this.parkedByScope.get(scope);
    if (!queue) return;
    const index = queue.indexOf(expected);
    if (index < 0) return;
    queue.splice(index, 1);
    this.parkedTaskCount = Math.max(0, this.parkedTaskCount - 1);
    this.wakeParkedCapacityWaiters();
    if (queue.length === 0) this.parkedByScope.delete(scope);
    else if (index === 0) queue[0]!.nextRetryAt = Date.now() + this.getParkedRetryDelay(0);
    if (this.parkedByScope.size === 0 && this.parkedHeartbeatTimer) {
      clearInterval(this.parkedHeartbeatTimer);
      this.parkedHeartbeatTimer = null;
    }
  }

  private ensureParkedHeartbeat(): void {
    if (this.parkedHeartbeatTimer || this.destroyed) return;
    this.parkedHeartbeatTimer = setInterval(() => {
      const heartbeat = this.heartbeatParkedClaims();
      this.parkedHeartbeatPromise = heartbeat;
      void heartbeat.finally(() => {
        if (this.parkedHeartbeatPromise === heartbeat) this.parkedHeartbeatPromise = null;
      });
    }, this.config.parkedClaimHeartbeatMs);
    this.parkedHeartbeatTimer.unref?.();
  }

  private async heartbeatParkedClaims(): Promise<void> {
    if (this.destroyed || this.parkedHeartbeatRunning) return;
    this.parkedHeartbeatRunning = true;
    try {
      const entries = Array.from(this.parkedByScope.entries())
        .flatMap(([scope, queue]) => queue.map((entry) => ({ scope, entry })));
      await Promise.all(entries.map(async ({ scope, entry }) => {
        if (entry.ownershipLost) return;
        if (!(await this.refreshTaskClaim(entry.task))) {
          entry.ownershipLost = true;
          this.metrics.claimRefreshFailed++;
          this.noteOwnershipLost(entry.task, "parked claim heartbeat");
          this.removeParkedEntry(scope, entry);
        }
      }));
    } finally {
      this.parkedHeartbeatRunning = false;
      this.scheduleParkedRetries();
    }
  }

  private async refreshTaskClaim(
    task: ClaimedTask,
    idleMs?: number,
    allowDuringStop = false,
  ): Promise<boolean> {
    if (!task._msgId) return true;
    if (!this.backend.refreshTaskClaim) return true;
    if (this.destroyed && idleMs === undefined && !allowDuringStop) return false;

    const refresh = this.backend.refreshTaskClaim(
      task._msgId,
      task._ownerId ?? this.config.workerId,
      idleMs,
    );
    this.claimRefreshes.add(refresh);
    try {
      return await refresh;
    } catch (err) {
      this.logger.warn(
        `${TAG} refreshTaskClaim failed (task=${task.id}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    } finally {
      this.claimRefreshes.delete(refresh);
    }
  }

  private async ackTaskIfOwned(task: ClaimedTask): Promise<boolean> {
    if (!task._msgId) return true;
    if (this.backend.ackTaskIfOwned) {
      try {
        return await this.backend.ackTaskIfOwned(task._msgId, task._ownerId ?? this.config.workerId);
      } catch (err) {
        this.logger.warn(
          `${TAG} ackTaskIfOwned failed (task=${task.id}): ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    }
    await this.backend.ackTask(task._msgId);
    return true;
  }

  private noteOwnershipLost(task: ClaimedTask, phase: string): void {
    this.metrics.taskOwnershipLost++;
    this.logger.warn(
      `${TAG} Task ownership lost; skipping execution/ACK/cascade ` +
      `(phase=${phase}, task=${task.id}, owner=${task._ownerId ?? this.config.workerId})`,
    );
  }

  private async executeTask(task: TaskPayload, signal?: AbortSignal): Promise<void> {
    switch (task.type) {
      case "L1": return this.executor.executeL1(task, signal);
      case "L2": return this.executor.executeL2(task, signal);
      case "L3": return this.executor.executeL3(task, signal);
      case "flush": return this.executor.executeFlush?.(task, signal) ?? this.executor.executeL1(task, signal);
      case "offload-l1": return this.executor.executeOffloadL1?.(task, signal);
      case "offload-l15": return this.executor.executeOffloadL15?.(task, signal);
      case "offload-l2": return this.executor.executeOffloadL2?.(task, signal);
      default:
        this.logger.warn(`${TAG} Unknown task type: ${task.type}`);
    }
  }

  // ============================
  // Cascade scheduling
  // ============================

  private async cascadeSchedule(task: TaskPayload): Promise<void> {
    const now = Date.now();
    const tid = task.teamId ?? (task.data as any)?.teamId;
    const aid = task.agentId ?? (task.data as any)?.agentId;

    if (task.type === "L1" || task.type === "flush") {
      // L1 complete → reset session-level L1 state, then advance agent/profile-level L2 timers.
      await this.backend.updateSessionState(task.instanceId, task.sessionId, {
        conversation_count: 0,
      }, tid, aid);
      const profileScopes = Array.isArray((task as any)._l2ProfileScopes)
        ? ((task as any)._l2ProfileScopes as string[]).filter(Boolean)
        : [];
      const l2Keys = profileScopes.length > 0 ? profileScopes : [task.sessionId];
      if (this.config.onL1Complete) {
        for (const l2Key of l2Keys) {
          await this.backend.updateSessionState(task.instanceId, l2Key, { l2_pending_l1_count: 1 }, tid, aid);
          // Timer advancement is part of successful L1 completion. Propagate
          // failures so the original PEL message is atomically replaced by a
          // retry instead of ACKing a task whose L2 continuation was lost.
          await this.config.onL1Complete(l2Key, task.instanceId, tid, aid);
        }
      }
      this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L1 done → L2 timer advanced (${l2Keys.join(",")})`);
    }

    if (task.type === "L2") {
      // If L2 was skipped (no new L1 records), don't cascade to L3 or arm timer
      if ((task as any)._l2Skipped) {
        this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L2 skipped (no new data), not arming timer or enqueuing L3`);
        return;
      }

      // L2 complete → enqueue L3 directly (carrying trace context for cross-async-chain correlation)
      // The L3 task also carries team/agent, keeping lock granularity aligned
      await this.backend.enqueueTask({
        // Stable across L2 replay so downstream idempotency keys do not change
        // when the worker crashes after enqueue but before ACK.
        id: `L3-${task.id}`,
        type: "L3",
        instanceId: task.instanceId,
        sessionId: task.sessionId,
        teamId: tid,
        agentId: aid,
        priority: 2,
        data: task.data ? { ...task.data, ...serializeTraceContext() } : { teamId: tid, agentId: aid, ...serializeTraceContext() },
        createdAt: now,
      });
      await this.backend.updateSessionState(task.instanceId, task.sessionId, {
        l2_pending_l1_count: 0,
        l2_last_extraction_time: new Date().toISOString(),
      }, tid, aid);
      // onL2Complete is injected by server.ts as statefulManager.armL2MaxInterval.
      // Failures must propagate, to avoid permanently losing the maxInterval backstop timer after ACK.
      if (this.config.onL2Complete) {
        await this.config.onL2Complete(task.sessionId, task.instanceId, tid, aid);
      }
      this.logger?.debug?.(`${TAG} [${task.instanceId}/${task.sessionId}] L2 done → L3 enqueued`);
    }
  }

  // ============================
  // Lock Management
  // ============================

  /**
   * Lock key design:
   *
   * v2 pipeline default (lockGranularity="session", effectively spread by (instance, team, agent)):
   *   - L1: pipeline:{inst:tid:aid}:s:{sess}   — session-level lock
   *           L1 data is isolated in TCVDB by (team,user,agent,session),
   *           so different sessions extract truly concurrently
   *   - L2: pipeline:{inst:tid:aid}            — agent-level lock
   *           L2 lands in the shared directory profiles/team:T|agent:X/scene_blocks/,
   *           so L2 of different sessions of the same agent must be mutually exclusive to avoid colliding writes to scene/index files
   *   - L3: pipeline:{inst:tid:aid}            — agent-level lock (same as L2)
   *           L3 writes profiles/team:T|agent:X/persona.md, one per agent
   *
   * Fully concurrent across agents: different (tid, aid) spread to different Redis Cluster slots,
   * avoiding a single instance concentrating on one hash slot and forming a big-key hotspot.
   *
   * When teamId / agentId is missing (old calls / offload) it falls back to the "_:_" placeholder,
   * equivalent to landing on the same slot by instance dimension — compatible with old behavior, without breaking lock mutual exclusion.
   *
   * lockGranularity="instance" (legacy CR-1 mitigation):
   *   - L1/L2/L3: pipeline:{instanceId}        — all share one instance-level lock
   *   Not recommended; kept for backward compatibility. New deployments should use the default.
   *
   * Rolling upgrade caveat:
   *   The ACK/PEL protocol differs between old and new workers; they must not run mixed long-term under the same keyPrefix + consumer group.
   *   When rolling out, first stop the old consumers and wait for in-flight tasks to finish, then start the new version;
   *   or use a separate keyPrefix for blue-green switching and explicitly drain the old Stream.
   */
  private getLockKey(task: TaskPayload): string | null {
    // offload-l1 is lock-free: rename guarantees exclusive file ownership,
    // appendFile is atomic (O_APPEND), and state.json is read-only for L1.
    if (task.type === "offload-l1") return null;

    // offload-l2: per-MMD lock so different MMDs can be processed concurrently.
    if (task.type === "offload-l2") {
      const mmdFile = (task.data as any)?.targetMmdFile ?? "default";
      return `pipeline:{${task.instanceId}}:offload-l2:${mmdFile}`;
    }

    // offload-l15: lock-free at worker level. The executor acquires a short
    // lock only during the final write phase (state.json update), allowing
    // multiple L1.5 LLM calls to run concurrently without blocking each other.
    if (task.type === "offload-l15") return null;

    if (this.config.lockGranularity === "instance") {
      return `pipeline:{${task.instanceId}}`;
    }

    // v2 default: spread hash tags by (instance, team, agent)
    //
    // teamId/agentId priority:
    //   1. task.teamId / task.agentId (explicitly carried at v2 enqueue)
    //   2. task.data.teamId / task.data.agentId (compatible with old calls)
    //   3. parse from task.sessionId (for L2/L3 tasks enqueued by timer-scanner,
    //      sessionId looks like "profile:team:T|agent:A" or
    //      "profile:team:T|agent:A|session:S", from which tid/aid are extracted)
    //   4. "_" placeholder falls back to instance level (not recommended, hash concentrates)
    let tid = task.teamId || (task.data as any)?.teamId;
    let aid = task.agentId || (task.data as any)?.agentId;
    if (!tid || !aid) {
      const m = task.sessionId.match(/^profile:team:([^|]+)\|agent:([^|]+)(?:\|session:.+)?$/);
      if (m) {
        // The team field in the profile scope is actually (teamId || userId), consistent with buildProfileIsolationScope.
        // Just use it directly as teamId here; the hash bucketing dimension only needs to line up.
        // If the key carries a source session, it serves only as the L2 input boundary and does not enter lock granularity.
        tid = tid || m[1];
        aid = aid || m[2];
      }
    }
    tid = tid || "_";
    aid = aid || "_";
    const ns = `{${task.instanceId}:${tid}:${aid}}`;

    if (task.type === "L2" || task.type === "L3") {
      // agent-level lock: L2/L3 of the same agent are mutually exclusive, avoiding colliding writes to the shared directory
      return `pipeline:${ns}`;
    }
    // L1 + flush are still session-level
    return `pipeline:${ns}:s:${task.sessionId}`;
  }

  // ============================
  // Dead Letter (#13)
  // ============================

  private async moveToDeadLetter(task: TaskPayload, error: string, retryCount: number): Promise<void> {
    const claimedTask = task as ClaimedTask;

    // Persist the terminal failure before ACK. If persistence fails, leave the
    // original message in PEL so stale recovery can retry without silent loss.
    if (this.config.onDeadLetter) {
      await this.config.onDeadLetter(task, error, retryCount);
    }

    if (!(await this.ackTaskIfOwned(claimedTask))) {
      this.noteOwnershipLost(claimedTask, "dead-letter ACK");
      (task as any)._deferredEnqueue = undefined;
      return;
    }

    const entry: DeadLetterEntry = { task, error, retryCount, deadAt: Date.now() };
    this.deadLetterQueue.push(entry);
    this.metrics.tasksDeadLettered++;

    this.logger.error(
      `${TAG} Dead letter: ${task.type} [${task.instanceId}/${task.sessionId}] after ${retryCount} retries: ${error}`,
    );

    // Clean up timers for this session to prevent ghost triggers
    try {
      const tid = task.teamId ?? (task.data as any)?.teamId;
      const aid = task.agentId ?? (task.data as any)?.agentId;
      await this.backend.removeTimer(task.instanceId, buildPipelineTimerMember(task.sessionId, "L1_idle", { teamId: tid, agentId: aid }));
      await this.backend.removeTimer(task.instanceId, buildPipelineTimerMember(task.sessionId, "L2_schedule", { teamId: tid, agentId: aid }));
    } catch { /* best effort */ }

    obsLogger.error("core.task.dead_letter", {
      instance_id: task.instanceId,
      session_id: task.sessionId,
      task_type: task.type,
      task_id: task.id,
      error,
      retry_count: retryCount,
    });
  }

  private buildRetryTask(task: TaskPayload, newRetryCount: number): TaskPayload {
    const replacement: TaskPayload = {
      ...task,
      id: `${task.type}-${task.sessionId}-retry${newRetryCount}-${Date.now()}`,
      data: { ...task.data, retryCount: newRetryCount },
      createdAt: Date.now(),
    };
    delete replacement._msgId;
    delete replacement._ownerId;
    delete replacement._stream;
    delete (replacement as any)._l2Skipped;
    delete (replacement as any)._l2HasMore;
    delete (replacement as any)._l2LatestCursor;
    delete (replacement as any)._l2ProfileScopes;
    delete (replacement as any)._deferredEnqueue;
    return replacement;
  }

  private async replacePendingTaskIfOwned(task: ClaimedTask, replacement: TaskPayload): Promise<boolean> {
    if (!task._msgId) {
      await this.backend.enqueueTask(replacement);
      return true;
    }
    if (!this.backend.replacePendingTask) {
      throw new Error(`${TAG} replacePendingTask unavailable; original task remains pending (task=${task.id})`);
    }
    return this.backend.replacePendingTask(
      task._msgId,
      task._ownerId ?? this.config.workerId,
      replacement,
    );
  }

  // ============================
  // Pending Message Recovery (#13.2: XPENDING timeout detection + XCLAIM)
  // ============================

  /**
   * Periodically scan the remote queue for pending messages that timed out without ACK.
   *
   * When a Worker process dies, messages it consumed but did not ACK get stuck in the pending list.
   * Surviving Workers take over these messages via the backend's claimStaleTasks and reprocess them.
   *
   * Guarantees:
   * - Idempotent: VDB upsert by record_id, COS overwrite
   * - No duplicates: the backend transfers ownership atomically; a message is claimed by only one Worker
   */
  private startPendingRecovery(): void {
    if (!this.backend.claimStaleTasks) return; // LocalStateBackend does not need this

    this.recoveryTimer = setInterval(() => {
      if (this.destroyed || this.recoveryRunning) return;
      const recovery = this.runPendingRecovery();
      this.recoveryPromise = recovery;
      void recovery.finally(() => {
        if (this.recoveryPromise === recovery) this.recoveryPromise = null;
      });
    }, this.config.pendingRecoveryIntervalMs);
  }

  private async runPendingRecovery(): Promise<void> {
    if (this.destroyed || this.recoveryRunning || !this.backend.claimStaleTasks) return;
    this.recoveryRunning = true;
    let reserved = 0;
    try {
      const available = this.config.maxParkedTasks
        - this.parkedTaskCount
        - this.parkedCapacityReservations;
      if (available <= 0) return;
      reserved = Math.min(10, available);
      this.parkedCapacityReservations += reserved;

      const stale = await this.backend.claimStaleTasks(
        this.config.workerId,
        this.config.pendingStaleMs,
        reserved,
      );
      const unused = reserved - stale.length;
      this.parkedCapacityReservations -= unused;
      if (unused > 0) this.wakeParkedCapacityWaiters();
      reserved = stale.length;
      if (stale.length === 0) return;

      if (this.destroyed) {
        await Promise.allSettled(
          stale.map((task) => this.refreshTaskClaim(task as ClaimedTask, this.config.pendingStaleMs)),
        );
        return;
      }

      this.logger.info(`${TAG} Recovered ${stale.length} stale pending task(s)`);
      await Promise.all(stale.map(async (task) => {
        this.metrics.tasksConsumed++;
        try {
          await this.processTask(task);
        } catch (err) {
          this.logger.error(`${TAG} Recovery task failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }));
    } catch (err) {
      this.logger.warn(`${TAG} Pending recovery error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      while (reserved-- > 0) this.releaseParkedCapacityReservation();
      this.recoveryRunning = false;
    }
  }

  // ============================
  // Util
  // ============================

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => { const t = setTimeout(r, ms); t.unref(); });
  }
}
