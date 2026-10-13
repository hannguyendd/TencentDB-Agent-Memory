/**
 * IStateBackend — Pipeline state backend abstraction layer
 *
 * Architecture doc §5.1 / Requirement #7.1
 *
 * Core/Worker/Timer Scanner are programmed against this interface, switching backends via configuration:
 * - LocalStateBackend  (standalone, zero external dependencies)
 * - RemoteStateBackend (service-oriented deployment)
 *
 * The interface is extracted from the existing MemoryPipelineManager:
 * - Buffer    ← messageBuffers (Map<string, CapturedMessage[]>)
 * - State     ← sessionStates  (Map<string, PipelineSessionState>)
 * - Timer     ← ManagedTimer (l1Idle, l2Schedule)
 * - Queue     ← SerialQueue (l1Queue, l2Queue, l3Queue)
 * - Lock      ← l3Running / l3Pending mutual exclusion
 * - Capture   ← the atomic count+threshold+enqueue operation of notifyConversation
 */

// ============================
// Pipeline Session State
// ============================

/** Reuses the PipelineSessionState fields in the existing checkpoint.ts */
export interface PipelineSessionState {
  conversation_count: number;
  last_extraction_time: string;
  last_extraction_updated_time: string;
  last_active_time: number;
  l2_pending_l1_count: number;
  warmup_threshold: number;
  l2_last_extraction_time: string;
}

export const DEFAULT_PIPELINE_STATE: PipelineSessionState = {
  conversation_count: 0,
  last_extraction_time: "",
  last_extraction_updated_time: "",
  last_active_time: 0,
  l2_pending_l1_count: 0,
  warmup_threshold: 0,
  l2_last_extraction_time: "",
};

// ============================
// Timer
// ============================

export interface TimerEntry {
  /** Present for local timers so expiry callbacks preserve Instance routing. */
  instanceId?: string;
  member: string;
  fireAtMs: number;
}

// ============================
// Task Queue
// ============================

export interface TaskPayload {
  id: string;
  type: "L1" | "L2" | "L3" | "flush" | "offload-l1" | "offload-l15" | "offload-l2";
  instanceId: string;
  sessionId: string;
  /**
   * Tenant identity (optional). The v2 pipeline uses (teamId, agentId) to decide lock granularity and the
   * Redis hash tag, avoiding single-instance big-key hotspots; the offload subsystem does not depend on it.
   * When missing, the lock/key degrades to instance level (compatible with old callers).
   */
  teamId?: string;
  agentId?: string;
  priority: number; // 0=high, 1=normal, 2=low
  data?: Record<string, unknown>;
  createdAt: number;
  /** Internal delivery metadata. Never persisted when a task is enqueued. */
  _msgId?: string;
  _stream?: string;
  _ownerId?: string;
}

// ============================
// Capture Atomic
// ============================

export interface CaptureAtomicParams {
  instanceId: string;
  sessionId: string;
  /** Same as TaskPayload.teamId / agentId — decides the hash slot ownership of buffer + state. */
  teamId?: string;
  agentId?: string;
  /** Optional message payload for callers that still use StateBackend buffering. */
  messageJson?: string;
  threshold: number;
  fireAtMs: number;
  timerMember: string;
  taskPayload: TaskPayload;
  nowMs: number;
  /** Number of conversation turns added this time (each role=user message counts as one turn). Default 1. */
  rounds: number;
}

export interface CaptureAtomicResult {
  triggered: boolean;
  conversationCount: number;
}

// ============================
// IStateBackend
// ============================

export interface IStateBackend {
  // ═══ Buffer ═══
  // teamId/agentId are optional; when missing, the Redis backend hash tag degrades to {p:inst} (old layout).
  // v2 pipeline callers are recommended to always pass them, to avoid a single instance concentrating on one hash slot and forming a hot key.
  appendBuffer(instanceId: string, sessionId: string, message: string, teamId?: string, agentId?: string): Promise<void>;
  drainBuffer(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<string[]>;
  getBufferLength(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<number>;

  // ═══ Session State ═══
  getSessionState(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<PipelineSessionState | null>;
  updateSessionState(instanceId: string, sessionId: string, patch: Partial<PipelineSessionState>, teamId?: string, agentId?: string): Promise<void>;
  deleteSessionState(instanceId: string, sessionId: string, teamId?: string, agentId?: string): Promise<void>;
  /**
   * List all active sessions under an instance (used by the standalone-mode persister to replay checkpoints).
   * In Cluster mode, once hash tags are scattered this method can only cover a single node; the service-mode persister is not set so it is not called — it exists only for standalone compatibility.
   */
  listActiveSessions(instanceId: string): Promise<string[]>;

  // ═══ Timer ═══
  setTimer(instanceId: string, member: string, fireAtMs: number): Promise<void>;
  setTimerIfEarlier(instanceId: string, member: string, fireAtMs: number): Promise<boolean>;
  removeTimer(instanceId: string, member: string): Promise<void>;
  getExpiredTimers(instanceId: string, nowMs: number): Promise<TimerEntry[]>;

  // ═══ Task Queue ═══
  enqueueTask(task: TaskPayload): Promise<void>;
  consumeTask(workerId: string, blockMs?: number): Promise<TaskPayload | null>;
  ackTask(taskId: string): Promise<void>;
  /** Refresh a pending delivery only when it is still owned by ownerId. */
  refreshTaskClaim?(taskId: string, ownerId: string, idleMs?: number): Promise<boolean>;
  /** Acknowledge a pending delivery only when it is still owned by ownerId. */
  ackTaskIfOwned?(taskId: string, ownerId: string): Promise<boolean>;
  /** Atomically enqueue a replacement and ACK the owned pending delivery. */
  replacePendingTask?(taskId: string, ownerId: string, replacement: TaskPayload): Promise<boolean>;
  getQueueDepth(): Promise<{ high: number; low: number }>;
  /**
   * Snapshot of all tasks currently waiting in the queue (not yet consumed).
   * Used by `/v2/pipeline/status` to compute per-L-type queue stats with full
   * type/sessionId/instanceId info (queue is single-shared, but task.type
   * distinguishes L1/L2/L3 — see TaskPayload).
   *
   * Optional because remote queue implementations may opt out of expensive
   * full queue scans. Local backend (standalone) MUST implement.
   */
  listQueuedTasks?(): Promise<TaskPayload[]>;
  /** Claim pending messages not ACKed within the timeout (XPENDING + XCLAIM) */
  claimStaleTasks?(workerId: string, minIdleMs: number, count: number): Promise<TaskPayload[]>;

  // ═══ Lock ═══
  acquireLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  renewLock(key: string, ownerId: string, ttlMs: number): Promise<boolean>;
  releaseLock(key: string, ownerId: string): Promise<void>;

  // ═══ Atomic Capture ═══
  captureAtomic(params: CaptureAtomicParams): Promise<CaptureAtomicResult>;

  // ═══ Instance Lifecycle ═══
  /**
   * Purge all state associated with an instance: buffers, sessions, timers.
   * Called when an instance is destroyed.
   * @returns Counts of cleaned resources.
   */
  purgeInstance?(instanceId: string): Promise<{ sessions: number; timers: number; buffers: number }>;

  // ═══ Lifecycle ═══
  initialize?(): Promise<void>;
  destroy?(): Promise<void>;
}
