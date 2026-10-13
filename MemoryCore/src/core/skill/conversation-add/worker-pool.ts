/**
 * SkillWorkerPool — in-process singleton pool of skill extraction workers.
 *
 * Aligned with the memory PipelineWorker: starts N stateless consumeLoops at once,
 * taking agent tuples from the globally shared SkillAgentTaskQueue. The 5-segment tuple carries its own
 * instance_id; after dequeuing, the worker uses the resolver to fetch the corresponding
 * instance's buffer / extractor / sink by instance_id, and when working delegates to
 * SkillConversationExtractWorker.consumeAgent (reusing the 8-step flow as is).
 *
 * Semantics fully consistent with the old "per-instance worker":
 *   - the agent-level extract-lock guarantees only one loop extracts for the same (instance, agent)
 *   - the tasks-mutex protects the _tasks.json read-modify-write
 *   - transient / permanent error tiering + DLQ
 *   - phantom tasks are silently reclaimed
 *
 * The difference is only in topology: the number of workers no longer grows linearly with the number of instances; a single concurrency
 * parameter uniformly controls the process-wide in-flight cap. See
 * docs/design/2026-07-30-skill-worker-instance-decoupling.md。
 */

import {
  LEGACY_INSTANCE_ID,
  parseAgentTuple,
  type AgentTuple,
  type ISkillAgentTaskQueue,
} from "./agent-task-queue.js";
import type { SkillBufferStorage } from "./buffer-storage.js";
import type { ExtractorLogger, ISkillExtractor } from "../queue/types.js";
import { runInRootContext } from "../../report/otel-context.js";
import { obsLogger } from "../../report/obs-logger.js";
import {
  SkillConversationExtractWorker,
  type SkillCandidatesSink,
  type SkillConversationExtractWorkerOptions,
} from "./extract-worker.js";

/**
 * Per-instance resource resolution function captured in a closure on the gateway side. Goes through a process-level cache,
 * first call <10ms, later calls <1ms (Map.get).
 */
export interface SkillWorkerResolvers {
  resolveBuffer(instanceId: string): Promise<SkillBufferStorage>;
  resolveExtractor(instanceId: string): Promise<ISkillExtractor>;
  resolveSink(instanceId: string): Promise<SkillCandidatesSink>;
}

export interface SkillWorkerPoolOptions extends SkillWorkerResolvers {
  /** Number of workers in the pool, the process-wide concurrency cap. >=1. */
  concurrency: number;
  /** Process-wide shared skill agent queue. */
  queue: ISkillAgentTaskQueue;
  logger: ExtractorLogger;
  /** Pool id prefix; the worker id appends the index; default `skill-pool-${pid}`. */
  poolId?: string;

  // ── Parameters passed through to the underlying SkillConversationExtractWorker ──
  brpopBlockMs?: number;
  extractLockTtlMs?: number;
  extractLockRenewIntervalMs?: number;
  tasksMutexLockTtlMs?: number;
  tasksMutexWaitDeadlineMs?: number;
  lockContentionSleepMs?: number;
  lockContentionSleepJitterMs?: number;
  tasksPerRound?: number;
  failureRequeueSleepMs?: number;
  permanentMaxRetries?: number;
  transientLogSampleEvery?: number;
  now?: () => number;

  /**
   * 2026-08-03 crash-recovery §4.4: after this loop fails to process an agent (lock grab failed /
   * resolver threw / consumeAgent threw), if the same agent is dequeued within a short time it is skipped directly,
   * to avoid the pool hot-looping under peek semantics. Default 200ms.
   *
   * The suppression table lives inside this loop's process (a per-workerLoop Map, not shared across loops — the
   * independent suppression state of different loops naturally staggers them).
   */
  suppressAgentTtlMs?: number;

  /**
   * 2026-08-03 crash-recovery §4.5: interval in ms of the periodic self-heal scan on the degraded path.
   * Enabled only when queue.getPeekStrategy() === "rpop_lpush_downgrade". Default 60_000.
   * On non-degraded paths start() runs only one cold-start scan and does not start a timer.
   */
  selfHealIntervalMs?: number;
}

export class SkillWorkerPool {
  private readonly opts: SkillWorkerPoolOptions;
  private readonly logger: ExtractorLogger;
  private readonly poolId: string;
  private closed = false;
  private started = false;
  private loopPromises: Promise<void>[] = [];
  private selfHealTimer: ReturnType<typeof setInterval> | undefined;

  constructor(opts: SkillWorkerPoolOptions) {
    if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
      throw new Error(`[skill-worker-pool] concurrency must be positive integer, got ${opts.concurrency}`);
    }
    this.opts = opts;
    this.logger = opts.logger;
    this.poolId = opts.poolId ?? `skill-pool-${process.pid}`;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    const n = this.opts.concurrency;
    this.logger.info(
      `[skill-worker-pool] start pool_id=${this.poolId} concurrency=${n} ` +
        `brpopBlockMs=${this.opts.brpopBlockMs ?? 5000} ` +
        `extractLockTtlMs=${this.opts.extractLockTtlMs ?? 600_000}`,
    );

    // 2026-08-03 crash-recovery §4.5: run selfHealScan once at cold start, to clear historical leftover
    // "in Set / not in List" phantoms + legacy 4-segment ones. Run before starting the workerLoops, to avoid races.
    // Uses a fire-and-forget IIFE rather than await — pool.start() keeps a synchronous API,
    // and if the scan is slow the loops run in parallel; self-heal can make up for anything missed.
    void (async () => {
      try {
        const result = await this.selfHealScan();
        this.logger.info(
          `[skill-worker-pool] self-heal cold scan done scanned=${result.scanned} ` +
            `repushed=${result.repushed} legacy_purged=${result.legacyPurged} dur_ms=${result.dur_ms}`,
        );
        obsLogger.info("skill.worker.self_heal_scan", {
          pool_id: this.poolId,
          scanned: result.scanned,
          repushed: result.repushed,
          legacy_purged: result.legacyPurged,
          dur_ms: result.dur_ms,
          trigger: "cold_start",
        });
      } catch (err) {
        this.logger.warn(
          `[skill-worker-pool] self-heal cold scan failed: ${(err as Error).message}`,
        );
      }
    })();

    // On the degraded path, additionally start a periodic timer. The atomic path does not need this (peek already guarantees List state consistency).
    const strategy =
      typeof this.opts.queue.getPeekStrategy === "function"
        ? this.opts.queue.getPeekStrategy()
        : "lmove";
    if (strategy === "rpop_lpush_downgrade") {
      const interval = this.opts.selfHealIntervalMs ?? 60_000;
      this.logger.warn(
        `[skill-worker-pool] peek strategy is DOWNGRADED — starting periodic self-heal ` +
          `every ${interval}ms`,
      );
      this.selfHealTimer = setInterval(() => {
        void (async () => {
          if (this.closed) return;
          try {
            const result = await this.selfHealScan();
            obsLogger.info("skill.worker.self_heal_scan", {
              pool_id: this.poolId,
              scanned: result.scanned,
              repushed: result.repushed,
              legacy_purged: result.legacyPurged,
              dur_ms: result.dur_ms,
              trigger: "periodic_downgrade",
            });
          } catch (err) {
            this.logger.warn(
              `[skill-worker-pool] periodic self-heal failed: ${(err as Error).message}`,
            );
          }
        })();
      }, interval);
    }

    // Start N workerLoops. Same pattern as memory PipelineWorker.start:
    // not awaited, all run resident concurrently; stop() waits for them together. Each loop runs
    // inside the OTel ROOT_CONTEXT (aligned with the old SkillConversationExtractWorker), to prevent
    // the infinite loop from inheriting the "startup-moment" active span and polluting the LLM trace.
    for (let i = 0; i < n; i++) {
      const p = runInRootContext(() => this.workerLoop(i));
      p.catch(() => { /* logged inside */ });
      this.loopPromises.push(p);
    }
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.selfHealTimer) {
      clearInterval(this.selfHealTimer);
      this.selfHealTimer = undefined;
    }
    for (const p of this.loopPromises) {
      try { await p; } catch { /* swallow */ }
    }
    this.loopPromises = [];
  }

  /**
   * One-time scan of pending-agents-set, fixing missing List entries + cleaning legacy 4-segment leftovers.
   * See docs/design/2026-07-21-skill-worker-crash-recovery.md §4.5.
   *
   * Semantics:
   *   - legit 5-segment tuple and not in List → LPUSH it back, repushed++
   *   - legacy 4-segment leftover             → SREM + LREM to clean, legacyPurged++
   *   - legit 5-segment tuple and in List     → leave alone
   *
   * At cold start pool.start() calls it once fire-and-forget; on the degraded path it is additionally called periodically.
   * Also exported for tests + troubleshooting.
   */
  async selfHealScan(): Promise<{
    scanned: number;
    repushed: number;
    legacyPurged: number;
    dur_ms: number;
  }> {
    const q = this.opts.queue;
    if (typeof q.scanAgentSet !== "function") {
      // the old queue implementation was not upgraded; return an empty result directly without crashing the pool.
      return { scanned: 0, repushed: 0, legacyPurged: 0, dur_ms: 0 };
    }
    const t0 = Date.now();
    let scanned = 0;
    let repushed = 0;
    let legacyPurged = 0;
    const members = await q.scanAgentSet();
    for (const raw of members) {
      scanned++;
      const parsed = parseAgentTuple(raw);
      if (!parsed || parsed.instance_id === LEGACY_INSTANCE_ID) {
        // legacy 4-segment (parsed instance_id === LEGACY) or corrupt (parse null) → clean.
        // Corrupt leftovers are handled together with legacy: the pool cannot handle them anyway.
        await q.purgeRawAgent(raw);
        legacyPurged++;
        continue;
      }
      const inList = await q.listContains(raw);
      if (!inList) {
        await q.enqueueRawAgent(raw);
        repushed++;
      }
    }
    return { scanned, repushed, legacyPurged, dur_ms: Date.now() - t0 };
  }

  /**
   * A single worker loop. Stateless by design: each time it gets an agent it fetches resources via the resolver,
   * and constructs a one-off SkillConversationExtractWorker to delegate to consumeAgent.
   */
  private async workerLoop(index: number): Promise<void> {
    const workerId = `${this.poolId}#${index}`;
    const blockMs = this.opts.brpopBlockMs ?? 5000;
    const suppressTtl = this.opts.suppressAgentTtlMs ?? 200;

    // 2026-08-03 crash-recovery §4.4: per-workerLoop short suppression table, to prevent a hot-loop under peek semantics
    // (when lock grab fails / the resolver throws, the agent is still at the queue head, and this loop does not grab it again within 200ms).
    // Other loops have independent suppression state, naturally staggering.
    const suppress = new Map<string, number>();
    const now = () => this.opts.now?.() ?? Date.now();
    const isSuppressed = (a: AgentTuple): boolean => {
      const key = `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
      const until = suppress.get(key);
      if (until === undefined) return false;
      if (until <= now()) { suppress.delete(key); return false; }
      return true;
    };
    const suppressAgent = (a: AgentTuple): void => {
      const key = `${a.instance_id}|${a.space_id}|${a.user_id}|${a.team_id}|${a.agent_id}`;
      suppress.set(key, now() + suppressTtl);
      // lazy cleanup: purge expired entries every 100 entries
      if (suppress.size > 100) {
        const t = now();
        for (const [k, v] of suppress) if (v <= t) suppress.delete(k);
      }
    };

    while (!this.closed) {
      let agent: AgentTuple | null = null;
      try {
        // 2026-08-03 crash-recovery §4.1: use the atomic peekAgent (LMOVE semantics), guaranteeing
        // the agent stays in the List if the loop crashes, so the next peek can get it again. See
        // docs/design/2026-07-21-skill-worker-crash-recovery.md §4。
        agent = await this.opts.queue.peekAgent(blockMs);
      } catch (err) {
        if (this.closed) break;
        this.logger.warn(`[skill-worker-pool] ${workerId} peek error: ${(err as Error).message}`);
        await sleep(200);
        continue;
      }
      if (!agent) continue;

      // short suppression: this loop just failed on this agent, so skip it for a short time. Other loops' suppression state is independent,
      // and they will get other agents, naturally yielding.
      if (isSuppressed(agent)) {
        obsLogger.info("skill.worker.suppressed_skip", {
          worker_id: workerId,
          instance_id: agent.instance_id,
          agent_id: agent.agent_id,
        });
        // short sleep to keep this loop from spinning and then immediately peeking the agent it just suppressed
        await sleep(Math.min(20, suppressTtl));
        continue;
      }

      // Legacy 4-segment fallback: instance_id === "__legacy__". Occasionally present during the upgrade transition,
      // discard directly + error log upon seeing it, and do not try to consume (it indicates a version mismatch).
      //
      // 2026-08-03 crash-recovery: peekAgent uses LMOVE semantics, and the legacy 4-segment raw has already been
      // moved to the queue head — a bare continue would make the pool peek the same legacy raw in an infinite loop (OOM).
      // The original raw string must be reassembled from the 4 segments, and purgeRawAgent cleans it with SREM+LREM.
      // A 5-segment serialize does not hit this raw, so use purgeRawAgent rather than removeAgent.
      if (agent.instance_id === LEGACY_INSTANCE_ID) {
        const legacyRaw = `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
        this.logger.error(
          `[skill-worker-pool] ${workerId} legacy 4-segment tuple detected, purging: ${legacyRaw}`,
        );
        obsLogger.warn("skill.worker.legacy_tuple_dropped", {
          worker_id: workerId,
          space_id: agent.space_id,
          user_id: agent.user_id,
          team_id: agent.team_id,
          agent_id: agent.agent_id,
        });
        try {
          await this.opts.queue.purgeRawAgent(legacyRaw);
        } catch (err) {
          this.logger.warn(
            `[skill-worker-pool] ${workerId} purgeRawAgent(legacy) failed: ${(err as Error).message}`,
          );
        }
        continue;
      }

      try {
        const result = await this.consumeAgent(agent, workerId);
        // consumeAgent only throws unhandled errors; lock contention is result.lockContended=true.
        // A failed lock grab also enters suppression, so other loops take other agents.
        if (result?.lockContended) suppressAgent(agent);
      } catch (err) {
        this.logger.error(
          `[skill-worker-pool] ${workerId} consumeAgent error: ${(err as Error).message}`,
        );
        // consumeAgent threw (usually a resolver error) → suppress this agent for a while,
        // so this loop takes other agents. After the suppression expires it will try again if the problem is not resolved.
        suppressAgent(agent);
      }
    }
  }

  /**
   * After getting an agent, fetch the 3 per-instance resources via the resolver by instance_id,
   * construct a one-off SkillConversationExtractWorker, and delegate to consumeAgent to run the 8-step flow.
   *
   * Worker instances are not cached here — a new one each time is an O(1) allocation + constant field copy,
   * negligible relative to a 20-90 second LLM extraction, in exchange for the worker pool itself being fully stateless.
   */
  private async consumeAgent(
    agent: AgentTuple,
    workerId: string,
  ): Promise<{ lockContended?: boolean }> {
    const instanceId = agent.instance_id;
    const [buffer, extractor, sink] = await Promise.all([
      this.opts.resolveBuffer(instanceId),
      this.opts.resolveExtractor(instanceId),
      this.opts.resolveSink(instanceId),
    ]);

    const extractWorkerOpts: SkillConversationExtractWorkerOptions = {
      workerId,
      buffer,
      queue: this.opts.queue,
      extractor,
      sink,
      logger: this.logger,
      brpopBlockMs: this.opts.brpopBlockMs,
      extractLockTtlMs: this.opts.extractLockTtlMs,
      extractLockRenewIntervalMs: this.opts.extractLockRenewIntervalMs,
      tasksMutexLockTtlMs: this.opts.tasksMutexLockTtlMs,
      tasksMutexWaitDeadlineMs: this.opts.tasksMutexWaitDeadlineMs,
      lockContentionSleepMs: this.opts.lockContentionSleepMs,
      lockContentionSleepJitterMs: this.opts.lockContentionSleepJitterMs,
      tasksPerRound: this.opts.tasksPerRound,
      failureRequeueSleepMs: this.opts.failureRequeueSleepMs,
      permanentMaxRetries: this.opts.permanentMaxRetries,
      transientLogSampleEvery: this.opts.transientLogSampleEvery,
      now: this.opts.now,
    };
    const oneShot = new SkillConversationExtractWorker(extractWorkerOpts);
    // Call consumeAgent directly — runs the same 8-step flow (extract-lock / renewTimer /
    // tasks-mutex / transient-permanent / DLQ / phantom detection). Returns lockContended for
    // the upstream short suppression table to use.
    const result = await oneShot.consumeAgent(agent);
    return { lockContended: result.lockContended };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
