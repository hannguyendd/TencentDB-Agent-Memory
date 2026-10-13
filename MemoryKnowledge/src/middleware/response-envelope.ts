/**
 * Response envelope middleware — adds access logging + request_id tracking.
 *
 * All responses are wrapped in ApiResponseEnvelope by route handlers directly
 * (via wrapOk / wrapError). This middleware handles access logging and
 * generates a request_id header if not provided.
 */

import type { MiddlewareHandler } from "hono";
import { createLogger } from "../logger.js";

const log = createLogger("http");

const MAX_BODY_LOG = 500;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max) + `…[+${s.length - max}]`;
}

/** Extract key fields of the request body (avoid logging everything; log only ID-like fields for correlation). */
function pickReqFields(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of ['wiki_id', 'code_graph_id', 'knowledge_id', 'wiki_ids', 'code_graph_ids', 'knowledge_ids', 'team_id', 'repo_url', 'branch', 'filename', 'filenames', 'refs', 'tool_name', 'query', 'path']) {
    if (k in b) out[k] = b[k];
  }
  return out;
}

export function accessLog(): MiddlewareHandler {
  return async (c, next) => {
    const t0 = Date.now();
    const route = `${c.req.method} ${c.req.path}`;

    // Generate request_id if not provided
    const requestId = c.req.header("x-request-id") || crypto.randomUUID();
    c.set("requestId", requestId);

    // Cache the request body (the body can only be read once; used for logging on failure)
    // Hono's bodyCache expects a Promise (c.req.json()/text() call .then() on the cached value)
    let reqBody: unknown = undefined;
    if (c.req.method === 'POST' || c.req.method === 'PUT') {
      try {
        const raw = await c.req.text();
        reqBody = raw ? JSON.parse(raw) : undefined;
        c.req.bodyCache.text = Promise.resolve(raw);
        if (reqBody) c.req.bodyCache.json = Promise.resolve(reqBody);
      } catch {
        // Not a JSON body, ignore
      }
    }

    await next();

    const ms = Date.now() - t0;
    const status = c.res.status;
    log.info(`${route} → ${status} (${ms}ms)`);

    if (status >= 400) {
      // On failure log key request fields + response body (truncated)
      const fields = pickReqFields(reqBody);
      const logExtra: Record<string, unknown> = { status, ...fields };

      try {
        const respText = await c.res.text();
        logExtra.responseBody = truncate(respText, MAX_BODY_LOG);
        // Rebuild the response (text() consumed the body)
        c.res = new Response(respText, {
          status: c.res.status,
          headers: c.res.headers,
        });
      } catch {
        // If the response body can't be read, so be it
      }

      log.warn(`${route} error`, logExtra);
    }
  };
}
