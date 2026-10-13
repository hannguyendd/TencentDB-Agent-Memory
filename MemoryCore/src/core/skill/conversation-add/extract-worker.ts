/**
 * SkillConversationExtractWorker — §9。
 *
 * Resident loop:
 *   ① BRPOP agent
 *   ② grab the extract-lock; if not obtained → requeue + sleep
 *   ③ grab the tasks-mutex and read the head task
 *   ④ read the archive:
 *        404 → phantom task → grab the mutex, filter-delete the task, skip
 *        success → SkillExtractor.extract → sink.applyCandidates → grab the mutex, filter-delete the task
 *   ⑤ decide whether to re-enqueue (tasks remain → requeue, otherwise removeAgent)
 *   ⑥ release the extract-lock
 *
 * Concurrency protection:
 *   - the agent-level extract-lock guarantees only one Worker extracts for the same agent
 *   - the tasks-mutex protects the _tasks.json read-modify-write (the same lock as the Handler archive segment's mutex)
 */

import type {
  AgentTuple,
  ExtractLockHandle,
  ISkillAgentTaskQueue,
} from "./agent-task-queue.js";
import type {
  SkillBufferStorage,
  SkillDeadTaskEntry,
  SkillTaskEntry,
} from "./buffer-storage.js";
import type {
  ExtractedCandidate,
  ExtractorLogger,
  ISkillExtractor,
} from "../queue/types.js";
import { runInRootContext } from "../../report/otel-context.js";
import { obsLogger } from "../../report/obs-logger.js";
import { trace } from "../../report/trace.js";

/**
 * Land the candidates on the business side (e.g. call SkillCore.create/patch, or write directly to SkillStore).
 * Injected by the wiring layer; the Worker does not care about the concrete implementation. Must be idempotent (a Client retry may cause a task to be extracted multiple times).
 */
export interface SkillCandidatesSink {
  applyCandidates(input: {
    task: SkillTaskEntry;
    candidates: ExtractedCandidate[];
    /** For trace / logging purposes */
    workerId: string;
  }): Promise<void>;
}

export interface SkillConversationExtractWorkerOptions {
  workerId: string;
  buffer: SkillBufferStorage;
  queue: ISkillAgentTaskQueue;
  extractor: ISkillExtractor;
  sink: SkillCandidatesSink;
  logger: ExtractorLogger;

  /** BRPOP blocking duration in ms, default 5000. */
  brpopBlockMs?: number;
  /** extract-lock TTL in ms, default 600_000 (10 min). */
  extractLockTtlMs?: number;
  /**
   * extract-lock renewal interval in ms, default extractLockTtlMs / 4.
   *
   * Skill extract goes through an LLM tool-calling review agent, which may span multiple iterations,
   * with cumulative time approaching or exceeding lockTtl. Renewal ensures that while the Worker is busy extracting, the lock is not
   * grabbed by another Worker. Default lockRenewIntervalMs = ttl/4 (aligned with the historical V2 worker parameters).
   */
  extractLockRenewIntervalMs?: number;
  /** tasks-mutex lock TTL in ms (crash safety net), default 10000. */
  tasksMutexLockTtlMs?: number;
  /** Max wait time for contending the tasks-mutex, default 30000. */
  tasksMutexWaitDeadlineMs?: number;
  /** How many ms to sleep before dequeue after failing to grab the extract-lock and re-enqueuing. Default 2000 + jitter. */
  lockContentionSleepMs?: number;
  lockContentionSleepJitterMs?: number;
  /**
   * The max number of tasks to extract in one agent round before requeuing to yield (ensures fairness), default 1.
   * In the design doc the Worker pushes the agent back to the queue head after processing each task.
   */
  tasksPerRound?: number;
  /** Time source, injected in tests. */
  now?: () => number;

  // ── Failure handling (transient / permanent tiers + DLQ) ────────────────────────
  //
  // Aligned with design doc §3.6 (7) P0 fix: extraction failures used to requeue+break directly in the catch,
  // and runLoop would immediately dequeue the same agent, forming a ~100 times/second hot retry, wasting LLM
  // quota and flooding the logs. Now errors are divided into two classes by nature:
  //
  //   A) transient (401/403/429/5xx/network/timeout/fetch)
  //      → sleep(failureRequeueSleepMs) → requeue
  //      → retry_count unchanged, not put into the DLQ, retry indefinitely until the external system recovers
  //      → warn sampling: emit one warn every transientLogSampleEvery occurrences
  //   B) permanent (400/422/JSON parse/schema)
  //      → sleep → retry_count++ written back to _tasks.json → requeue
  //      → when retry_count >= permanentMaxRetries, move to _tasks_dlq.json
  //      → errors that cannot be classified are handled as A (safety net, no data loss)
  /**
   * How many ms to sleep before requeue after a failure; a fixed value (no exponential backoff, no jitter).
   * Default 2000.
   */
  failureRequeueSleepMs?: number;
  /**
   * How many cumulative permanent errors before going into the DLQ, default 3.
   */
  permanentMaxRetries?: number;
  /**
   * Interval (in occurrences) for sampling warns of transient errors by task_id. The 1st emits an error,
   * then every N occurrences emit a warn, to prevent log flooding. Default 60.
   */
  transientLogSampleEvery?: number;
}

export class SkillConversationExtractWorker {
  private readonly opts: SkillConversationExtractWorkerOptions;
  private readonly logger: ExtractorLogger;
  private closed = false;
  private started = false;
  private loopPromise: Promise<void> | null = null;
  /**
   * Per-task_id transient failure counter (in-process count, not persisted). Used for warn sampling:
   * the first failure emits an error, then every transientLogSampleEvery occurrences emit a warn. It does not matter if the process restarts and
   * the count restarts — the purpose of sampling is only to limit log frequency, not to audit.
   */
  private readonly transientFailStreak = new Map<string, number>();

  constructor(opts: SkillConversationExtractWorkerOptions) {
    this.opts = opts;
    this.logger = opts.logger;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.closed = false;
    this.logger.info(
      `[skill-conv-worker] start id=${this.opts.workerId} brpopBlockMs=${this.opts.brpopBlockMs ?? 5000} ` +
        `extractLockTtlMs=${this.opts.extractLockTtlMs ?? 600_000}`,
    );
    // Key: start runLoop inside the OTel ROOT_CONTEXT.
    //
    // This worker is often lazily started inside some HTTP request handler (resolveConversationAdd →
    // wireConversationAdd → start()). Without detaching from the context, the never-exiting runLoop would
    // permanently inherit the active span "at the moment of startup", causing the LLM spans of every later extraction to hang under
    // that request's trace, merged by Langfuse into one (tags across multiple agents, confused sessionId).
    // See report/otel-context.ts for details.
    this.loopPromise = runInRootContext(() => this.runLoop());
    // silence unhandled rejection
    this.loopPromise.catch(() => { /* logged inside */ });
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.loopPromise) {
      try {
        await this.loopPromise;
      } catch { /* swallow */ }
    }
  }

  /**
   * Consume one agent at a time. For tests only (runs synchronously to completion). Returns the processing result to ease assertions.
   *
   * 2026-08-03 crash-recovery §4.1: dequeue uses peekAgent (RPOP+LPUSH atomic, LMOVE semantics);
   * from the moment it is obtained the agent always stays in the List, and if the worker crashes midway the next peek can still get it.
   * See docs/design/2026-07-21-skill-worker-crash-recovery.md §4.
   */
  async runOnce(): Promise<{
    agent?: AgentTuple;
    processedTaskIds: string[];
    lockContended?: boolean;
    dropped?: string[]; // phantom / tasks dropped due to extraction failure
  }> {
    const agent = await this.opts.queue.peekAgent(this.opts.brpopBlockMs ?? 5000);
    if (!agent) return { processedTaskIds: [] };
    return this.consumeAgent(agent);
  }

  private async runLoop(): Promise<void> {
    const blockMs = this.opts.brpopBlockMs ?? 5000;
    while (!this.closed) {
      let agent: AgentTuple | null = null;
      try {
        agent = await this.opts.queue.peekAgent(blockMs);
      } catch (err) {
        if (this.closed) break;
        this.logger.warn(`[skill-conv-worker] peek error: ${(err as Error).message}`);
        await sleep(200);
        continue;
      }
      if (!agent) continue;
      try {
        await this.consumeAgent(agent);
      } catch (err) {
        this.logger.error(`[skill-conv-worker] consumeAgent error: ${(err as Error).message}`);
      }
    }
  }

  /**
   * The complete 8-step flow of consuming one agent. By default called internally from runLoop; also exposed externally for
   * SkillWorkerPool to reuse — each workerLoop in the pool only handles scheduling (dequeue +
   * resolver + legacy fallback), and the concrete extraction still goes through here, to avoid duplicate implementations.
   */
  async consumeAgent(agent: AgentTuple): Promise<{
    agent: AgentTuple;
    processedTaskIds: string[];
    lockContended?: boolean;
    dropped?: string[];
  }> {
    const q = this.opts.queue;
    const extractLockTtl = this.opts.extractLockTtlMs ?? 600_000;
    const mutexOpts = {
      lockTtlMs: this.opts.tasksMutexLockTtlMs ?? 10_000,
      waitDeadlineMs: this.opts.tasksMutexWaitDeadlineMs ?? 30_000,
    };
    const perRound = this.opts.tasksPerRound ?? 1;
    const processedTaskIds: string[] = [];
    const dropped: string[] = [];

    // 2026-08-03 crash-recovery: the peek strategy decides the failure/success branch behavior.
    //   - lmove / evalsha / eval  → atomic path, the agent is already in the List, the branches no longer explicitly requeue,
    //     the success path no longer removes either, relying on lazy deletion when the next peek sees empty tasks.
    //   - rpop_lpush_downgrade    → non-atomic v1 semantics: the failure/success branches requeue / remove as before,
    //     combined with the pool-side periodic selfHealScan as a safety net.
    // See docs/design/2026-07-21-skill-worker-crash-recovery.md §5.3.
    const isDowngrade =
      (typeof q.getPeekStrategy === "function" ? q.getPeekStrategy() : "lmove") ===
      "rpop_lpush_downgrade";

    const instanceId = agent.instance_id;
    // agentKey keeps the 4-segment (space|user|team|agent) semantics, without adding an instance_id segment —
    // compatible with old observability-panel SQL that filters/aggregates by agent_key. instance_id is carried separately as a field,
    // for the backend to group and filter by instance dimension (corresponding to the troubleshooting needs after the pooling refactor).
    const agentKey = `${agent.space_id}|${agent.user_id}|${agent.team_id}|${agent.agent_id}`;
    // [obs] worker-segment structured events: consume_start → acquire_lock → read_head →
    //   read_archive → extractor → apply_candidates → delete_task → consume_done。
    // before task_id is obtained, locate by agent_key + worker_id; after task_id is obtained every event
    // carries task_id — the handler-side skill.trigger.enqueue_agent event already carries the same task_id,
    // so the backend can pull both the handler + worker segments by task_id.
    // obsLogger has internal try/catch + backend degradation; no extra defense is needed.
    const workerId = this.opts.workerId;
    const t0Consume = Date.now();
    obsLogger.info("skill.worker.consume_start", {
      worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
    });
    this.logger.info(`[skill-conv-worker] dequeued agent=${agentKey}`);

    // ② grab the extract-lock
    const t0Lock = Date.now();
    const handle = await q.acquireExtractLock(agent, extractLockTtl);
    obsLogger.info("skill.worker.acquire_lock", {
      worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
      dur_ms: Date.now() - t0Lock, acquired: !!handle,
    });
    if (!handle) {
      // 2026-08-03: on the atomic path the agent is already in the List (guaranteed by peek), so no requeue is needed;
      // on the degraded path, v1 semantics apply: requeue outside the mutex to ensure the agent is not lost.
      if (isDowngrade) {
        this.logger.info(`[skill-conv-worker] extract-lock contended agent=${agentKey}, requeue+sleep (downgrade)`);
        await q.requeueAgent(agent);
      } else {
        this.logger.info(`[skill-conv-worker] extract-lock contended agent=${agentKey}, sleep (peek keeps agent in queue)`);
      }
      const jitter = Math.floor(Math.random() * (this.opts.lockContentionSleepJitterMs ?? 500));
      await sleep((this.opts.lockContentionSleepMs ?? 2000) + jitter);
      obsLogger.info("skill.worker.consume_done", {
        worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
        outcome: "lock_contended", dur_ms: Date.now() - t0Consume,
      });
      return { agent, processedTaskIds: [], lockContended: true };
    }
    this.logger.info(`[skill-conv-worker] acquired extract-lock agent=${agentKey}`);

    // ②.5 start the renewal timer — ensures the lock does not drop during long LLM runs
    const renewInterval = this.opts.extractLockRenewIntervalMs ?? Math.floor(extractLockTtl / 4);
    let renewTimer: ReturnType<typeof setInterval> | undefined;
    if (renewInterval > 0) {
      renewTimer = setInterval(() => {
        void (async () => {
          try {
            const ok = await q.renewExtractLock(handle, extractLockTtl);
            if (!ok) {
              this.logger.warn(
                `[skill-conv-worker] renew extract-lock lost agent=${agentKey}`,
              );
              if (renewTimer) clearInterval(renewTimer);
              renewTimer = undefined;
            }
          } catch (err) {
            this.logger.warn(
              `[skill-conv-worker] renew extract-lock error: ${(err as Error).message}`,
            );
          }
        })();
      }, renewInterval);
    }

    try {
      for (let round = 0; round < perRound; round++) {
        // ③ grab the mutex and read the head task.
        //
        // Key fix (root cause of phantom tasks): the removeAgent after the emptiness check must be done inside
        // the same tasks-mutex critical section, and cannot wait until the mutex is released — otherwise
        // TriggerService.archive() might grab the mutex in this lock-free window and write a new
        // task, but at that moment the agent has not yet been removed from the Redis Set (this function's removeAgent
        // has not run yet), and enqueueAgent's SADD would return 0 because "the Set already has it" and skip
        // the LPUSH — the new task lands but the Redis queue has no record of it, stuck forever as a phantom task.
        // Pulling removeAgent into the same lock, together with the trigger-service.ts fix
        // (moving enqueueAgent into the critical section that writes the task), guarantees mutual exclusion on both sides.
        const t0Head = Date.now();
        const head = await q.withTasksMutex(agent, mutexOpts, async () => {
          const doc = await this.opts.buffer.readTasks(agent);
          const first = doc.tasks[0] ?? null;
          if (!first) {
            await q.removeAgent(agent);
          }
          return first;
        });
        obsLogger.info("skill.worker.read_head", {
          worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
          dur_ms: Date.now() - t0Head, has_head: !!head,
        });

        if (!head) {
          // tasks empty → the agent was already taken offline inside the critical section above; break out
          obsLogger.info("skill.worker.consume_done", {
            worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
            outcome: "empty", dur_ms: Date.now() - t0Consume,
          });
          return { agent, processedTaskIds, dropped };
        }

        // task_id is in place: from here on every event carries task_id, correlating with the handler side's same task_id
        // (the handler's skill.trigger.enqueue_agent already carried it once).
        const t0Task = Date.now();
        obsLogger.info("skill.worker.task_start", {
          worker_id: workerId,
          task_id: head.task_id,
          instance_id: instanceId,
          task_ref_id: head.task_ref_id,
          session_id: head.session_id,
          team_id: head.team_id,
          agent_id: head.agent_id,
          archive_key: head.archive_key,
        });

        // ④ read the archive
        let candidates: ExtractedCandidate[] | null = null;
        let isGhost = false;
        try {
          this.logger.info(
            `[skill-conv-worker] processing task_id=${head.task_id} archive_key=${head.archive_key}`,
          );
          const t0Arch = Date.now();
          const archive = await this.opts.buffer.readArchive(head.archive_key);
          obsLogger.info("skill.worker.read_archive", {
            worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
            dur_ms: Date.now() - t0Arch,
            found: !!archive,
            msg_count: archive?.messages?.length ?? 0,
          });
          if (!archive) {
            isGhost = true;
            this.logger.warn(
              `[skill-conv-worker] ghost task, dropping task_id=${head.task_id} archive_key=${head.archive_key}`,
            );
            obsLogger.warn("skill.worker.ghost", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              archive_key: head.archive_key,
            });
          } else {
            const conversation = (archive.messages ?? []).map((m) => ({
              role: String(m.role ?? "user"),
              content: String(m.content ?? ""),
            }));
            this.logger.info(
              `[skill-conv-worker] extract start task_id=${head.task_id} messages=${conversation.length}`,
            );
            const t0Ext = Date.now();
            const result = await this.opts.extractor.extract({
              task_id: head.task_id,
              team_id: head.team_id,
              user_id: head.user_id,
              agent_id: head.agent_id,
              // Langfuse trace binding fields: if not passed through, the skill.extract trace has
              // sessionId=null / instanceId=unknown, and filtering by session on the page would not find it.
              session_id: head.session_id,
              space_id: head.space_id,
              conversation,
              // Pass through the fields exclusive to direct-trigger (`/v3/skill/extract`); tasks archived by conversation/add
              // do not carry these two fields, and undefined does not affect the extractor (it takes the default).
              reason: head.reason,
              options: head.max_iterations != null
                ? { max_iterations: head.max_iterations }
                : undefined,
              // strict_mode passthrough: for old tasks (enqueued before the upgrade) the mode field does not exist, and undefined is passed
              // to the extractor, always taking SKILL_REVIEW_PROMPT (v2 lenient) — zero regression; only tasks written by cold start with
              // mode='strict' switch to SKILL_REVIEW_PROMPT_STRICT (v1 strict gate).
              mode: head.mode,
            });
            candidates = result.candidates ?? [];
            obsLogger.info("skill.worker.extractor", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              dur_ms: Date.now() - t0Ext,
              candidates: candidates.length,
              msg_count: conversation.length,
            });
            this.logger.info(
              `[skill-conv-worker] extract done task_id=${head.task_id} candidates=${candidates.length}`,
            );
            const t0Sink = Date.now();
            await this.opts.sink.applyCandidates({
              task: head,
              candidates,
              workerId: this.opts.workerId,
            });
            obsLogger.info("skill.worker.apply_candidates", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              dur_ms: Date.now() - t0Sink,
              candidates: candidates.length,
            });
          }
        } catch (err) {
          // Failure tiering (aligned with design doc §3.6 (7) P0 fix):
          //   transient → sleep + requeue, retry_count unchanged
          //   permanent → sleep + retry_count++ written back; move into the DLQ when the threshold is reached
          //   classification fallback → handled as transient (conservative, no data loss)
          const errMsg = (err as Error).message ?? String(err);
          const category = classifyError(err as Error);
          if (category === "transient") {
            this.logTransientFailure(head.task_id, errMsg);
            // Note: outcome uses the shorthand `retry_transient` without the "transient" keyword —
            // the DLQ unit test uses .includes("transient") to count transient samples,
            // avoiding obsLogger events being counted as well.
            obsLogger.info("skill.worker.task_done", {
              worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
              outcome: "retry_transient", dur_ms: Date.now() - t0Task,
            });
            await sleep(this.opts.failureRequeueSleepMs ?? 2000);
            // 2026-08-03: on the atomic peek path the agent is still in the List and task.json is untouched,
            // so the next peek directly gets the same head and reruns; the degraded path requeues explicitly.
            if (isDowngrade) await q.requeueAgent(agent);
            break;
          }
          // permanent
          // clear the transient counter, to prevent historical transients from interfering with later sampling.
          this.transientFailStreak.delete(head.task_id);
          obsLogger.info("skill.worker.task_done", {
            worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
            outcome: "dlq_or_retry", dur_ms: Date.now() - t0Task,
          });
          await sleep(this.opts.failureRequeueSleepMs ?? 2000);
          await this.handlePermanentFailure(agent, head, errMsg, mutexOpts, isDowngrade);
          break;
        }

        // ⑤ extraction succeeded or phantom task → CAS filter-delete the task (by task_id).
        //
        // 2026-08-03 crash-recovery §4.1: on the atomic peek path, the remaining tasks are no longer judged
        // and there is no requeue/remove — the agent stays in the List, relying on the next peek reading empty tasks
        // to lazily delete within the same mutex (see the tasks-empty branch of step ③).
        //
        // The degraded path (peekAgent only pops without pushing) uses v1 semantics: judge the remainder → requeue/remove,
        // ordered via the same mutex as trigger-service.archive().
        const t0Del = Date.now();
        let remainingTasks = 0;
        await q.withTasksMutex(agent, mutexOpts, async () => {
          const doc = await this.opts.buffer.readTasks(agent);
          const before = doc.tasks.length;
          doc.tasks = doc.tasks.filter((t) => t.task_id !== head.task_id);
          if (doc.tasks.length !== before) {
            doc.updated_at_ms = this.opts.now?.() ?? Date.now();
            await this.opts.buffer.writeTasks(agent, doc);
          }
          remainingTasks = doc.tasks.length;
          if (isDowngrade) {
            if (doc.tasks.length > 0) {
              await q.requeueAgent(agent);
            } else {
              await q.removeAgent(agent);
            }
          }
          // atomic path: do nothing; the agent is already in the List, and the next peek triggers lazy deletion.
        });
        obsLogger.info("skill.worker.delete_task", {
          worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
          dur_ms: Date.now() - t0Del,
          remaining: remainingTasks,
        });

        // trace.report backend span: aligned with skill.extract / skill.conversation_add,
        // so both the handler + worker segments can be pulled in clickhouse / langfuse by task_id.
        try {
          trace.report("skill.worker.task_done", {
            task_id: head.task_id,
            instance_id: instanceId,
            task_ref_id: head.task_ref_id,
            team_id: head.team_id,
            agent_id: head.agent_id,
            session_id: head.session_id,
            outcome: isGhost ? "ghost" : "ok",
            candidates: candidates?.length ?? 0,
            dur_ms: Date.now() - t0Task,
            success: true,
          });
        } catch { /* noop */ }

        obsLogger.info("skill.worker.task_done", {
          worker_id: workerId, task_id: head.task_id, instance_id: instanceId,
          outcome: isGhost ? "ghost" : "ok",
          candidates: candidates?.length ?? 0,
          dur_ms: Date.now() - t0Task,
        });

        if (isGhost) dropped.push(head.task_id);
        else processedTaskIds.push(head.task_id);
      }

      obsLogger.info("skill.worker.consume_done", {
        worker_id: workerId, agent_key: agentKey, instance_id: instanceId,
        outcome: "ok",
        processed: processedTaskIds.length,
        dropped: dropped.length,
        dur_ms: Date.now() - t0Consume,
      });
      return { agent, processedTaskIds, dropped };
    } finally {
      // ⑥ stop renewal + release the extract-lock
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = undefined;
      }
      try {
        await q.releaseExtractLock(handle);
      } catch (err) {
        this.logger.warn(
          `[skill-conv-worker] releaseExtractLock error: ${(err as Error).message}`,
        );
      }
    }
  }

  /**
   * transient failure log sampling: the first is printed at error level, then every N occurrences a summary is printed at warn level,
   * to prevent log flooding. N is controlled by `transientLogSampleEvery` (default 60).
   */
  private logTransientFailure(taskId: string, errMsg: string): void {
    const prev = this.transientFailStreak.get(taskId) ?? 0;
    const streak = prev + 1;
    this.transientFailStreak.set(taskId, streak);
    const every = this.opts.transientLogSampleEvery ?? 60;
    if (streak === 1) {
      this.logger.error(
        `[skill-conv-worker] transient extract failure task=${taskId}: ${errMsg}`,
      );
    } else if (every > 0 && streak % every === 0) {
      this.logger.warn(
        `[skill-conv-worker] transient extract failure (x${streak}) task=${taskId}: ${errMsg}`,
      );
    }
  }

  /**
   * permanent failure: grab the tasks-mutex and read-modify-write `_tasks.json`.
   *
   *   - retry_count+1 < permanentMaxRetries: write back the task entry, requeue the agent
   *   - retry_count+1 >= permanentMaxRetries: remove the task from `_tasks.json`,
   *     append it to `_tasks_dlq.json`, and the remaining tasks decide requeue / remove
   *
   * Key: the `_tasks.json` read-modify-write must be in the same critical section, following the same pattern as the success path (to avoid
   * racing with trigger-service.archive()). The DLQ write does not take the mutex: the Worker already holds
   * the extract-lock, so each agent has only one writer.
   */
  private async handlePermanentFailure(
    agent: AgentTuple,
    head: SkillTaskEntry,
    errMsg: string,
    mutexOpts: { lockTtlMs: number; waitDeadlineMs: number },
    isDowngrade: boolean,
  ): Promise<void> {
    const q = this.opts.queue;
    const maxRetries = this.opts.permanentMaxRetries ?? 3;
    const truncated = errMsg.length > 1024 ? errMsg.slice(0, 1024) : errMsg;
    const nowMs = () => this.opts.now?.() ?? Date.now();

    let deadTask: SkillTaskEntry | null = null;

    await q.withTasksMutex(agent, mutexOpts, async () => {
      const doc = await this.opts.buffer.readTasks(agent);
      const idx = doc.tasks.findIndex((t) => t.task_id === head.task_id);
      if (idx < 0) {
        // the task was already cleared elsewhere (phantom reclamation / DLQ rerun); this permanent failure is treated as invalid.
        this.logger.warn(
          `[skill-conv-worker] permanent failure but task gone task=${head.task_id}`,
        );
        // 2026-08-03: the atomic path does not requeue/remove, relying on next-round lazy deletion; the degraded path uses v1 semantics.
        if (isDowngrade) {
          if (doc.tasks.length > 0) await q.requeueAgent(agent);
          else await q.removeAgent(agent);
        }
        return;
      }
      const cur = doc.tasks[idx]!;
      const nextRetry = (cur.retry_count ?? 0) + 1;
      if (nextRetry >= maxRetries) {
        // → DLQ: remove from _tasks.json
        deadTask = { ...cur, retry_count: nextRetry, last_error: truncated };
        doc.tasks.splice(idx, 1);
        doc.updated_at_ms = nowMs();
        await this.opts.buffer.writeTasks(agent, doc);
        this.logger.error(
          `[skill-conv-worker] permanent failure → DLQ task=${head.task_id} ` +
            `retries=${nextRetry}/${maxRetries} err=${truncated}`,
        );
      } else {
        doc.tasks[idx] = { ...cur, retry_count: nextRetry, last_error: truncated };
        doc.updated_at_ms = nowMs();
        await this.opts.buffer.writeTasks(agent, doc);
        this.logger.warn(
          `[skill-conv-worker] permanent failure task=${head.task_id} ` +
            `retries=${nextRetry}/${maxRetries} err=${truncated}`,
        );
      }
      if (isDowngrade) {
        if (doc.tasks.length > 0) await q.requeueAgent(agent);
        else await q.removeAgent(agent);
      }
    });

    // the DLQ write is outside the mutex: the Worker holds the extract-lock exclusively for that agent, and the DLQ has no other writers.
    if (deadTask) {
      const dead: SkillDeadTaskEntry = {
        ...(deadTask as SkillTaskEntry),
        dead_lettered_at_ms: nowMs(),
      };
      try {
        await this.opts.buffer.appendDlq(agent, dead);
      } catch (err) {
        this.logger.error(
          `[skill-conv-worker] appendDlq failed task=${head.task_id}: ${(err as Error).message}`,
        );
      }
    }
  }
}

/**
 * Classify the Error thrown by extract/sink into transient (self-healing) or permanent (data/schema)
 * two classes. The rules are simple, matching by the HTTP status code in the error message + keywords; unrecognized ones fall back to
 * transient — conservative, no data loss.
 *
 * See docs/design/2026-07-21-memorycore-standalone-e2e.md §3.6 (7) for the full classification matrix.
 */
export function classifyError(err: Error): "transient" | "permanent" {
  const raw = `${err?.name ?? ""} ${err?.message ?? ""}`;
  const msg = raw.toLowerCase();
  // AbortError (LLM request cancelled by signal / timeout) is treated as transient
  if ((err?.name ?? "") === "AbortError") return "transient";

  // ── permanent matched first: explicit 4xx data/schema errors ──
  // HTTP 400 / 422
  if (/(^|[^\d])(400|422)([^\d]|$)/.test(msg)) return "permanent";
  // JSON parse error / schema validation error / "invalid response" class
  if (
    msg.includes("json.parse") ||
    msg.includes("unexpected token") ||
    msg.includes("invalid json") ||
    msg.includes("invalid response") ||
    msg.includes("schema") ||
    msg.includes("zod") ||
    msg.includes("validation failed")
  ) {
    return "permanent";
  }

  // ── transient recognition ──
  // HTTP 401/403/429/5xx
  if (/(^|[^\d])(401|403|429|5\d{2})([^\d]|$)/.test(msg)) return "transient";
  // common network error codes / fetch layer
  if (
    msg.includes("econnrefused") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("eai_again") ||
    msg.includes("socket hang up") ||
    msg.includes("client network socket disconnected") ||
    msg.includes("fetch failed") ||
    msg.includes("und_err_") ||
    msg.includes("timeout") ||
    msg.includes("timed out")
  ) {
    return "transient";
  }

  // fallback: unrecognized errors are handled as transient (no data loss)
  return "transient";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
