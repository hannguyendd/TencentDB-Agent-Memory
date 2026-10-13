/**
 * Knowledge Panel route aggregation and registration.
 *
 * Mounts:
 *   - /api/v1/knowledge/wiki/*        （wiki-routes）
 *   - /api/v1/knowledge/code-graph/*  （code-graph-routes）
 *   - /api/v1/knowledge/status-callback（callback-routes，S2S）
 *   - /api/v1/knowledge/allocate etc.    (allocate-routes)
 *   - /api/v1/knowledge/{type}/team-assets （list-routes）
 *   - /api/v1/knowledge/source/*           (source-routes, thin forwarding of external sources / credentials)
 */
import type { Hono } from 'hono';
import type { PanelDeps } from '../../../panel-deps.js';
import { registerKnowledgeWikiRoutes } from './wiki-routes.js';
import { registerKnowledgeCodeGraphRoutes } from './code-graph-routes.js';
import { registerKnowledgeCallbackRoutes } from './callback-routes.js';
import { registerKnowledgeAllocateRoutes } from './allocate-routes.js';
import { registerKnowledgeListRoutes } from './list-routes.js';
import { registerKnowledgeSourceRoutes } from './source-routes.js';

export function registerKnowledgeRoutes(api: Hono, deps: PanelDeps): void {
  registerKnowledgeWikiRoutes(api, deps);
  registerKnowledgeCodeGraphRoutes(api, deps);
  registerKnowledgeCallbackRoutes(api, deps);
  registerKnowledgeAllocateRoutes(api, deps);
  registerKnowledgeListRoutes(api, deps);
  registerKnowledgeSourceRoutes(api, deps);
}
