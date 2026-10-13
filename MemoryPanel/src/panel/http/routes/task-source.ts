/**
 * /api/v1/task/source/* -- Task external sources (Import Task).
 *
 * Panel responsibility boundary (corresponding to design doc §5.1 / §5.3):
 *   - **Thin forwarding**: all business logic is in Core (/v3/task-source/*); Panel holds no business logic.
 *   - **Token pass-through**: the token the user enters in the UI (Taihu unified auth token / TAPD personal token)
 *     is submitted in the request body `credential` field, and Panel forwards it to Core as-is.
 *     Panel **does not persist, cache, or log it**; it is no longer held once the request ends.
 */

import type { Context, Hono } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import type { MetaCallContext } from '../../kernel/types.js';
import { validatePanelMetaHeaders } from '../middleware/validate-panel-headers.js';
import { respondEnvelope, respondControlError } from '../envelope.js';

function buildCtx(c: Context): MetaCallContext {
  const panelMeta = c.get('panelMeta');
  return {
    instanceId: panelMeta.instanceId,
    gatewayEndpoint: panelMeta.gatewayEndpoint,
    gatewayApiKey: panelMeta.gatewayApiKey,
    userKey: panelMeta.userKey,
    reqId: c.get('reqId'),
  };
}

/** Shape of the token submitted by the user. Only minimal validation; no processing, no persistence. */
interface CredentialBody {
  kind: 'bearer' | 'basic' | 'custom';
  secret: string;
  username?: string;
  extra?: Record<string, unknown>;
}

function isCredential(v: unknown): v is CredentialBody {
  if (!v || typeof v !== 'object') return false;
  const c = v as Partial<CredentialBody>;
  return (
    typeof c.secret === 'string' &&
    c.secret.trim().length > 0 &&
    (c.kind === 'bearer' || c.kind === 'basic' || c.kind === 'custom')
  );
}

export function registerTaskSourceRoutes(api: Hono, deps: PanelDeps): void {
  /**
   * providers does not need a token (it only lists enabled sources and auth methods),
   * and the frontend renders the token input box accordingly.
   */
  api.post('/task/source/providers', validatePanelMetaHeaders(deps), async (c: Context) => {
    const body = await c.req.json<Record<string, unknown>>().catch((): Record<string, unknown> => ({}));
    const env = await deps.taskSourceKernel.invoke('providers', body, buildCtx(c));
    return respondEnvelope(c, env);
  });

  /**
   * Forwarding that requires a token (workspaces / candidates / import).
   *
   * The token is entered by the user in the UI and submitted in the request body; missing -> 400, and we do not call Core with an empty token.
   */
  const withCredential = (action: string) =>
    api.post(`/task/source/${action}`, validatePanelMetaHeaders(deps), async (c: Context) => {
      const body = await c.req
        .json<Record<string, unknown> & { credential?: unknown }>()
        .catch((): Record<string, unknown> & { credential?: unknown } => ({}));
      if (!isCredential(body.credential)) {
        return respondControlError(c, 400, 'MISSING_CREDENTIAL');
      }
      const env = await deps.taskSourceKernel.invoke(
        action,
        body as Record<string, unknown>,
        buildCtx(c),
      );
      return respondEnvelope(c, env);
    });

  withCredential('workspaces');
  withCredential('candidates');
  withCredential('import');
}
