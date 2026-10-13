import type { Context, Hono } from 'hono';
import {
  isAllowedAnalyticsAction,
  isAnalyticsGetAction,
} from '../../../api/analytics-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';

/**
 * Parse the analytics action from the request path.
 * An action may have a sub-path (session-init/summary, tool-calls/list, usage-raw/list, etc.),
 * so take all segments after `/analytics/`.
 */
function readAction(path: string): string {
  const marker = '/analytics/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

/**
 * Register the analytics query-plane transparent proxy:
 *   GET  /api/v1/analytics/{config|spaces} -> kernel GET  /v3/analytics/{action}
 *   POST /api/v1/analytics/{action}        -> kernel POST /v3/analytics/{action}
 *
 * Key points:
 *   - The frontend cannot connect to the kernel directly -- analytics requires a Bearer (gateway api_key), and that key exists only in
 *     the Panel backend's instance registry and must never enter the browser bundle. So this proxy must inject it.
 *   - The method must match the kernel's declaration: config / spaces are GET, the rest are POST, otherwise the kernel returns 405.
 *   - Permission (system_admin) and CH availability (503) are both decided by the kernel and passed through as-is; Panel does not pre-judge.
 */
export function registerAnalyticsProxyRoutes(api: Hono, deps: PanelDeps): void {
  const handler = async (c: Context) => {
    const action = readAction(c.req.path);
    if (!action || !isAllowedAnalyticsAction(action)) {
      return respondControlError(c, 404, 'UNKNOWN_ANALYTICS_ACTION');
    }
    // Reject directly when the method disagrees with the kernel's declaration, to avoid throwing a 405 at the user
    const wantGet = isAnalyticsGetAction(action);
    const isGet = c.req.method.toUpperCase() === 'GET';
    if (wantGet !== isGet) {
      return respondControlError(c, 405, 'METHOD_NOT_ALLOWED');
    }

    let body: Record<string, unknown> = {};
    if (!isGet) {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    }

    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };

    const envelope = await deps.analyticsKernel.invoke(action, body, ctx);
    return respondEnvelope(c, envelope);
  };

  api.get('/analytics/*', validatePanelMetaHeaders(deps), handler);
  api.post('/analytics/*', validatePanelMetaHeaders(deps), handler);
}
