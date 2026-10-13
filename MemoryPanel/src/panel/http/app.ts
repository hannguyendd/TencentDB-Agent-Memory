import path from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { requestLogger } from './middleware/request-logger.js';
import { apiCallTelemetryMiddleware } from './middleware/api-call-telemetry-middleware.js';
import type { PanelDeps } from '../panel-deps.js';
import { registerHealthRoutes, registerMetaInstanceRoutes } from './routes/meta/instances.js';
import { registerMetaProxyRoutes } from './routes/meta/proxy.js';
import { registerSkillProxyRoutes } from './routes/skill/proxy.js';
import { registerAnalyticsProxyRoutes } from './routes/analytics/proxy.js';
import { registerChatMemoryRoutes } from './routes/chat-memory.js';
import { registerTaskRoutes } from './routes/task.js';
import { registerTaskSourceRoutes } from './routes/task-source.js';
import { registerAgentOverviewRoutes } from './routes/agent-overview.js';
import { registerAgentLifecycleRoutes } from './routes/agent-lifecycle.js';
import { registerKnowledgeRoutes } from './routes/knowledge/index.js';
import { registerAuthRoutes, registerWoaIngressRoutes } from './routes/auth.js';

const API_PREFIX = '/api/v1';

export function buildPanelApp(deps: PanelDeps): Hono {
  const app = new Hono();

  app.use('*', requestLogger(deps.logger));

  registerHealthRoutes(app);

  const api = new Hono();
  // API call audit (optional ClickHouse reporting; NoOp if not configured)
  // user_id collection has three fallback levels: route.set('resolvedUserId') > userIdResolver cache > empty
  api.use('*', apiCallTelemetryMiddleware(deps.apiCallTelemetry, deps.userIdResolver));
  registerMetaInstanceRoutes(api, deps);
  registerAuthRoutes(api, deps);
  registerMetaProxyRoutes(api, deps);
  // Skill data-plane transparent proxy: /api/v1/skill/* -> kernel /v3/skill/*
  registerSkillProxyRoutes(api, deps);
  // Analytics query-plane transparent proxy: /api/v1/analytics/* -> kernel /v3/analytics/*
  registerAnalyticsProxyRoutes(api, deps);
  // Dedicated business routes for the Chat Memory panel's 3 tabs (12.3 decision exception; see the top comment of chat-memory.ts)
  registerChatMemoryRoutes(api, deps);
  // Task aggregation route: task/list + batched task-agent/list returned in one response
  registerTaskRoutes(api, deps);
  // External task source: /api/v1/task/source/* -> kernel /v3/task-source/* (token is sent in the request body and not retained)
  registerTaskSourceRoutes(api, deps);
  registerAgentOverviewRoutes(api, deps);
  // Agent lifecycle business route: /agent/delete-cascade cascades skill cleanup at the control layer, then archives
  registerAgentLifecycleRoutes(api, deps);
  registerKnowledgeRoutes(api, deps);
  app.route(API_PREFIX, api);
  // Mount the ingress middleware only when at least one header-injected Provider is registered:
  // that middleware intercepts requests that are "GET on the root path + match any Provider's ingressHeaderName"
  // and completes IdP login automatically. When not enabled it is not registered, so header-bearing requests forwarded by the upstream gateway fall through to static assets unchanged,
  // avoiding being "hijacked by the IdP flow even though no IdP is enabled".
  // Double optional chaining: existing test fixtures only supply the fields the route under test needs, and `deps.auth`
  // and `deps.config.auth` are often omitted entirely; a missing layer at either level counts as IdP not enabled, consistent with the v1-era
  // `deps.config.auth?.woa?.enabled` compatibility semantics.
  if (deps.auth?.listHeaderInjectedProviders?.().length) {
    registerWoaIngressRoutes(app, deps);
  }

  app.onError((err, c) => {
    deps.logger.error('panel unhandled error', {
      err: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json(
      { code: 500, message: 'INTERNAL', request_id: c.get('reqId') ?? '', data: null },
      500,
    );
  });

  const distDir = deps.config.ui.distDir;
  app.use('/*', serveStatic({ root: distDir }));
  app.get('*', (c, next) => {
    const p = c.req.path;
    if (p.startsWith('/api/') || p === '/health') return next();
    return serveStatic({ path: path.join(distDir, 'index.html') })(c, next);
  });

  return app;
}
