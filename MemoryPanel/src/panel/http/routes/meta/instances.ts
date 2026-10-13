import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';

export function registerHealthRoutes(app: Hono): void {
  app.get('/health', (c) => c.json({ status: 'ok' }));
}

export function registerMetaInstanceRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/meta/instances', (c) => {
    return c.json({
      instances: deps.instanceRegistry.listPublic(),
      // Panel-level capability switches are sent along with the instance list (no new endpoint):
      // whether the "Observability" entry is open is controlled by the deployer via PANEL_FEATURE_ANALYTICS_ENABLED,
      // off by default; once on, the frontend combines it with the CH probe result of /api/v1/analytics/config
      // to decide whether the menu/route is finally visible.
      capabilities: { analyticsEnabled: deps.config.featureAnalyticsEnabled },
    });
  });
}
