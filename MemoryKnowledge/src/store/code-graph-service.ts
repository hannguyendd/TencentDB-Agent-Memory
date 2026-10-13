/**
 * CodeGraphService — async orchestration of code-graph assets.
 *
 * Glues together IKnowledgeStore (metadata/state) + BuildQueue (background serial) + an injectable
 * worker (the actual git clone + codegraph build), implementing:
 *   - create/sync return immediately (fire-and-forget); the admin plane polls status;
 *   - state machine pending → processing(cloning/indexing) → ready / failed(+sync_error);
 *   - memory + team isolation, idempotency (same memory+team+repo+branch returns the existing one), hard delete + four-kind resource cleanup.
 *
 * delete semantics (008 / 007 §5.5): can be deleted in any state (including pending/processing).
 * An in-memory cancelled marker notifies the in-flight worker to abort (nothing persisted, no soft delete); at its
 * pre-finish checkpoint the worker, on finding it was deleted, skips ready/callbacks and does idempotent cleanup. Cleanup covers four kinds of resources:
 * instance pool (memory) → metadata row (hard delete) → disk directory (rmSync), each step in its own try/catch
 * so that a failure in any step does not affect the rest (exception-safe + idempotent). Remote metadata reporting is not done in this phase.
 *
 * The worker is injected to ease unit testing (no real git/codegraph needed); for the production implementation see where the router is assembled.
 * Physical directory: {dataRoot}/{service_id}/{team_id}/{code_graph_id}/ (001 multi-tenancy).
 */

import { join } from "node:path";
import { rmSync } from "node:fs";

import type {
  AuditAction,
  CodeGraphRow,
  IKnowledgeStore,
  ListOpts,
  CountOpts,
} from "./types.js";
import { BuildQueue } from "./build-queue.js";
import type { ICredentialStore } from "../source-auth/types.js";

export interface CodeGraphBuildContext {
  codeGraphId: string;
  serviceId: string;
  teamId: string;
  repoUrl: string;
  branch: string;
  /** Local working directory of this asset (checkout + index live here). */
  dir: string;
  /** Callable by the worker to update fine-grained internal state (cloning → indexing). */
  setInternalStatus: (s: string) => void;
}

export interface CodeGraphBuildResult {
  commitHash?: string;
  stats?: { files: number; nodes: number; edges: number };
}

export type CodeGraphWorker = (ctx: CodeGraphBuildContext) => Promise<CodeGraphBuildResult>;

/**
 * sync result (discriminated union):
 *   - ok        enqueued for rebuild;
 *   - not_found memory/team/id mismatch;
 *   - busy      currently pending/processing (concurrent rejection, maps to HTTP 409); step is the internal phase (may be null).
 */
export type SyncResult =
  | { kind: "ok"; row: CodeGraphRow }
  | { kind: "not_found" }
  | { kind: "busy"; status: "pending" | "processing"; step: string | null };

export interface CodeGraphServiceLogger {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
}

export interface CodeGraphServiceOptions {
  store: IKnowledgeStore;
  /** knowledge data root directory; asset directory = {dataRoot}/{service_id}/{team_id}/{code_graph_id}/. */
  dataRoot: string;
  worker: CodeGraphWorker;
  queue?: BuildQueue;
  logger?: CodeGraphServiceLogger;
  /** Callback config for TMC status notifications. Optional. */
  callbackConfig?: { tmcCallbackUrl: string };
  /**
   * External source credential store (when create carries a credential, it is persisted before enqueueing).
   * When not injected, create does not accept a credential parameter (public repo scenario).
   */
  credentialStore?: ICredentialStore;
  /**
   * Code source provider registry.
   *
   * Purpose: on create, decide the kind of the persisted credential by `provider.authMethod.kind`
   * (bearer / basic ...), avoiding hard-coding the auth method here.
   * When not injected and create carries a credential, it degrades to writing kind=bearer (backward compatible).
   */
  codeSourceRegistry?: {
    get(id: string): { authMethod: { kind: "bearer" | "basic" } } | undefined;
  };
  /**
   * Release the in-memory resources held by this code-graph (instance pool + close the index handle).
   * Injected rather than depending directly on module, keeping the store layer from depending back on the assembly layer. Idempotent: safe to call repeatedly.
   * Provided by module.ts at assembly (wraps instancePool.delete + closeIndex).
   */
  releaseInstance?: (codeGraphId: string) => void;
}

export interface CreateCodeGraphParams {
  service_id: string;
  team_id: string;
  repo_url: string;
  branch: string;
  repo_name?: string;
  owner_user_id?: string;
  user_id?: string;
  agent_id?: string;
  task_id?: string;
  visibility?: string;
  /**
   * External source credential (private repo). Passed in the same request as create; KS persists it **before enqueueing the build**,
   * eliminating the timing window of "create clones immediately, credential not yet written".
   */
  credential?: {
    provider_id: string;
    secret: string;
    username?: string;
  };
}

export class CodeGraphService {
  private readonly store: IKnowledgeStore;
  private readonly dataRoot: string;
  private readonly worker: CodeGraphWorker;
  private readonly queue: BuildQueue;
  private readonly logger?: CodeGraphServiceLogger;
  private readonly callbackConfig?: { tmcCallbackUrl: string };
  private readonly releaseInstance?: (codeGraphId: string) => void;
  private readonly credentialStore?: ICredentialStore;
  private readonly codeSourceRegistry?: CodeGraphServiceOptions["codeSourceRegistry"];
  /**
   * In-flight delete marker: set when delete hits a resource that is queued/executing,
   * read by the worker at checkpoints to decide whether to abort. In-memory only (same id is serialized by SerialQueue +
   * Node being single-threaded, so reads/writes have no concurrency). Removed after cleanup finishes.
   */
  private readonly cancelled = new Set<string>();

  constructor(opts: CodeGraphServiceOptions) {
    this.store = opts.store;
    this.dataRoot = opts.dataRoot;
    this.worker = opts.worker;
    this.queue = opts.queue ?? new BuildQueue();
    this.logger = opts.logger;
    this.callbackConfig = opts.callbackConfig;
    this.releaseInstance = opts.releaseInstance;
    this.credentialStore = opts.credentialStore;
    this.codeSourceRegistry = opts.codeSourceRegistry;
  }

  dirFor(serviceId: string, teamId: string, codeGraphId: string): string {
    return join(this.dataRoot, serviceId, teamId, codeGraphId);
  }

  /**
   * Idempotently create and build the graph asynchronously.
   * - Already exists (same memory+team+repo+branch) → return the existing row directly, no repeated build.
   * - New → insert as pending + background build.
   */
  create(params: CreateCodeGraphParams): { row: CodeGraphRow; existed: boolean } {
    const { row, existed } = this.store.createCodeGraph(params);
    if (!existed) {
      // ① Private repo: persist the credential before enqueueing (otherwise when the worker clones immediately the credential doesn't exist yet → 401).
      if (params.credential) {
        if (!this.credentialStore) {
          throw new Error("credential provided but credentialStore is not wired");
        }
        // The persisted kind is decided by the provider's auth method; when no registry is injected, degrade compatibly to bearer.
        const kind =
          this.codeSourceRegistry?.get(params.credential.provider_id)?.authMethod.kind ?? "bearer";
        this.credentialStore.put(
          { type: "code-graph", serviceId: row.service_id, resourceId: row.code_graph_id },
          { kind, secret: params.credential.secret, username: params.credential.username },
          params.credential.provider_id,
          params.user_id,
        );
      }
      this.audit(row, "create", `clone ${row.repo_url}@${row.branch}`, params.user_id);
      this.enqueueBuild(row);
    }
    return { row, existed };
  }

  /** Persist service_url for a code-graph. Returns updated row or null. */
  updateServiceUrl(serviceId: string, codeGraphId: string, serviceUrl: string): CodeGraphRow | null {
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, { service_url: serviceUrl });
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  /** Update code-graph metadata (repo_name, summary). Returns updated row or null. */
  updateMeta(serviceId: string, codeGraphId: string, patch: { repo_name?: string; summary?: string | null }): CodeGraphRow | null {
    return this.store.updateCodeGraphMeta(serviceId, codeGraphId, patch);
  }

  /** Re-fetch + rebuild (explicitly triggered by the admin plane). memory/team mismatch returns not_found; pending/processing returns busy. */
  sync(serviceId: string, teamId: string, codeGraphId: string, requesterUserId?: string): SyncResult {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return { kind: "not_found" };
    // Concurrent rejection: reject directly if queued/executing; do not overwrite state, do not re-enqueue, do not write audit.
    if (row.status === "pending" || row.status === "processing") {
      return { kind: "busy", status: row.status, step: row.internal_status };
    }
    const nextVersion = row.version + 1;
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "pending",
      internal_status: null,
      sync_error: null,
      version: nextVersion,
    });
    this.audit({ ...row, version: nextVersion }, "ingest", "manual sync", requesterUserId);
    const fresh = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (fresh) this.enqueueBuild(fresh);
    return fresh ? { kind: "ok", row: fresh } : { kind: "not_found" };
  }

  get(serviceId: string, teamId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraph(serviceId, teamId, codeGraphId);
  }

  /** Query by globally unique code_graph_id (still converge by service_id to prevent cross-tenant). Dedicated to the spec id-only endpoints. */
  getById(serviceId: string, codeGraphId: string): CodeGraphRow | null {
    return this.store.getCodeGraphById(serviceId, codeGraphId);
  }

  list(serviceId: string, teamId: string, opts?: ListOpts): CodeGraphRow[] {
    return this.store.listCodeGraphs(serviceId, teamId, opts);
  }

  count(serviceId: string, teamId: string, opts?: CountOpts): number {
    return this.store.countCodeGraphs(serviceId, teamId, opts);
  }

  /**
   * Delete a code-graph (008 / 007 §5.5). Can be deleted in any state (including pending/processing).
   * memory/team mismatch returns false; otherwise hard delete + four-kind resource cleanup, returns true.
   *
   * If the resource is queued/executing (pending/processing), first set the cancelled marker to notify the worker
   * to abort at a checkpoint; then immediately hard delete + clean up (without waiting for the worker). Before the worker finishes it re-checks and, on finding
   * it deleted, skips ready/callbacks and does one more idempotent cleanup, leaving no residue.
   */
  delete(serviceId: string, teamId: string, codeGraphId: string): boolean {
    const row = this.store.getCodeGraph(serviceId, teamId, codeGraphId);
    if (!row) return false;

    // Notify the in-flight worker to abort (pending in queue or processing executing).
    if (row.status === "pending" || row.status === "processing") {
      this.cancelled.add(codeGraphId);
    }

    this.audit(row, "delete", null);
    this.cleanupResources(serviceId, teamId, codeGraphId);

    // If the worker is still running, it will see at a checkpoint that the row was hard-deleted (getById → null) and abort;
    // the cancelled marker is left for the worker to clean up itself when it finishes (see runBuild); the marker is not deleted here,
    // to cover the window where "delete completes before the worker's checkpoint". cleanup is idempotent, so repeating is harmless.
    return true;
  }

  /**
   * Idempotent cleanup of four kinds of resources (order: release memory/connections first, then delete disk).
   * Each step has its own try/catch — a failure in any step does not affect the rest, ensuring exception safety.
   *   1. instance pool (memory): releaseInstance (pool.delete + closeIndex)
   *   2. metadata row: hard delete (safe even when 0 rows are hit, supporting double cleanup by worker + delete)
   *   3. disk directory: rmSync recursive+force (idempotent)
   * BuildQueue queued tasks skip by the runBuild entry check of cancelled/row existence; nothing to handle here.
   */
  private cleanupResources(serviceId: string, teamId: string, codeGraphId: string): void {
    try {
      this.releaseInstance?.(codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] release instance failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      this.store.deleteCodeGraph(serviceId, teamId, codeGraphId);
    } catch (err) {
      this.logger?.warn?.(`[code-graph] hard-delete row failed ${codeGraphId}: ${String(err)}`);
    }
    try {
      rmSync(this.dirFor(serviceId, teamId, codeGraphId), { recursive: true, force: true });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] rm dir failed ${codeGraphId}: ${String(err)}`);
    }
  }

  /**
   * Worker checkpoint: whether the resource has been deleted (cancelled marker hit, or the row no longer in the DB).
   * Dual criteria cover: ① delete happened while the worker was running (cancelled); ② delete already completed
   * and the row was hard-deleted (getById → null). Either counts as deleted.
   */
  private isDeleted(serviceId: string, codeGraphId: string): boolean {
    return this.cancelled.has(codeGraphId) || this.store.getCodeGraphById(serviceId, codeGraphId) === null;
  }

  /** Write a code-graph audit record. Failure does not block the main flow. */
  private audit(row: CodeGraphRow, action: AuditAction, detail: string | null, requesterUserId?: string): void {
    try {
      this.store.appendCodeGraphAudit({
        service_id: row.service_id,
        asset_id: row.code_graph_id,
        version: row.version,
        action,
        // Prefer recording the trigger (the initiator of sync/create), fall back to the row's creator.
        user_id: requesterUserId ?? row.user_id,
        agent_id: row.agent_id,
        detail,
      });
    } catch (err) {
      this.logger?.warn?.(`[code-graph] audit ${action} failed: ${String(err)}`);
    }
  }

  private enqueueBuild(row: CodeGraphRow): void {
    this.queue.enqueue(row.code_graph_id, () =>
      this.runBuild(row.service_id, row.code_graph_id, row.team_id, row.repo_url, row.branch),
    );
  }

  private async runBuild(
    serviceId: string,
    codeGraphId: string,
    teamId: string,
    repoUrl: string,
    branch: string,
  ): Promise<void> {
    // Entry checkpoint: deleted while pending → skip directly, do not set processing, do not build the graph.
    if (this.isDeleted(serviceId, codeGraphId)) {
      this.finishCancelled(serviceId, teamId, codeGraphId);
      return;
    }
    this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
      status: "processing",
      internal_status: "cloning",
      sync_error: null,
    });
    try {
      const result = await this.worker({
        codeGraphId,
        serviceId,
        teamId,
        repoUrl,
        branch,
        dir: this.dirFor(serviceId, teamId, codeGraphId),
        setInternalStatus: (s) =>
          this.store.updateCodeGraphStatus(serviceId, codeGraphId, { status: "processing", internal_status: s }),
      });
      // Pre-finish checkpoint: deleted while processing → skip ready/audit/callbacks, do idempotent final cleanup.
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "ready",
        internal_status: null,
        sync_error: null,
        commit_hash: result.commitHash ?? null,
        stats_json: result.stats ? JSON.stringify(result.stats) : null,
        last_sync_at: new Date().toISOString(),
      });
      const synced = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (synced) {
        this.audit(synced, "ready", result.stats ? JSON.stringify(result.stats) : null);
      }
      this.logger?.info?.(`[code-graph] ${codeGraphId} ready`);

      // Auto-generate summary + callback TMC
      await this.onBuildComplete(synced, "ready", null, result.stats ?? null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The worker threw, but if it was deleted in the meantime, treat as cancellation rather than failure: skip failed state/callbacks, do cleanup.
      if (this.isDeleted(serviceId, codeGraphId)) {
        this.finishCancelled(serviceId, teamId, codeGraphId);
        return;
      }
      this.store.updateCodeGraphStatus(serviceId, codeGraphId, {
        status: "failed",
        internal_status: null,
        sync_error: msg.slice(0, 500),
      });
      const failed = this.store.getCodeGraphById(serviceId, codeGraphId);
      if (failed) this.audit(failed, "failed", msg.slice(0, 500));
      this.logger?.warn?.(`[code-graph] ${codeGraphId} failed: ${msg}`);

      // Callback TMC about failure
      await this.onBuildComplete(failed, "failed", msg, null);
    }
  }

  /**
   * After the worker checkpoint judges "deleted", wrap-up: idempotently clean up disk/handles the worker may have just written,
   * and remove the cancelled marker (the worker for that id ends here; the marker has served its purpose).
   */
  private finishCancelled(serviceId: string, teamId: string, codeGraphId: string): void {
    this.cleanupResources(serviceId, teamId, codeGraphId);
    this.cancelled.delete(codeGraphId);
    this.logger?.info?.(`[code-graph] ${codeGraphId} build aborted (deleted during processing)`);
  }

  /**
   * Post-build hook: generate summary (if synced) and callback TMC.
   * Never throws — runs after the main build is already committed.
   */
  private async onBuildComplete(
    row: CodeGraphRow | null,
    status: "ready" | "failed",
    errorMsg: string | null,
    stats: { files: number; nodes: number; edges: number } | null,
  ): Promise<void> {
    if (!row || !this.callbackConfig) return;

    let summary: string | null = null;

    if (status === "ready") {
      // Generate summary via template (no LLM for code-graph)
      const { generateCodeGraphSummary } = await import("../callback.js");
      summary = generateCodeGraphSummary(row.repo_name || row.repo_url, row.branch, stats);
      if (summary) {
        this.store.updateCodeGraphStatus(row.service_id, row.code_graph_id, { summary });
      }
    }

    // Callback TMC
    const { callbackTMC } = await import("../callback.js");
    await callbackTMC(
      {
        knowledge_id: row.code_graph_id,
        service_id: row.service_id,
        type: "code-graph",
        status,
        summary,
        sync_error: errorMsg?.slice(0, 500) ?? null,
        timestamp: new Date().toISOString(),
      },
      this.callbackConfig,
    );
  }

  /** Wait for background tasks to finish (tests / shutdown). */
  async onIdle(codeGraphId?: string): Promise<void> {
    await this.queue.onIdle(codeGraphId);
  }
}
