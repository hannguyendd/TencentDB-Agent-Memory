/**
 * In-memory state of Knowledge extraction tasks (temporary solution for this release; persisted next release).
 *
 * Background: the KS -> Panel status-callback is S2S and has no owner user_key,
 * so it cannot directly call kernel /v3/meta/asset/create as the owner (the ForCaller route requires
 * caller.user_id === owner_user_id). So when code-graph/create happens in Panel
 * (initiated by the frontend, carrying user_key), the owner key is temporarily recorded in memory, and when the callback
 * is ready it is taken out to register the meta asset as the owner.
 *
 * A process restart loses tasks -- a known corner case, covered by the frontend register-meta fallback,
 * and fixed at the root once persisted next release.
 */

export interface KnowledgeTask {
  knowledge_id: string;
  type: 'wiki' | 'code-graph';
  team_id: string;
  owner_user_id: string;
  /** Used to call the meta API as the owner when the callback registers the asset via S2S. */
  owner_user_key: string;
  service_id: string;
  created_at: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h: a codegraph build usually takes a few minutes, leaving ample margin

export class KnowledgeTaskRegistry {
  private readonly tasks = new Map<string, KnowledgeTask>();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  record(task: KnowledgeTask): void {
    this.sweep();
    this.tasks.set(task.knowledge_id, task);
  }

  peek(knowledgeId: string): KnowledgeTask | undefined {
    this.sweep();
    return this.tasks.get(knowledgeId);
  }

  /** Take out and delete -- called after the callback registers successfully, clearing finished tasks. */
  take(knowledgeId: string): KnowledgeTask | undefined {
    const t = this.tasks.get(knowledgeId);
    this.tasks.delete(knowledgeId);
    return t;
  }

  size(): number {
    return this.tasks.size;
  }

  /** Delete expired tasks to prevent leaks. Called opportunistically on record/peek. */
  sweep(now: number = Date.now()): void {
    for (const [id, t] of this.tasks) {
      if (now - t.created_at > this.ttlMs) this.tasks.delete(id);
    }
  }
}
