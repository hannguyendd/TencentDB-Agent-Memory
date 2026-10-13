import type { Hono } from 'hono';
import { isAllowedSkillAction } from '../../../api/skill-actions.js';
import type { PanelDeps } from '../../../panel-deps.js';
import { validatePanelMetaHeaders } from '../../middleware/validate-panel-headers.js';
import { respondControlError, respondEnvelope } from '../../envelope.js';
import type { MetaCallContext } from '../../../kernel/types.js';

/**
 * Parse the skill action from the request path.
 * A skill action may have a sub-path (files/write, files/remove, files/read),
 * so take all segments after `/skill/`.
 */
function readAction(path: string): string {
  const marker = '/skill/';
  const idx = path.indexOf(marker);
  if (idx < 0) return '';
  return path.slice(idx + marker.length);
}

/**
 * Register the skill data-plane transparent proxy: POST /api/v1/skill/{action} -> kernel POST /v3/skill/{action}.
 *
 * Reuses validatePanelMetaHeaders: for /skill/* paths readAction returns '' (not auth/verify),
 * so X-Tdai-User-Key is mandatorily required, consistent with the semantics that skill requires owner identity.
 */
export function registerSkillProxyRoutes(api: Hono, deps: PanelDeps): void {
  api.post('/skill/*', validatePanelMetaHeaders(deps), async (c) => {
    const action = readAction(c.req.path);
    if (!action || !isAllowedSkillAction(action)) {
      return respondControlError(c, 404, 'UNKNOWN_SKILL_ACTION');
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const panelMeta = c.get('panelMeta');
    const ctx: MetaCallContext = {
      instanceId: panelMeta.instanceId,
      gatewayEndpoint: panelMeta.gatewayEndpoint,
      gatewayApiKey: panelMeta.gatewayApiKey,
      userKey: panelMeta.userKey,
      reqId: c.get('reqId'),
    };

    const envelope = await deps.skillKernel.invoke(action, body, ctx);
    return respondEnvelope(c, envelope);
  });
}
