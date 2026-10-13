/**
 * TAPD external task source provider.
 *
 * Supports three kinds -- story / task / bug -- all of which can be bulk-imported per workspace (project).
 * Authentication uses a long-lived token entered manually by the user: a Taihu unified-auth token (bearer) or a TAPD personal token (custom),
 * injected by the caller via TaskSourceContext.
 *
 * All endpoints and the site root come from deployment config (injected via registry.contextFor); this file embeds no domain names.
 */

import { TaskSourceError, type CandidatePage, type ListCandidatesQuery, type RemoteTaskDetail, type RemoteTaskRef, type TaskSourceContext, type TaskSourceProvider, type TaskWorkspace } from "../../types.js";
import { TapdMcpClient, totalOf, unwrap } from "./mcp-client.js";
import {
  ITEM_TYPES,
  isItemType,
  keywordField,
  ownerField,
  rowScope,
  supportsVStatus,
  toDetail,
  toRef,
  toolFor,
} from "./mapper.js";

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_BATCH_SIZE = 50;

function clientFor(ctx: TaskSourceContext): TapdMcpClient {
  // custom auth (TAPD personal token) uses a dedicated header; bearer (Taihu token) uses Authorization.
  const headerName =
    ctx.cred.kind === "custom" && typeof ctx.cred.extra?.header === "string"
      ? ctx.cred.extra.header
      : undefined;
  return new TapdMcpClient({
    endpoint: ctx.endpoint,
    token: ctx.cred.secret,
    tokenHeader: headerName,
    timeoutMs: ctx.timeoutMs,
  });
}

function asRows(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is Record<string, unknown> => Boolean(r) && typeof r === "object");
}

/**
 * Sanitized diagnostics: an empty workspaces list is the typical symptom of "token invalid / incomplete / account has no projects",
 * but the API itself returns 200, so it is easily misjudged as "the panel did not load".
 *
 * **Only log the kind and length**, never the token in plaintext -- not even the prefix: a structured prefix (e.g. a token family identifier)
 * can by itself identify the token type/environment, which amounts to leaking its shape.
 * The endpoint is an internal infrastructure address, so likewise only log "whether it is configured" without echoing the value.
 */
function diagnosticLog(ctx: TaskSourceContext, raw: unknown): void {
  const rows = Array.isArray(raw) ? raw : [];
  if (rows.length > 0) return;
  console.warn(
    "[task-source:tapd] listWorkspaces returned empty — " +
      `kind=${ctx.cred.kind} token.len=${ctx.cred.secret.length} ` +
      `endpointSet=${Boolean(ctx.endpoint)} ` +
      `rawType=${Array.isArray(raw) ? "array(0)" : typeof raw}`,
  );
}

export const tapdProvider: TaskSourceProvider = {
  id: "tapd",
  itemTypes: ITEM_TYPES,
  maxBatchSize: MAX_BATCH_SIZE,
  needsWorkspace: true,
  /**
   * TAPD goes through MCP and the task kind does not return a detail link, so both are needed:
   *   - MCP_URL: the MCP endpoint
   *   - SITE_BASE_URL: the site root used to build detail page URLs
   * Declared here rather than in the registry, so connecting a new source needs no change to the generic layer.
   */
  requiredEnv: ["MCP_URL", "SITE_BASE_URL"],
  // The todo APIs (user_todo_*_get) are a TAPD-specific capability; the frontend only shows the "Todo" switch once declared.
  capabilities: { todo: true },
  // Both token kinds hit the same endpoint, differing only in header name (confirmed empirically).
  // Below the input box **only** the "How do I get a token?" link is shown (delivered via tokenUrlEnv),
  // with no additional explanatory text -- such text once misled users into filling in the example as content (they typed the example literal).
  authSchemes: [
    {
      kind: "bearer",
      label: "Taihu unified auth token",
      // The application page is on Taihu (a different domain from TAPD), and iWiki uses the same Taihu PAT page --
      // so it points to the **globally shared** TAI_PAT_URL (a full URL); changing the address only requires changing one place.
      tokenUrlEnv: "TAI_PAT_URL",
    },
    {
      kind: "custom",
      headerName: "x-tapd-access-token",
      label: "TAPD personal token",
      tokenUrlEnv: "TASK_SOURCE_TAPD_PERSONAL_TOKEN_URL",
    },
  ],

  async listWorkspaces(ctx: TaskSourceContext): Promise<TaskWorkspace[]> {
    const client = clientFor(ctx);
    const raw = await client.call("user_participant_workspace_get", {});
    // Sanitized diagnostics: only log kind/length/prefix, never the token in plaintext.
    // The project list comes from "projects I participate in" and is strongly tied to the account owning the token -- when empty, first confirm the token is
    // complete and belongs to an account with project permissions.
    diagnosticLog(ctx, raw);
    return asRows(raw)
      .filter((r) => (r["status"] === undefined || r["status"] === "normal"))
      .map((r) => ({
        id: String(r["id"] ?? ""),
        name: typeof r["name"] === "string" ? r["name"] : String(r["id"] ?? ""),
      }))
      .filter((w) => w.id);
  },

  async listCandidates(ctx: TaskSourceContext, q: ListCandidatesQuery): Promise<CandidatePage> {
    // workspace_id is a mandatory input of the regular list APIs (stories_get / tasks_get / bugs_get all require it),
    // but **the todo APIs treat it as optional**: omitted = all todos across projects, provided = only that project.
    // So mandatory validation only applies in non-todo mode.
    if (!q.onlyTodo && !q.scope) {
      throw new TaskSourceError("missing_scope", "TAPD requires workspace_id");
    }
    const types = (q.itemTypes?.length ? q.itemTypes : ITEM_TYPES.map((t) => t.id)).filter(
      (t): t is string => typeof t === "string" && isItemType(t),
    );
    if (!types.length) {
      throw new TaskSourceError("invalid_item_type", "no supported item types requested");
    }

    const limit = clampLimit(q.limit);
    const page = Number.isFinite(q.page) && (q.page ?? 0) > 0 ? Math.floor(q.page as number) : 1;
    const client = clientFor(ctx);

    // Todo mode: the API **only accepts workspace_id** (any other parameter is rejected) and does not support server-side pagination --
    // pull everything back and slice locally. Keyword/handler/status filters are ineffective in todo mode (the server rejects the parameters).
    if (q.onlyTodo) {
      // scope empty -> do not pass workspace_id, fetch all of the current user's todos across projects;
      // non-empty -> only that project. Each row carries its own workspace_id, which replaces the request-level scope for locating.
      const todoArgs = q.scope ? { workspace_id: q.scope } : {};
      const perType = await Promise.all(
        types.map(async (itemType) => {
          const raw = await client.callRaw(toolFor(itemType, true), todoArgs);
          const rows = asRows(unwrapData(raw));
          return { itemType, rows };
        }),
      );
      // Localized status (Chinese): **only when a project is specified** do the todo APIs return Chinese (empirically, cross-project returns raw codes
      // such as new/status_6). In cross-project mode, group by the in-row workspace_id and look up the mapping table to keep the display consistent.
      const statusMaps = q.scope
        ? {}
        : await loadTodoStatusMaps(client, rowsByScope(perType));

      const items: RemoteTaskRef[] = perType
        .flatMap(({ itemType, rows }) =>
          rows.map((r) => {
            // In cross-project mode scope can only be taken from the row: it is a number in the row and must be converted explicitly,
            // otherwise the detail page URL would be built with an empty segment such as `tapd_fe//story/...`.
            const scope = rowScope(r, q.scope ?? "");
            return toRef(r, itemType, ctx.siteBaseUrl, scope, undefined, statusMaps[`${scope}:${itemType}`]);
          }),
        )
        .filter((r) => r.externalId);
      const total = items.length;
      const start = (page - 1) * limit;
      return { items: items.slice(start, start + limit), total, hasMore: start + limit < total };
    }

    // Fetch each type concurrently and then merge: TAPD has no unified cross-type list API.
    const perType = await Promise.all(
      types.map(async (itemType) => {
        const args: Record<string, unknown> = { workspace_id: q.scope, limit, page };
        if (q.keyword) args[keywordField(itemType)] = q.keyword;
        // The handler field name differs by type: bug uses current_owner, story/task use owner.
        // Using the wrong one triggers the server error text "parameter X does not exist in the parameter definition of tool Y".
        if (q.owner) args[ownerField(itemType)] = q.owner;
        if (q.status) args["status"] = q.status;
        // Localized status (Chinese): only story supports it; other types are rejected by the server when it is sent (see mapper.supportsVStatus).
        if (supportsVStatus(itemType)) args["with_v_status"] = "1";
        // One call gets both the pagination envelope (total) and the data rows (data).
        const raw = await client.callRaw(toolFor(itemType), args);
        const rows = asRows(unwrapData(raw));
        return { itemType, rows, total: totalOf(raw, rows.length) };
      }),
    );

    // task / bug do not support with_v_status, so a separate Chinese status mapping table must be fetched.
    const statusMaps = await loadStatusLabelMaps(client, types, q.scope as string);

    const items: RemoteTaskRef[] = perType
      .flatMap(({ itemType, rows }) =>
        rows.map((r) =>
          toRef(r, itemType, ctx.siteBaseUrl, q.scope as string, undefined, statusMaps[itemType]),
        ),
      )
      .filter((r) => r.externalId);

    // Ordering follows the TAPD return order (server default is created desc; empirically consistent across all three kinds).
    //
    // Note: do **not** re-sort locally by updatedAt here. Pagination happens server-side and is based on created;
    // re-sorting locally by modified would cause pagination glitches such as "page 2 contains items newer than page 1".
    // When types are fetched concurrently, each returns limit rows, so after merging there are at most limit x number-of-types --
    // returning them directly would make the frontend show far more than PAGE_SIZE rows on a page (appearing as "one page shows everything"),
    // so after merging, truncate uniformly to limit to stay consistent with the page size.
    const paged = items.slice(0, limit);
    const total = perType.reduce((sum, t) => sum + t.total, 0);
    return { items: paged, total, hasMore: page * limit < total };
  },

  async fetchTask(
    ctx: TaskSourceContext,
    externalId: string,
    scope: string,
    itemType: string,
  ): Promise<RemoteTaskDetail> {
    if (!isItemType(itemType)) {
      throw new TaskSourceError("invalid_item_type", `unsupported TAPD item type: ${itemType}`);
    }
    const client = clientFor(ctx);
    // Only the detail API returns description (in list mode the field is null / missing).
    const raw = await client.call(toolFor(itemType), {
      workspace_id: scope,
      id: externalId,
    });
    const rows = asRows(raw);
    if (!rows.length) {
      throw new TaskSourceError("remote_task_not_found", `TAPD ${itemType} not found: ${externalId}`);
    }
    return toDetail(rows[0], itemType, ctx.siteBaseUrl, scope);
  },
};

function unwrapData(raw: unknown): unknown {
  return unwrap(raw);
}

function clampLimit(limit?: number): number {
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.floor(limit as number), 1), MAX_LIMIT);
}

/**
 * Fetch the Chinese status mapping table for each type (only needed for types that do not support with_v_status).
 *
 * `tapd_field_detail_get(object_type, field_names="status")` returns
 * `{ status: { options: { "new": "新", "in_progress": "接受/处理", ... } } }` (values are Chinese labels such as "New", "Accepted/In progress").
 * On failure it silently falls back to the English codes -- degraded status display should not block list queries.
 */
async function loadStatusLabelMaps(
  client: TapdMcpClient,
  types: readonly string[],
  scope: string,
): Promise<Record<string, Record<string, string>>> {
  const needed = types.filter((t) => !supportsVStatus(t));
  if (!needed.length) return {};
  const entries = await Promise.all(
    needed.map(async (itemType) => {
      try {
        const raw = await client.call("tapd_field_detail_get", {
          workspace_id: scope,
          object_type: itemType,
          field_names: "status",
        });
        const opts = (raw as { status?: { options?: Record<string, string> } })?.status?.options;
        return [itemType, opts && typeof opts === "object" ? opts : {}] as const;
      } catch {
        // If the mapping cannot be obtained, show the raw status code and do not block the query.
        return [itemType, {}] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}

/** Todo results grouped by "in-row workspace_id -> type", used for cross-project status mapping lookups. */
function rowsByScope(perType: Array<{ itemType: string; rows: Array<Record<string, unknown>> }>): Array<{
  scope: string;
  itemType: string;
}> {
  const seen = new Set<string>();
  const out: Array<{ scope: string; itemType: string }> = [];
  for (const { itemType, rows } of perType) {
    for (const r of rows) {
      const s = rowScope(r, "");
      if (!s) continue;
      const key = `${s}:${itemType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ scope: s, itemType });
    }
  }
  return out;
}

/**
 * Chinese status mapping for cross-project todos (queried grouped by project x type).
 *
 * Empirically: the todo API returns Chinese status directly **when workspace_id is specified**, but returns raw codes such as
 * `new` / `status_6` **when cross-project**. To keep both modes displaying consistently, here we additionally
 * call tapd_field_detail_get per in-row workspace.
 *
 * The number of projects is usually small (empirically 2-3), so queries are manageable; failures silently fall back to raw codes without blocking the list.
 */
async function loadTodoStatusMaps(
  client: TapdMcpClient,
  pairs: Array<{ scope: string; itemType: string }>,
): Promise<Record<string, Record<string, string>>> {
  const entries = await Promise.all(
    pairs.map(async ({ scope, itemType }) => {
      try {
        const raw = await client.call("tapd_field_detail_get", {
          workspace_id: scope,
          object_type: itemType,
          field_names: "status",
        });
        const opts = (raw as { status?: { options?: Record<string, string> } })?.status?.options;
        return [`${scope}:${itemType}`, opts && typeof opts === "object" ? opts : {}] as const;
      } catch {
        return [`${scope}:${itemType}`, {}] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
