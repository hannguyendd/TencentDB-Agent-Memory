/**
 * wiki-source routes — list documents / import for external wikis.
 *
 * **Only fetches and writes to disk; does not trigger ingest** (doc §3.1 step ⑦):
 * external import and manual upload share the same Ingest entry; the only difference is the file source.
 *
 * Authentication is injected by KS: credentials are taken from credentialStore by wiki_id,
 * assembled into a SourceContext and passed to the provider; the provider does not read the DB itself.
 */

import { Hono } from "hono";

import { wrapOk, wrapError, isValidIdSegment } from "../api-helpers.js";
import type { ICredentialStore } from "../source-auth/types.js";
import type { WikiSourceRegistry } from "./registry.js";
import type { WikiServiceLike } from "./import-runner.js";
import { runImport } from "./import-runner.js";

export interface WikiSourceRouteDeps {
  registry: WikiSourceRegistry;
  credentialStore: ICredentialStore;
  wikiService: WikiServiceLike;
}

interface Actor {
  serviceId: string;
  teamId: string;
  userId: string;
}

function actor(c: { req: { header(name: string): string | undefined } }): Actor | null {
  const serviceId = c.req.header("x-tdai-service-id");
  const teamId = c.req.header("x-tdai-team-id");
  const userId = c.req.header("x-tdai-user-id");
  if (!isValidIdSegment(serviceId) || !isValidIdSegment(teamId) || !isValidIdSegment(userId)) {
    return null;
  }
  return { serviceId: serviceId as string, teamId: teamId as string, userId: userId as string };
}

export function createWikiSourceRoutes(deps: WikiSourceRouteDeps): Hono {
  const app = new Hono();

  /**
   * POST /list — resolveRoot + listPages, returns a selectable node tree (flat).
   *
   * body: { wiki_id, source_url, provider_id, crawl?: { mode?, maxDepth? } }
   * crawl omitted → use the provider's defaultCrawlMode.
   */
  app.post("/list", async (c) => {
    const a = actor(c);
    if (!a) return c.json(wrapError(401, "missing or invalid identity headers"));

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(wrapError(400, "invalid JSON body"));
    }

    const wikiId = typeof body.wiki_id === "string" ? body.wiki_id : "";
    const sourceUrl = typeof body.source_url === "string" ? body.source_url : "";
    const providerId = typeof body.provider_id === "string" ? body.provider_id : "";
    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"));
    if (!sourceUrl) return c.json(wrapError(400, "source_url is required"));
    if (!providerId) return c.json(wrapError(400, "provider_id is required"));

    // Traversal strategy (optional): mode accepts only tree/links; maxDepth must be an integer ≥1 (only meaningful for links)
    let crawl: { mode?: "tree" | "links"; maxDepth?: number } | undefined;
    if (body.crawl && typeof body.crawl === "object") {
      const raw = body.crawl as Record<string, unknown>;
      const mode = raw.mode;
      if (mode !== undefined && mode !== "tree" && mode !== "links") {
        return c.json(wrapError(400, "crawl.mode must be 'tree' or 'links'"));
      }
      const maxDepth = raw.maxDepth;
      if (maxDepth !== undefined) {
        if (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1) {
          return c.json(wrapError(400, "crawl.maxDepth must be an integer >= 1"));
        }
      }
      crawl = {
        ...(mode ? { mode } : {}),
        ...(typeof maxDepth === "number" ? { maxDepth } : {}),
      };
    }

    // Credentials are taken by wiki_id; missing → 401 NEED_CREDENTIAL (the frontend pops up the fill-in page)
    const ref = { type: "wiki" as const, serviceId: a.serviceId, resourceId: wikiId };
    const cred = deps.credentialStore.get(ref);
    if (!cred) {
      return c.json(wrapError(401, "NEED_CREDENTIAL: no credential for this wiki"));
    }
    const status = deps.credentialStore.status(ref);

    try {
      const { provider, ctx } = deps.registry.contextFor(
        status?.provider_id ?? providerId,
        cred.secret,
        cred.username,
      );
      const root = await provider.resolveRoot(ctx, sourceUrl);
      const pages = await provider.listPages(ctx, root, crawl);
      return c.json(
        wrapOk({
          root,
          pages,
          // Directory nodes cannot be downloaded; the frontend greys them out accordingly
          importable: pages.filter((p) => !p.isDir).length,
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(502, `list failed: ${msg}`));
    }
  });

  /**
   * POST /import — fetch + write to disk (background semantics: runs synchronously to completion here before returning).
   *
   * body: { wiki_id, source_url, provider_id, page_ids? }
   *   page_ids omitted → import all non-directory nodes
   */
  app.post("/import", async (c) => {
    const a = actor(c);
    if (!a) return c.json(wrapError(401, "missing or invalid identity headers"));

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json(wrapError(400, "invalid JSON body"));
    }

    const wikiId = typeof body.wiki_id === "string" ? body.wiki_id : "";
    const sourceUrl = typeof body.source_url === "string" ? body.source_url : "";
    const providerId = typeof body.provider_id === "string" ? body.provider_id : "";
    const pageIds = Array.isArray(body.page_ids)
      ? (body.page_ids as unknown[]).filter((x): x is string => typeof x === "string")
      : undefined;

    if (!isValidIdSegment(wikiId)) return c.json(wrapError(400, "wiki_id is required"));
    if (!sourceUrl) return c.json(wrapError(400, "source_url is required"));
    if (!providerId) return c.json(wrapError(400, "provider_id is required"));

    const ref = { type: "wiki" as const, serviceId: a.serviceId, resourceId: wikiId };
    const cred = deps.credentialStore.get(ref);
    if (!cred) {
      return c.json(wrapError(401, "NEED_CREDENTIAL: no credential for this wiki"));
    }
    const status = deps.credentialStore.status(ref);

    try {
      const result = await runImport({
        registry: deps.registry,
        wikiService: deps.wikiService,
        providerId: status?.provider_id ?? providerId,
        secret: cred.secret,
        username: cred.username,
        serviceId: a.serviceId,
        teamId: a.teamId,
        wikiId,
        sourceUrl,
        pageIds,
      });
      return c.json(wrapOk(result));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json(wrapError(502, `import failed: ${msg}`));
    }
  });

  return app;
}
