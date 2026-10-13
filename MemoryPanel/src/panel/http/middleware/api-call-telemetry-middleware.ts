/**
 * API call audit middleware -- after await next(), collects request info and writes it to ClickHouse.
 *
 * Only applies to requests that passed validatePanelMetaHeaders (have panelMeta);
 * requests that do not go through API routes, such as static assets and /health, are naturally skipped.
 *
 * ## user_id instrumentation strategy (three-level fallback)
 *   1. `c.set('resolvedUserId', ...)` in the route handler -> used first
 *   2. middleware-level `userIdResolver.get(userKey, ctx)` -> taken on cache hit
 *   3. neither -> empty string. A miss fires auth/verify fire-and-forget,
 *      so the next request with the same user_key can get it
 */
import { createMiddleware } from 'hono/factory';
import type { PanelApiCallTelemetry } from '../../infra/api-call-telemetry.js';
import { formatClickHouseTimestamp } from '../../infra/api-call-telemetry.js';
import type { PanelUserIdResolver } from '../../infra/user-id-resolver.js';

declare module 'hono' {
  interface ContextVariableMap {
    /** Set after resolveCallerUserId succeeds in a route handler; the audit middleware reads it first. */
    resolvedUserId?: string;
  }
}

/**
 * Registered on the api sub-app: `api.use('*', apiCallTelemetryMiddleware(deps.apiCallTelemetry, deps.userIdResolver))`
 */
export function apiCallTelemetryMiddleware(
  telemetry: PanelApiCallTelemetry,
  userIdResolver: PanelUserIdResolver,
) {
  return createMiddleware(async (c, next) => {
    const start = Date.now();
    await next();

    // Only record requests that passed validatePanelMetaHeaders
    const panelMeta = c.get('panelMeta');
    if (!panelMeta) return;

    // Three-level fallback for user_id: explicit route set > resolver cache > empty
    let userId = c.get('resolvedUserId') ?? '';
    if (!userId && panelMeta.userKey) {
      userId = userIdResolver.get(panelMeta.userKey, {
        instanceId: panelMeta.instanceId,
        gatewayEndpoint: panelMeta.gatewayEndpoint,
        gatewayApiKey: panelMeta.gatewayApiKey,
        reqId: c.get('reqId'),
      }) ?? '';
    }

    telemetry.record({
      timestamp: formatClickHouseTimestamp(new Date()),
      instance_id: panelMeta.instanceId ?? '',
      user_key: panelMeta.userKey ?? '',
      user_id: userId,
      endpoint: c.req.path,
      http_method: c.req.method,
      http_status: c.res.status,
      duration_ms: Date.now() - start,
      request_id: c.get('reqId') ?? '',
      host: process.env.HOSTNAME ?? '',
    });
  });
}
