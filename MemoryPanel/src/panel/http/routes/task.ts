/**
 * /api/v1/task/list-with-agents -- Task aggregation endpoint (eliminates N+1 at the Panel layer).
 *
 * Why this endpoint is needed:
 *   The kernel `task/list` only returns the task itself, without linked_agents.
 *   The frontend used to call `task/get` + `task-agent/list` one by one (2N+1 calls),
 *   10 tasks = 21 requests, a severe N+1.
 *
 * Panel-layer aggregation:
 *   1. Call the kernel `task/list` once to get the task list (with pagination)
 *   2. Call `task-agent/list` N times in parallel to fill in linked_agents
 *   3. Return `{ items: TaskWithAgents[], total, limit, offset }` to the frontend in one response
 *
 * Network round trips are absorbed inside the Panel layer (same host, very low latency), and the frontend sends only 1 request.
 *
 */
import type { Hono, Context } from "hono";
import type { PanelDeps } from "../../panel-deps.js";
import type { MetaCallContext } from "../../kernel/types.js";
import type { MetaEnvelope } from "../../kernel/envelope.js";
import { respondEnvelope, respondControlError } from "../envelope.js";
import { validatePanelMetaHeaders } from "../middleware/validate-panel-headers.js";

function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get("panelMeta");
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get("reqId"),
  };
}

function okEnvelope<T>(c: Context, data: T): MetaEnvelope<T> {
  return { code: 0, message: "ok", request_id: c.get("reqId") ?? "", data };
}

// ── Type definitions ──────────────────────────────────────────────────────────────────

interface TaskEntity {
  task_id: string;
  team_id: string;
  title: string;
  description?: string;
  status: string;
  source_type?: string;
  risk_level?: string;
  created_at: string;
  updated_at: string;
}

interface TaskAgent {
  agent_id: string;
  task_id: string;
  team_id: string;
  status: string;
  created_at: string;
}

interface TaskWithAgents extends TaskEntity {
  agents: TaskAgent[];
}

interface ListWithAgentsBody {
  team_id: string;
  limit?: number;
  offset?: number;
  status?: string;
  title?: string;
}

// ── Route registration ──────────────────────────────────────────────────────────────────

export function registerTaskRoutes(api: Hono, deps: PanelDeps): void {
  /**
   * POST /api/v1/task/list-with-agents
   *
   * Aggregates task/list + batched task-agent/list, returning the task list and its associated agents in one response.
   * The frontend only calls this one endpoint, no longer needing N+1.
   */
  api.post(
    "/task/list-with-agents",
    validatePanelMetaHeaders(deps),
    async (c) => {
      const body = await c.req
        .json<ListWithAgentsBody>()
        .catch(() => ({ team_id: "" }) as ListWithAgentsBody);
      const { team_id: teamId, limit, offset, status, title } = body;

      if (!teamId) {
        return respondControlError(c, 400, "MISSING_TEAM_ID");
      }

      const ctx = buildCtx(c);

      // 1. Call task/list once to get the task list (with pagination)
      const listPayload: Record<string, unknown> = { team_id: teamId };
      if (typeof limit === "number" && limit > 0)
        listPayload.limit = Math.min(limit, 200);
      if (typeof offset === "number" && offset >= 0)
        listPayload.offset = offset;
      if (status) listPayload.status = status;
      if (title) listPayload.title = title;

      const taskEnv = await deps.metaKernel.invoke(
        "task/list",
        listPayload,
        ctx,
      );

      if (taskEnv.code !== 0) return respondEnvelope(c, taskEnv);

      const taskData = taskEnv.data as {
        items?: TaskEntity[];
        total?: number;
        limit?: number;
        offset?: number;
      } | null;

      const tasks = taskData?.items ?? [];
      const total = taskData?.total ?? tasks.length;

      // 2. Call task-agent/list N times in parallel to fill in linked_agents
      //    Parallel in batches (20 per batch), to avoid overwhelming the kernel connection pool when N is large.
      //    Reads do not conflict with reads (SQLite WAL / MongoDB), but connections/threads have an upper limit.
      const BATCH_SIZE = 20;
      const agentsResults: TaskAgent[][] = [];
      for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
        const batch = tasks.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map((t) =>
            deps.metaKernel
              .invoke("task-agent/list", { task_id: t.task_id }, ctx)
              .then((env) =>
                env.code === 0 && env.data
                  ? ((env.data as { items?: TaskAgent[] }).items ?? [])
                  : [],
              )
              .catch(() => [] as TaskAgent[]),
          ),
        );
        agentsResults.push(...batchResults);
      }

      // 3. Merge and return
      const items: TaskWithAgents[] = tasks.map((t, i) => ({
        ...t,
        agents: agentsResults[i] ?? [],
      }));

      return c.json(
        okEnvelope(c, {
          items,
          total,
          limit: (listPayload.limit as number) ?? 50,
          offset: (listPayload.offset as number) ?? 0,
        }),
      );
    },
  );
}
