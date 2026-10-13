/**
 * SessionStore — L1 in-memory cache for session initialization state.
 *
 * Two-layer persistence:
 *   - L2a: `SessionRepo` — full SessionInitState (30 min pending TTL)
 *   - L2b: `BindingRepo` — minimal id-group binding, used for waking sleeping
 *          conversations (currently permanent under nottl/ prefix)
 *
 * See docs/design/2026-07-10-cos-ttl-nottl-split-plan.md §4.3.
 *
 * ── Identity binding ──────────────────────────────────────────────────────
 * Public API keeps a single `keyId: string` as the L1 map key
 * (historically `${agentSource}:${sessionKey}` from handler.ts). Repo calls
 * however now require `(userId, agentSource, sessionId)`. To avoid rippling
 * that tuple through every `store.set(...)` call site in the session-init
 * state machine, the store maintains a keyId → identity map (`identities`):
 * callers invoke `bind(keyId, identity)` **once** when they have identity in
 * hand, and subsequent `set` / `delete` / `getOrRecover` pull the identity
 * back out. When no identity has been bound (e.g. anonymous / systemUser
 * requests that never rendezvous with auth), repo writes silently no-op.
 *
 * `getOrRecover` also takes an explicit identity param — it's the primary
 * entry point on every turn, so binding-through-that-path is guaranteed.
 */

import type { SessionInitState, SessionInitStatus, SessionInfo, AgentDetail, TaskDetail } from "./types.js";
import { getSessionRepo, type SessionRepo } from "../db/sessionRepo.js";
import type { BindingRepo, SessionBinding } from "../db/binding-repo.js";
import type { MetadataClient } from "../meta/client.js";
import { isDshRuntimeContextSnapshot } from "../common/user-query-extractor.js";
import type { PresetIdentity } from "./preset.js";

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Identity tuple used by every Repo call (SessionRepo / BindingRepo).
 *
 * `spaceId` is a field added in P4 (kernel-sts), used for key composition when STS permissions are isolated per space.
 * Old callers that do not pass it are treated as `""` (empty string); the Repo handles it internally with a `_default` fallback segment.
 */
export interface SessionIdentity {
  userId: string;
  agentSource: string;
  sessionId: string;
  spaceId?: string;
}

/** Extract spaceId from identity, defaulting to `""` for repo helpers. */
function spaceOf(id: SessionIdentity): string {
  return id.spaceId ?? "";
}

/** Context passed to getOrRecover for recovery. */
export interface RecoveryContext {
  /** MetadataClient for kernel agent/task get during recovery. */
  metadataClient?: MetadataClient;
  /** Full message history for fallback recovery via form-envelope scan. */
  messages?: Record<string, unknown>[];
  /**
   * Identity pre-parsed from request headers (x-team-id/x-agent-id/x-task-id).
   * When present, history-scan is skipped: header-identity agents (e.g. Pi)
   * carry no interactive form markers, so scanning would unconditionally bypass
   * them. Instead we defer to handleSessionInit (the headerAutoSelect path).
   */
  presetIdentity?: PresetIdentity;
}

export class SessionStore {
  private states = new Map<string, SessionInitState>();
  /** keyId → identity map — populated via {@link bind} to keep repo/binding writes user-namespaced. */
  private identities = new Map<string, SessionIdentity>();
  private ttlMs: number;
  private repo?: SessionRepo;
  private bindingRepo?: BindingRepo;
  private recoveryInFlight = new Map<string, Promise<SessionInitState | undefined>>();

  constructor(
    ttlMs: number = DEFAULT_TTL_MS,
    repo?: SessionRepo,
    bindingRepo?: BindingRepo,
  ) {
    this.ttlMs = ttlMs;
    this.repo = repo;
    this.bindingRepo = bindingRepo;
  }

  /** Attach BindingRepo late (called after Redis / storage activation). */
  setBindingRepo(repo: BindingRepo): void {
    this.bindingRepo = repo;
  }

  /**
   * Lets the skill/memory bridge obtain the same BindingRepo instance.
   *
   * The bridge L2 fallthrough gets it from here — guarantees that both the Kv/Redis
   * instance wired up by the injection pipeline and mocks injected by unit tests can be read directly by the bridge, without reconstruction.
   */
  getBindingRepo(): BindingRepo | undefined {
    return this.bindingRepo;
  }

  /**
   * Associate a keyId with a full (userId, agentSource, sessionId) identity so
   * that later {@link set} / {@link delete} / {@link getOrRecover} calls can
   * route writes to `SessionRepo` / `BindingRepo` in the correct namespace.
   *
   * Callers with identity in hand (handler.ts, session-init entry points,
   * hydrateFromDb) invoke this once per keyId. Anonymous callers or L1-only
   * consumers (e.g. skill-bridge's `store.get`) can skip binding — the store
   * silently degrades to memory-only for such keys.
   */
  bind(keyId: string, identity: SessionIdentity): void {
    this.identities.set(keyId, identity);
  }

  /** Test-only helper: expose the identity map for assertions. */
  getBoundIdentity(keyId: string): SessionIdentity | undefined {
    return this.identities.get(keyId);
  }

  get(keyId: string): SessionInitState | undefined {
    const state = this.states.get(keyId);
    if (!state) return undefined;

    if (state.status !== "initialized" && Date.now() - state.startedAt > this.ttlMs) {
      this.states.delete(keyId);
      const id = this.identities.get(keyId);
      if (id) this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
      return undefined;
    }

    return state;
  }

  /**
   * Attaches the recovery source to the state as a **non-enumerable** field — the handler side reads
   * `state.__recoverySource` with unchanged semantics, but `deepEqual` / `JSON.stringify` /
   * `Object.keys` never see this transient marker, which keeps tests asserting "state after recovery
   * is fully equivalent to the original state" from breaking because of the added field.
   */
  private tagRecoverySource<T extends SessionInitState>(
    state: T,
    src: NonNullable<SessionInitState["__recoverySource"]>,
  ): T {
    const copy = { ...state } as T;
    Object.defineProperty(copy, "__recoverySource", {
      value: src,
      enumerable: false,
      writable: true,
      configurable: true,
    });
    return copy;
  }

  /**
   * L1 write + L2a await write-through + L2b fire-and-forget binding。
   *
   * ⚠ Contract: when `await store.set(...)` completes, the L2a repo has been awaited (success or silent failure).
   * See the 2026-07-13 fix: the original fire-and-forget semantics, in a multi-node deployment, let pod A
   * close the stream while the COS PUT was still in flight, and pod B's turn-2 missed L2a and fell straight into the tryHistoryScan
   * fallback → bypass → the request was passed through to the LLM.
   *
   * L2b binding is still fire-and-forget — written only in the `initialized` state, it is a
   * "small note" style of persistence used to wake long-sleeping conversations; write latency does not affect cross-node recovery of pending state.
   */
  async set(keyId: string, state: SessionInitState): Promise<void> {
    // `__recoverySource` is a transient hint produced by getOrRecover() only,
    // and must not leak into L1/L2a/L2b persistence. Strip it defensively here
    // so future callers who forward a getOrRecover() result into set() don't
    // pollute the repo (business callers currently all get state from store.get(), which has no such
    // field; this is the last line of defense).
    if (state.__recoverySource !== undefined) {
      const { __recoverySource: _drop, ...clean } = state;
      void _drop;
      state = clean as SessionInitState;
    }
    // resetFlow / resetEpoch are inherited automatically — after the pre-hook writes these two fields, the form flow
    // goes through several state transitions (pending_asset_confirm → pending_team_select → ...),
    // and at each transition point, hand-constructing a new state object easily drops these two fields, so completeRegistration
    // gets resetFlow=undefined and the handler side cannot recognize "this is the completion turn of a reset-initiated flow" →
    // the request gets passed through to the LLM and produces a hallucinated response.
    // Conservative approach: inherit from the old state once, only when the new state does not explicitly declare these two fields (value undefined).
    // Callers explicitly passing false / a concrete value are not overridden.
    const prev = this.states.get(keyId);
    if (prev) {
      if (state.resetFlow === undefined && prev.resetFlow !== undefined) {
        state = { ...state, resetFlow: prev.resetFlow };
      }
      if (state.resetEpoch === undefined && prev.resetEpoch !== undefined) {
        state = { ...state, resetEpoch: prev.resetEpoch };
      }
    }
    this.states.set(keyId, state);
    const id = this.identities.get(keyId);
    if (!id) {
      // No identity bound → this keyId is L1-only (anonymous session, tests
      // that bypass bind, etc.). Skip repo/binding persistence rather than
      // fabricating a partial identity.
      return;
    }
    // L2a write-through — MUST await; see the method header comment.
    // Second defensive catch: the contract requires implementers (KvSessionRepo / RedisSessionRepo /
    // SqliteSessionRepo) to degrade silently internally without throwing, but the interface layer adds another guard so that any later
    // added repo or test mock will never leak an exception to the 44 `await store.set(...)`
    // callers — L1 was already written successfully, and the main flow does not die because the L2a write failed.
    if (this.repo) {
      try {
        await this.repo.upsert(spaceOf(id), id.userId, id.agentSource, id.sessionId, state);
      } catch (err) {
        console.warn(
          `[session] L2a upsert failed for ${keyId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
    // L2b: only write binding on terminal states
    // await rather than fire-and-forget, keeping the same contract as L2a:
    // when `await store.set(...)` returns, L1 / L2a / L2b are all durable.
    // Each session triggers this only once, at the initialization terminal state, so the cost is manageable.
    if (state.status === "initialized" && this.bindingRepo) {
      // agentSource / userKey are now stored in internal binding fields (no longer in the key),
      // so the bridge can recover the full identity from just (spaceId, sessionId).
      // See docs/design/2026-08-03-binding-flatten.md.
      const binding: SessionBinding = state.bypassed
        ? {
            outcome: "bypassed",
            userId: state.userId,
            teamId: state.sessionInfo?.team_id,
            agentId: state.sessionInfo?.agent_id,
            taskId: state.sessionInfo?.task_id,
            agentSource: id.agentSource,
            userKey: state.sessionInfo?.user_key,
          }
        : {
            outcome: "initialized",
            userId: state.sessionInfo?.user_id || state.userId,
            teamId: state.sessionInfo?.team_id,
            agentId: state.sessionInfo?.agent_id,
            taskId: state.sessionInfo?.task_id,
            agentSource: id.agentSource,
            userKey: state.sessionInfo?.user_key,
          };
      try {
        await this.bindingRepo.putBinding(spaceOf(id), id.sessionId, binding);
      } catch (err) {
        console.warn(
          `[session] L2b binding write failed for ${keyId}: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  delete(keyId: string): void {
    this.states.delete(keyId);
    const id = this.identities.get(keyId);
    if (!id) return;
    this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
    void this.bindingRepo
      ?.deleteBinding(spaceOf(id), id.sessionId)
      .catch(() => {});
  }

  getStatus(keyId: string): SessionInitStatus {
    return this.get(keyId)?.status ?? "uninitialized";
  }

  cleanup(): void {
    const now = Date.now();
    for (const [keyId, state] of this.states) {
      if (state.status !== "initialized" && now - state.startedAt > this.ttlMs) {
        this.states.delete(keyId);
        const id = this.identities.get(keyId);
        if (id) this.repo?.deleteBySessionId(spaceOf(id), id.userId, id.agentSource, id.sessionId);
      }
    }
  }

  async hydrateFromDb(): Promise<number> {
    if (!this.repo) return 0;
    try {
      const rows = await this.repo.loadAllInitialized();
      let loaded = 0;
      for (const row of rows) {
        // L1 key convention matches handler.ts / init.ts entry sites:
        //   `${agentSource}:${sessionId}`
        // Also bind full identity so subsequent set() persists back through
        // the correct (userId, agentSource, sessionId) key path.
        const keyId = `${row.agentSource}:${row.sessionId}`;
        if (!this.states.has(keyId)) {
          this.states.set(keyId, row.state);
          this.identities.set(keyId, {
            userId: row.userId,
            agentSource: row.agentSource,
            sessionId: row.sessionId,
            spaceId: row.spaceId || undefined,
          });
          loaded++;
        }
      }
      if (loaded > 0) {
        console.log(`[session-db] hydrated ${loaded} initialized session(s) from disk`);
      }
      return loaded;
    } catch (err) {
      console.warn(
        "[session-db] hydrateFromDb failed:",
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    }
  }

  // ── Recovery layer ──────────────────────────────────────────────────────────

  /**
   * Get session state, or attempt recovery from L2b binding if hot cache missed.
   *
   * Returns undefined when the session should be treated as truly new
   * (caller then invokes handleSessionInit to pop the form).
   *
   * Recovery chain: L1 → L2a → L2b (kernel fetch) → history-scan fallback.
   */
  async getOrRecover(
    keyId: string,
    identity: SessionIdentity,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Bind identity for downstream set()/delete()/probeL2a callchain.
    this.identities.set(keyId, identity);

    // Step 1: L1
    //
    // ⚠ Only terminal states (`initialized`, including `bypassed`) are authoritative in L1 — once finalized
    // they never change; pending_* states **must not** short-circuit on an L1 hit, or we hit the multi-node cross-
    // pod stale-read bug (2026-07-14):
    //   turn-1 hits pod A → writes L1(A)=pending_asset_confirm + L2a
    //   turn-2 hits pod B → L2a probe reads pending_asset_confirm → advances to
    //                     pending_agent_select → writes L1(B) + L2a
    //   turn-3 hits pod A again → L1(A) is still pending_asset_confirm (no cross-pod
    //                       cache-invalidation notification) → if we short-circuit here we process
    //                       turn-3's agent answer with the stale state → extract takes the
    //                       "agent option text" into the asset_confirm branch →
    //                       unrecognized → session bypass → the request is passed through to
    //                       the LLM as is (user's perception: it left without choosing a task).
    //
    // Fix: for pending_*, regardless of an L1 hit, always go through probeL2a for the authoritative value; probeL2a
    // internally promotes and overwrites L1, after which `store.get(compositeKey)` in init.ts can
    // read the latest state. An L1 pending hit is kept as the last-resort fallback when L2a fails/misses
    // (see the branch after Step 2), so there is no regression in same-pod scenarios where L2a has not yet been persisted.
    //
    // Cost: one extra storage GET per turn (~50ms COS).
    // Multi-node stateless design: L1 is only a degraded fallback when L2a misses (COS jitter),
    // not an authoritative source. session-reset may run on any pod, so L1 initialized is not trustworthy.
    const l1 = this.get(keyId);
    // No L1 short-circuit for initialized — always go through L2a for the authoritative state.

    // Step 2: L2a SessionRepo (Redis / SQLite / ProxyStorage) — full SessionInitState.
    // Startup `hydrateFromDb()` covers the single-node case, but in multi-node
    // deployments a session initialized on node A won't be in node B's L1.
    // Without this probe every such request falls through to L2b + a fresh
    // `metadataClient.getAgent/getTask` roundtrip, even though the full
    // agentDetail/taskDetail is sitting in the storage layer. Pending state also
    // must return on a hit — see the multi-node stale L1 note in Step 1 above.
    if (this.repo) {
      const l2a = await this.probeL2a(keyId, identity);
      if (l2a) {
        // It only counts as a real "override stale L1" when L1 exists **and** status differs. The same status
        // is just the authoritative L2a read-back double-checking (pending_* goes through the L2a
        // probe every turn), no need to raise alarms in the log; the earlier unconditional "override stale L1" would mislead
        // observers into thinking there was a consistency problem.
        const stale = l1 && l1.status !== l2a.status ? " (override stale L1)" : "";
        console.log(`[cache] session=${keyId} L2a hit → promote L1${stale}`);
        return this.tagRecoverySource(l2a, "l2a");
      }
    }

    // Step 2.5: L1 degraded fallback when L2a misses.
    //
    // When L2a (COS) jitters / is briefly unavailable, continuing to L2b only yields the binding (written only in
    // initialized), and finally `tryHistoryScan` bypasses unconditionally — which is worse.
    // Falling back to L1 here is graceful degradation: "better a slightly stale but usable state".
    //
    // zombie / user-mismatch have already been invalidated inside `this.get()` and `probeL2a`,
    // so the l1 reaching here is guaranteed fresh + user-matched.
    if (l1) {
      console.log(`[cache] session=${keyId} L1 fallback (L2a miss, status=${l1.status})`);
      return this.tagRecoverySource(l1, "l1");
    }

    // Step 3: L2b Binding
    if (!this.bindingRepo) {
      console.log(`[cache] session=${keyId} miss (no bindingRepo) → history-scan`);
      const scanned = await this.tryHistoryScan(keyId, identity, ctx);
      return scanned ? this.tagRecoverySource(scanned, "history-scan") : undefined;
    }
    let binding: SessionBinding | null;
    try {
      binding = await this.bindingRepo.getBinding(spaceOf(identity), identity.sessionId);
    } catch {
      binding = null;
    }
    if (!binding) {
      console.log(`[cache] session=${keyId} miss (no binding) → history-scan`);
      const scanned = await this.tryHistoryScan(keyId, identity, ctx);
      return scanned ? this.tagRecoverySource(scanned, "history-scan") : undefined;
    }
    console.log(`[cache] session=${keyId} L2b binding hit outcome=${binding.outcome} → rebuild`);

    // Async touch (refresh 30d TTL, don't await)
    void this.bindingRepo
      .touchLastSeen(spaceOf(identity), identity.sessionId)
      .catch(() => {});

    // Step 3.1: bypassed outcome → construct bypass state
    if (binding.outcome === "bypassed") {
      const state: SessionInitState = {
        status: "initialized",
        keyId,
        startedAt: Date.now(),
        attemptCount: 0,
        bypassed: true,
        sessionInfo: null,
        agentDetail: null,
        taskDetail: null,
      };
      await this.set(keyId, state);
      return this.tagRecoverySource(state, "l2b");
    }

    // Step 3.2: initialized outcome → rebuild via kernel
    const rebuilt = await this.rebuildFromBinding(keyId, identity, binding, ctx);
    return rebuilt ? this.tagRecoverySource(rebuilt, "l2b") : undefined;
  }

  /**
   * L2a probe: read the full SessionInitState (agentDetail / taskDetail
   * included) from `SessionRepo` and, if valid, promote it back to L1.
   *
   * Returns undefined (caller should fall through to L2b) when:
   *   - the repo has no row for this key,
   *   - the stored userId disagrees with the current caller (cached identity
   *     no longer applies — same policy as L2b invalidation; row is dropped),
   *   - the row is a stale pending state past ttl (zombie session from a
   *     crashed node),
   *   - the underlying storage errored (degrade silently, same as elsewhere).
   *
   * Non-terminal statuses (`pending_*`) are ALSO returned so a form flow
   * started on node A can continue on node B.
   */
  private async probeL2a(
    keyId: string,
    identity: SessionIdentity,
  ): Promise<SessionInitState | undefined> {
    let row: SessionInitState | null;
    try {
      row = await this.repo!.getBySessionId(
        spaceOf(identity),
        identity.userId,
        identity.agentSource,
        identity.sessionId,
      );
    } catch (err) {
      // Diagnostics: also log when probeL2a errors; previously swallowed silently, leaving multi-node L2 misses untraceable
      console.log(
        `[cache] session=${keyId} L2a probe error space=${spaceOf(identity)} user=${identity.userId} src=${identity.agentSource} sid=${identity.sessionId}: ${(err as Error).message}`,
      );
      return undefined;
    }
    if (!row) {
      // Diagnostics: print the 4 segments actually used for the lookup, to ease manual comparison with keys in COS
      console.log(
        `[cache] session=${keyId} L2a miss space=${spaceOf(identity)} user=${identity.userId} src=${identity.agentSource} sid=${identity.sessionId}`,
      );
      return undefined;
    }

    // Zombie guard: pending forms past ttl are dropped (mirrors get()'s
    // in-memory ttl policy). Only pending — initialized sessions have no
    // ttl concept (users legitimately come back to old conversations).
    if (
      row.status !== "initialized" &&
      Date.now() - row.startedAt > this.ttlMs
    ) {
      console.log(
        `[session-recover] ${keyId} L2a pending expired (status=${row.status}, age=${Date.now() - row.startedAt}ms), invalidating`,
      );
      try {
        this.repo!.deleteBySessionId(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId);
      } catch {
        /* best-effort */
      }
      return undefined;
    }

    const storedUserId = row.userId ?? row.sessionInfo?.user_id;
    if (storedUserId && identity.userId && storedUserId !== identity.userId) {
      console.log(
        `[session-recover] ${keyId} L2a user mismatch (stored=${storedUserId}, current=${identity.userId}), invalidating`,
      );
      try {
        this.repo!.deleteBySessionId(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId);
      } catch {
        /* best-effort */
      }
      return undefined;
    }

    // Promote back to L1 so subsequent turns don't hit the repo at all.
    this.states.set(keyId, row);
    console.log(
      `[session-recover] ${keyId} L2a hit status=${row.status} (agent=${row.sessionInfo?.agent_id ?? "-"}, task=${row.sessionInfo?.task_id ?? "-"})`,
    );
    return row;
  }

  /** In-flight promise deduplication: same keyId → same rebuild promise. */
  private rebuildFromBinding(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    const inFlight = this.recoveryInFlight.get(keyId);
    if (inFlight) return inFlight;
    const p = this.doRebuild(keyId, identity, binding, ctx)
      .finally(() => this.recoveryInFlight.delete(keyId));
    this.recoveryInFlight.set(keyId, p);
    return p;
  }

  private async doRebuild(
    keyId: string,
    identity: SessionIdentity,
    binding: SessionBinding,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Step 4.1: user mismatch → invalidate binding
    if (binding.userId && identity.userId && binding.userId !== identity.userId) {
      console.log(`[session-recover] ${keyId} user mismatch (bound=${binding.userId}, current=${identity.userId}), invalidating`);
      await this.bindingRepo?.deleteBinding(spaceOf(identity), identity.sessionId);
      return undefined;
    }

    if (!ctx.metadataClient) {
      // No client → can't recover, degrade to one-shot bypass
      console.warn(`[session-recover] ${keyId} no metadataClient, one-shot bypass`);
      return {
        status: "initialized", keyId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }

    // Step 4.2: fetch details in parallel
    const [agentR, taskR] = await Promise.allSettled([
      binding.agentId ? ctx.metadataClient.getAgent(binding.agentId) : Promise.resolve(null),
      binding.taskId ? ctx.metadataClient.getTask(binding.taskId) : Promise.resolve(null),
    ]);

    const isNotFound = (e: unknown): boolean =>
      typeof e === "object" && e !== null && (e as { notFound?: boolean }).notFound === true;

    let agentDetail: AgentDetail | null = null;
    let taskDetail: TaskDetail | null = null;
    let agentNotFound = false;
    let taskNotFound = false;
    let anyKernelError = false;

    if (agentR.status === "fulfilled") {
      if (agentR.value) {
        agentDetail = {
          id: agentR.value.agent_id,
          name: agentR.value.name,
          description: agentR.value.description ?? undefined,
          prompt: agentR.value.prompt ?? undefined,
        };
      }
    } else {
      if (isNotFound(agentR.reason)) agentNotFound = true;
      else anyKernelError = true;
    }
    if (taskR.status === "fulfilled") {
      if (taskR.value) {
        taskDetail = {
          id: taskR.value.task_id,
          name: taskR.value.title,
          description: taskR.value.description ?? undefined,
        };
      }
    } else {
      if (isNotFound(taskR.reason)) taskNotFound = true;
      else anyKernelError = true;
    }

    // Step 4.3: dispatch
    if (agentNotFound) {
      console.log(`[session-recover] ${keyId} agent ${binding.agentId} not found, deleting binding`);
      await this.bindingRepo?.deleteBinding(spaceOf(identity), identity.sessionId);
      return undefined;
    }
    if (anyKernelError) {
      console.warn(`[session-recover] ${keyId} kernel unavailable, one-shot bypass`);
      // Don't delete binding; return one-shot bypass to serve this request
      return {
        status: "initialized", keyId, startedAt: Date.now(),
        attemptCount: 0, bypassed: true,
        sessionInfo: null, agentDetail: null, taskDetail: null,
      };
    }
    if (taskNotFound) {
      console.log(`[session-recover] ${keyId} task ${binding.taskId} not found, keeping agent`);
      // Update binding to drop taskId
      await this.bindingRepo?.putBinding(
        spaceOf(identity),
        identity.sessionId,
        { ...binding, taskId: undefined },
      );
      taskDetail = null;
    }

    // Step 4.4: construct rebuilt state
    // user_key / space_id are recovered from the binding (the binding also stores them after the 2-segment flattening),
    // so the SessionInfo fields recovered by the bridge L2 fallthrough are complete, and memory-bridge
    // no longer degrades to self-only when recovering chat_memory retrieval.
    const sessionInfo: SessionInfo = {
      session_id: identity.sessionId,
      user_id: binding.userId || identity.userId,
      team_id: binding.teamId || "",
      agent_id: binding.agentId || "",
      task_id: taskDetail ? binding.taskId : undefined,
      user_key: binding.userKey,
      space_id: identity.spaceId,
      created_at: new Date().toISOString(),
    };

    const rebuilt: SessionInitState = {
      status: "initialized",
      keyId,
      startedAt: Date.now(),
      attemptCount: 0,
      bypassed: false,
      sessionInfo,
      userId: binding.userId,
      agentDetail,
      taskDetail,
    };

    // Step 4.5: write back to L1 + L2a
    this.states.set(keyId, rebuilt);
    // await write-through, keeping the same contract as SessionStore.set (see its header comment):
    // the recovered rebuilt state is already in L2a before returning, avoiding the overhead of another rebuildFromBinding
    // if later turns of the same session hit a different pod.
    // For the defensive catch see the `set()` header comment.
    if (this.repo) {
      try {
        await this.repo.upsert(spaceOf(identity), identity.userId, identity.agentSource, identity.sessionId, rebuilt);
      } catch (err) {
        console.warn(
          `[session-recover] L2a upsert failed for ${keyId} during rebuild: ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    console.log(`[session-recover] ${keyId} rebuilt from binding (agent=${binding.agentId}, task=${binding.taskId ?? "-"})`);

    return rebuilt;
  }

  /**
   * Last-resort fallback: when L2b binding is also missing but the conversation
   * has multiple user messages, scan the history for session-init form envelopes
   * to determine whether this was a bypassed session or had chosen agent/task.
   *
   * - 0-1 user messages + no assistant/tool → truly new
   * - has form markers → attempt to extract agent/task from them
   * - has history but no markers → one-shot bypass (don't re-pop the form)
   */
  private async tryHistoryScan(
    keyId: string,
    identity: SessionIdentity,
    ctx: RecoveryContext,
  ): Promise<SessionInitState | undefined> {
    // Header-identity agents (e.g. Pi) carry identity in request headers, not
    // interactive picker forms — so their history has no form markers and the
    // scan below would unconditionally bypass them. When the caller already
    // parsed a preset identity from headers, defer to handleSessionInit (the
    // headerAutoSelect path) by returning undefined instead of bypassing.
    if (ctx.presetIdentity) {
      console.log(
        `[session-recover] ${keyId} preset identity present → defer to handleSessionInit (skip history-scan)`,
      );
      return undefined;
    }
    const messages = ctx.messages ?? [];
    if (messages.length === 0) return undefined;

    // Count user messages and check for assistant/tool existence.
    // dsh (deepseek-harness) stuffs 3 role=user metadata messages that are **not user input** into the first-frame body:
    //   - <system-reminder> workspace instructions
    //   - "Current runtime context." snapshot
    //   - <available_skills> list
    // Counting them as-is gives userCount>1 and misjudges the dsh first frame as "has history", triggering the markerless
    // one-shot bypass, so the session-init form never pops up. Here we skip dsh metadata user messages
    // and count only "real user input". See docs/dsh-recon/2026-08-14-dsh-capture-analysis.md §2.3.
    let userCount = 0;
    let hasAssistantOrTool = false;
    for (const m of messages) {
      const role = (m.role as string) ?? "";
      if (role === "assistant" || role === "tool") {
        hasAssistantOrTool = true;
        continue;
      }
      if (role !== "user") continue;
      // dsh metadata signature: content is a str and starts with a known anchor (fixed dsh internal text).
      // Skip only on an explicit signature, to avoid hurting real user input from the client.
      const c = (m as { content?: unknown }).content;
      if (typeof c === "string") {
        if (
          c.startsWith("<system-reminder>") ||
          isDshRuntimeContextSnapshot(c) ||
          c.startsWith("<system-reminder>\nA skill is a reusable")
        ) {
          continue;
        }
      }
      userCount++;
    }

    // Truly fresh: only one user message, no conversation yet
    if (userCount <= 1 && !hasAssistantOrTool) return undefined;

    // Has conversation history — try to scan for form envelope
    let foundBypass = false;
    let foundAgentId: string | undefined;
    let foundTaskId: string | undefined;

    for (const m of messages) {
      if (m.role !== "assistant") continue;
      const content = m.content;
      if (typeof content !== "string") {
        // Anthropic: content array
        if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block.type !== "tool_use") continue;
            if (typeof block.name !== "string") continue;
            // Look for AskUserQuestion with our session-init prefix
            if ((block.id as string)?.startsWith?.("toolu_cc_session_init_")) {
              const input = block.input as Record<string, unknown> | undefined;
              const question = (input?.question as string) ?? "";
              const options = input?.options as string[] | undefined;
              if (question.includes("关联") || question.includes("资产") || question.includes("associate") || question.includes("assets")) {
                // asset_confirm form — check if the next user message said "No"
                continue; // defer to extractAssetConfirm logic via bypass detection
              }
              if (options?.includes("否，本次不关联") || options?.includes("跳过") || options?.includes("No, do not associate this time") || options?.includes("Skip") || question.includes("SKIP")) {
                foundBypass = true;
              }
              if (question.includes("agent") || question.includes("Agent")) {
                for (const o of options ?? []) {
                  const m = o.match(/^(.+)\s\(([^)]+)\)$/);
                  if (m) foundAgentId = m[2];
                }
              }
            }
          }
        }
        continue;
      }
      // CodeBuddy: <question_answer> XML in string content
      if (!content.includes("<question_answer")) continue;
      // Check for asset_confirm bypass markers in the assistant form message
      if (content.includes("否，本次不关联") || content.includes("本次不关联") || content.toLowerCase().includes("do not associate this time")) {
        foundBypass = true;
      }
      // Extract agent_id from <question_item id="agent">
      const agentIdMatch = content.match(/<question_item\s+id="agent"[^>]*>[^<]*<\/question_item>/);
      if (agentIdMatch) {
        const valueMatch = agentIdMatch[0].match(/<value>([^<]+)<\/value>/);
        if (valueMatch) foundAgentId = valueMatch[1];
      }
    }

    if (!foundAgentId) {
      // Whether it is "chose No in history" or "no form marker at all", as long as the agent
      // identity cannot be recovered, treat it as uninitialized → return undefined so the upper layer runs session-init and pops the form.
      // Aligned with mem:session-reset semantics: a session that is not initialized = must init.
      console.log(`[session-recover] ${keyId} history scan → no agent marker, treating as uninitialized`);
      return undefined;
    }

    // Found agent_id in history — try kernel rebuild (same as L2b hit path)
    console.log(`[session-recover] ${keyId} history scan → agent=${foundAgentId} found in form, attempting rebuild`);
    const binding: SessionBinding = {
      outcome: "initialized",
      userId: identity.userId,
      agentId: foundAgentId,
      taskId: foundTaskId,
    };
    return this.rebuildFromBinding(keyId, identity, binding, ctx);
  }
}

/** Global singleton (reset on process restart). */
let _store: SessionStore | null = null;

export function getSessionStore(): SessionStore {
  if (!_store) {
    let repo: SessionRepo | undefined;
    try {
      repo = getSessionRepo();
    } catch (err) {
      console.warn(
        "[session-db] session repo unavailable, running memory-only:",
        err instanceof Error ? err.message : String(err),
      );
    }
    _store = new SessionStore(DEFAULT_TTL_MS, repo);
    void _store.hydrateFromDb();
  }
  return _store;
}

/** Reset the singleton — tests only. */
export function __resetSessionStoreForTests(): void {
  _store = null;
}
