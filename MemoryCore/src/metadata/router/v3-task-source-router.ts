/**
 * v3 Task external source routes (/v3/task-source/*, 5 endpoints).
 *
 * Corresponds to design doc §5.2. The dispatch pattern mirrors v3-meta-router:
 *   - POST only, prefix /v3/task-source
 *   - reuses the same x-tdai-user-key user auth
 *   - MetadataError / TaskSourceError → envelope code
 *
 * **Credential injection**: the user manually enters a token on the Panel (Taihu unified auth token / TAPD personal token),
 * the frontend submits it in the request body `credential` field, and the Panel thinly forwards it here.
 * Core **does not persist, log, or echo it back** — the token is single-use and no longer held once the request ends.
 */

import type * as http from "node:http";
import type { ZodType } from "zod";
import {
  successEnvelope,
  errorEnvelope,
  resolveRequestId,
} from "../../gateway/v2-router.js";
import { formatZodError, type ApiResponseEnvelope } from "../../gateway/v2-schemas.js";
import type { Logger } from "../../core/types.js";
import { MetadataService, MetadataError } from "../service/metadata-service.js";
import { authenticateV3, extractUserKeyHeader, type V3AuthContext } from "./auth.js";
import { extractInstanceId } from "./instance.js";
import * as S from "./v3-meta-schemas.js";
import {
  TaskSourceError,
  TaskSourceRegistry,
  type SourceCredential,
} from "../../task-source/index.js";
import { TaskSourceImportService } from "../../task-source/import-service.js";

export const V3_TASK_SOURCE_PREFIX = "/v3/task-source";
const TAG = "[TASK-SOURCE-V3]";

/**
 * Parse the user-submitted token from the request body.
 *
 * Two kinds are supported (hitting the same endpoint, only the header name differs):
 *   - bearer: Taihu unified auth token
 *   - custom: TAPD personal token (via the header specified in extra.header)
 * The token only exists in memory for this request; it is not persisted or logged.
 */
function parseCredential(body: unknown): SourceCredential | null {
  if (!body || typeof body !== "object") return null;
  const cred = (body as { credential?: unknown }).credential;
  if (!cred || typeof cred !== "object") return null;
  const { kind, secret, extra } = cred as {
    kind?: unknown;
    secret?: unknown;
    extra?: unknown;
  };
  if (typeof secret !== "string" || !secret.trim()) return null;
  if (kind !== "bearer" && kind !== "custom" && kind !== "basic") return null;
  return {
    kind,
    secret: secret.trim(),
    extra: extra && typeof extra === "object" ? (extra as Record<string, unknown>) : undefined,
  };
}

export interface V3TaskSourceRouterDeps {
  getMetadataService: (
    instanceId: string,
  ) => MetadataService | undefined | Promise<MetadataService | undefined>;
  logger: Logger;
}

type Ctx = V3AuthContext;
type Handler = (
  body: unknown,
  ctx: Ctx,
  svc: MetadataService,
  requestId: string,
  cred: SourceCredential,
) => Promise<ApiResponseEnvelope>;

function bind<S2 extends ZodType>(
  schema: S2,
  fn: (
    data: S2["_output"],
    ctx: Ctx,
    svc: MetadataService,
    cred: SourceCredential,
  ) => Promise<unknown>,
): Handler {
  return async (body, ctx, svc, requestId, cred) => {
    const parsed = schema.safeParse(body);
    if (!parsed.success) return errorEnvelope(400, formatZodError(parsed.error), requestId);
    const data = await fn(parsed.data as S2["_output"], ctx, svc, cred);
    return successEnvelope(data, requestId);
  };
}

function serviceFor(svc: MetadataService): TaskSourceImportService {
  return new TaskSourceImportService(svc);
}

const routeTable: Record<string, Handler> = {
  [`${V3_TASK_SOURCE_PREFIX}/providers`]: bind(S.taskSourceProvidersSchema, async (d, c, s) => {
    // Gate: the caller must be an active member of that team.
    await s.assertExternalTaskImportAllowed(d.team_id, c);
    return { providers: TaskSourceRegistry.list() };
  }),

  [`${V3_TASK_SOURCE_PREFIX}/workspaces`]: bind(S.taskSourceWorkspacesSchema, async (d, c, s) => {
    await s.assertExternalTaskImportAllowed(d.team_id, c);
    const provider = TaskSourceRegistry.get(d.provider_id);
    const tctx = TaskSourceRegistry.contextFor(d.provider_id, d.credential);
    return { workspaces: await provider.listWorkspaces(tctx) };
  }),

  [`${V3_TASK_SOURCE_PREFIX}/candidates`]: bind(S.taskSourceCandidatesSchema, async (d, c, s) => {
    await s.assertExternalTaskImportAllowed(d.team_id, c);
    const provider = TaskSourceRegistry.get(d.provider_id);
    const tctx = TaskSourceRegistry.contextFor(d.provider_id, d.credential);
    const page = await provider.listCandidates(tctx, {
      scope: d.workspace_id,
      itemTypes: d.item_types,
      keyword: d.keyword,
      owner: d.owner,
      status: d.status,
      page: d.page,
      limit: d.limit,
      onlyTodo: d.only_todo,
    });
    // Internal RemoteTaskRef uses camelCase, but the v3 API is uniformly snake_case externally
    // (consistent with other meta endpoints, and the frontend reads snake_case).
    return {
      items: page.items.map((it) => ({
        external_id: it.externalId,
        item_type: it.itemType,
        title: it.title,
        url: it.url,
        status: it.status,
        updated_at: it.updatedAt,
        scope: it.scope,
      })),
      total: page.total,
      has_more: page.hasMore,
    };
  }),

  [`${V3_TASK_SOURCE_PREFIX}/import`]: bind(S.taskSourceImportSchema, async (d, c, s) => {
    return serviceFor(s).import(
      d.provider_id,
      d.team_id,
      d.items.map((i) => ({ external_id: i.external_id, item_type: i.item_type, scope: i.scope ?? "" })),
      d.credential,
      c,
    );
  }),

};

/** Registered route paths (for tests / docs). */
export const V3_TASK_SOURCE_ROUTES = Object.keys(routeTable);

function mapTaskSourceError(err: TaskSourceError): number {
  switch (err.code) {
    case "task_source_unauthorized":
      return 401;
    case "task_source_not_found":
    case "remote_task_not_found":
      return 404;
    case "task_source_timeout":
      return 504;
    case "task_source_config_missing":
      return 500;
    default:
      return 400;
  }
}

function mapErrorCode(code: string): number {
  if (code.endsWith("_not_found")) return 404;
  if (code === "permission_denied") return 403;
  return 400;
}

export async function handleV3TaskSourceRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
  parseJsonBody: <T>(req: http.IncomingMessage) => Promise<T>,
  sendJson: (res: http.ServerResponse, status: number, body: unknown) => void,
  deps: V3TaskSourceRouterDeps,
): Promise<boolean> {
  if (!pathname.startsWith(V3_TASK_SOURCE_PREFIX) || method !== "POST") return false;
  const handler = routeTable[pathname];
  if (!handler) return false;

  const requestId = resolveRequestId(req.headers as Record<string, string | string[] | undefined>);

  let instanceId: string;
  try {
    instanceId = extractInstanceId(req.headers);
  } catch (err) {
    const code = err instanceof MetadataError ? mapErrorCode(err.code) : 400;
    sendJson(res, code, errorEnvelope(code, err instanceof Error ? err.message : "bad request", requestId));
    return true;
  }

  const svc = await Promise.resolve(deps.getMetadataService(instanceId));
  if (!svc) {
    sendJson(res, 503, errorEnvelope(503, "MetadataService not available", requestId));
    return true;
  }

  const headerUserKey = extractUserKeyHeader(req.headers);
  if (!headerUserKey) {
    sendJson(res, 401, errorEnvelope(401, "unauthorized: missing_user_key", requestId));
    return true;
  }
  const auth = await authenticateV3(headerUserKey, svc);
  if (!auth.ok || !auth.ctx) {
    const status = auth.status ?? 401;
    sendJson(res, status, errorEnvelope(status, `unauthorized: ${auth.reason}`, requestId));
    return true;
  }

  const body = await parseJsonBody(req);
  // providers does not need a token (it only lists enabled sources); all other endpoints must have one.
  const needsCred = pathname !== `${V3_TASK_SOURCE_PREFIX}/providers`;
  const cred = parseCredential(body);
  if (needsCred && !cred) {
    sendJson(res, 400, errorEnvelope(400, "missing_credential", requestId));
    return true;
  }

  try {
    // The providers branch does not need a token; an empty placeholder is enough (the provider side will not use it).
    const effective = cred ?? { kind: "bearer" as const, secret: "" };
    const envelope = await handler(body, auth.ctx, svc, requestId, effective);
    // envelope.code is a business code (0 on success) and cannot be used directly as an HTTP status code —
    // sending it directly would hit `Invalid status code: 0`. Same mapping rule as v3-meta-router.
    const httpStatus =
      envelope.code === 0
        ? 200
        : envelope.code >= 400 && envelope.code < 600
          ? envelope.code
          : 200;
    sendJson(res, httpStatus, envelope);
    return true;
  } catch (err) {
    if (err instanceof TaskSourceError) {
      const code = mapTaskSourceError(err);
      deps.logger.warn(`${TAG} ${err.code}: ${err.message}`);
      // Log only code and message, never the token.
      sendJson(res, code, errorEnvelope(code, `${err.code}: ${err.message}`, requestId));
      return true;
    }
    if (err instanceof MetadataError) {
      const code = mapErrorCode(err.code);
      sendJson(res, code, errorEnvelope(code, `${err.code}: ${err.message}`, requestId));
      return true;
    }
    deps.logger.error(`${TAG} unhandled error: ${err instanceof Error ? err.message : String(err)}`);
    sendJson(res, 500, errorEnvelope(500, "internal error", requestId));
    return true;
  }
}
