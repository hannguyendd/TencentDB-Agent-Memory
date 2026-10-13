/**
 * Auto-Sync Admin Routes — scheduler status query + manual trigger.
 *
 * Endpoints:
 *   GET  /auto-sync/status   → current scheduler state (running/activeSyncs/scanning) + config
 *   POST /auto-sync/trigger  → manually trigger one full scan (fire-and-forget, returns immediately)
 *
 * Routes are mounted without a prefix; server.ts adds /v3 uniformly.
 */

import { Hono } from "hono";
import type { AutoSyncScheduler, AutoSyncConfig } from "../store/auto-sync-scheduler.js";
import { wrapOk } from "../api-helpers.js";

export interface AutoSyncRouteDeps {
  scheduler: AutoSyncScheduler;
  config: AutoSyncConfig;
}

export function createAutoSyncRoutes(deps: AutoSyncRouteDeps) {
  const app = new Hono();
  const { scheduler, config } = deps;

  // GET /auto-sync/status — view scheduler run state + config
  app.get("/auto-sync/status", (c) => {
    const status = scheduler.getStatus();
    return c.json(wrapOk({
      ...status,
      config: {
        enabled: config.enabled,
        scanIntervalMs: config.scanIntervalMs,
        maxConcurrentSyncs: config.maxConcurrentSyncs,
      },
    }));
  });

  // POST /auto-sync/trigger — manually trigger one scan (fire-and-forget)
  app.post("/auto-sync/trigger", (c) => {
    if (!config.enabled) {
      return c.json(wrapOk({ triggered: false, reason: "auto-sync is disabled by KNOWLEDGE_AUTO_SYNC_ENABLED" }));
    }
    scheduler.triggerScan();
    return c.json(wrapOk({ triggered: true }));
  });

  return app;
}
