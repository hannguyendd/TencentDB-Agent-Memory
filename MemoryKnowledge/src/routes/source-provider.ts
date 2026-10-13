/**
 * source-provider routes — list of enabled external sources (reads deployment config).
 *
 * Panel's frontend renders dropdowns from this, with no duplicate config on the Panel side (KS is the single source of truth).
 */

import { Hono } from "hono";

import { wrapOk } from "../api-helpers.js";
import { CodeSourceRegistry } from "../code-source/registry.js";
import { WikiSourceRegistry } from "../wiki-source/registry.js";

export interface SourceProviderRouteDeps {
  registry?: CodeSourceRegistry;
  wikiRegistry?: WikiSourceRegistry;
}

export function createSourceProviderRoutes(deps: SourceProviderRouteDeps = {}): Hono {
  const app = new Hono();
  const registry = deps.registry ?? new CodeSourceRegistry();
  const wikiRegistry = deps.wikiRegistry ?? new WikiSourceRegistry();

  // GET /code — codegraph sources (gongfeng / github / gitlab ...)
  app.get("/code", (c) => c.json(wrapOk({ items: registry.list() })));

  // GET /wiki — wiki sources (iwiki ...)
  app.get("/wiki", (c) => c.json(wrapOk({ items: wikiRegistry.list() })));

  // GET / — aggregate all types
  app.get("/", (c) =>
    c.json(wrapOk({ code: registry.list(), wiki: wikiRegistry.list() })),
  );

  return app;
}
