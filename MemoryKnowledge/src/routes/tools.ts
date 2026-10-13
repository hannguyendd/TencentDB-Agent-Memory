/**
 * Tools Routes — Agent self-discovery HTTP endpoints.
 *
 * Two endpoints for the v7 progressive-exposure pattern:
 *   POST /tools/list — discover available tools for a knowledge resource
 *   POST /tools/call — execute a tool on a knowledge resource
 *
 * Tools are defined per resource type (wiki / code-graph). Management operations
 * (create/delete/ingest/sync) are NOT exposed — only read-only query tools.
 *
 * Routes are defined WITHOUT /v3 prefix — prefix applied at server.ts mount level.
 */

import { Hono } from "hono";

import type { WikiService, CodeGraphService } from "../store/index.js";
import type { CodeGraphInstancePool } from "../module.js";
import type { WikiSourceManager } from "../engines/wiki/index.js";
import { executeTool as executeCodeTool } from "../engines/code/index.js";
import { wrapOk, wrapError, isValidIdSegment } from "../api-helpers.js";
import { isWikiId, isCodeGraphId } from "../store/ids.js";

export interface ToolsRouteDeps {
  wikiService: WikiService;
  wikiMgr: WikiSourceManager;
  cgService: CodeGraphService;
  instancePool: CodeGraphInstancePool;
}

// ═══════════════════════════════════════════════════════════════════════
//  Tool Registry — HTTP tool definitions (per resource type)
// ═══════════════════════════════════════════════════════════════════════

interface HttpToolParam {
  type: "string" | "integer" | "boolean" | "array";
  required?: boolean;
  description?: string;
  default?: unknown;
  enum?: string[];
}

interface HttpToolDef {
  name: string;
  description: string;
  params: Record<string, HttpToolParam>;
}

/** Wiki tools (7) — read-only query tools for LLM agents. */
const WIKI_TOOLS: HttpToolDef[] = [
  {
    name: "get_info",
    description: "Get wiki metadata (name, status, page count, etc.).",
    params: {},
  },
  {
    name: "search",
    description: "BM25 full-text search over wiki page content. Use keywords to find relevant documents.",
    params: {
      query: { type: "string", required: true, description: "Search keywords" },
      limit: { type: "integer", required: false, default: 20, description: "Maximum number of results to return" },
    },
  },
  {
    name: "list_pages",
    description: "List all page references (id + title + path).",
    params: {},
  },
  {
    name: "read_page",
    description: "Read the full content of the specified pages.",
    params: {
      refs: { type: "array", required: true, description: "Array of page references (id or path)" },
    },
  },
  {
    name: "get_graph",
    description: "Get the knowledge graph structure (nodes, edges, communities).",
    params: {},
  },
  {
    name: "list_raw",
    description: "List the original uploaded files.",
    params: {},
  },
  {
    name: "read_raw",
    description: "Read the content of the specified original files.",
    params: {
      filenames: { type: "array", required: true, description: "Array of filenames" },
    },
  },
];

/** Code-Graph tools (9) — read-only query tools for LLM agents. */
const CODE_GRAPH_TOOLS: HttpToolDef[] = [
  {
    name: "get_info",
    description: "Get code-graph metadata (repository name, status, statistics, etc.).",
    params: {},
  },
  {
    name: "search",
    description:
      "Quickly search symbols by name, returning only locations (no source code). To get source code directly / understand a block of code, use explore instead.",
    params: {
      query: { type: "string", required: true, description: "Symbol name or partial name (e.g. \"auth\", \"signIn\", \"UserService\")" },
      kind: {
        type: "string",
        required: false,
        enum: ["function", "method", "class", "interface", "type", "variable", "route", "component"],
        description: "Filter by node kind. Omit to search all kinds (do not pass \"any\"/\"symbol\"/\"file\"; these are not valid values and yield zero results).",
      },
      limit: { type: "integer", required: false, default: 10, description: "Maximum number of results to return" },
    },
  },
  {
    name: "explore",
    description:
      "[Preferred tool] Use it first for almost any question: how X works, architecture, locating a bug, where something is. One call returns the full source of the relevant symbols grouped by file (equivalent to Read; do not read the returned files again). query can be a natural-language question or a set of symbol/file names. Usually one call is enough; no need to search/get_node/read files afterwards.",
    params: {
      query: {
        type: "string",
        required: true,
        description: "Symbol names, file names, or short code terms to explore (e.g. \"AuthService loginUser session-manager\"). You can use search first to find relevant names.",
      },
      maxFiles: { type: "integer", required: false, default: 12, description: "Maximum number of files whose source is returned (default 12)" },
    },
  },
  {
    name: "callers",
    description: "List the functions that call <symbol>. For the full call flow use explore.",
    params: {
      symbol: { type: "string", required: true, description: "Function/method/class name whose callers to look up" },
      limit: { type: "integer", required: false, default: 20, description: "Maximum number of results to return (default 20)" },
    },
  },
  {
    name: "callees",
    description: "List the functions that <symbol> calls. For the full call flow use explore.",
    params: {
      symbol: { type: "string", required: true, description: "Function/method/class name whose callees to look up" },
      limit: { type: "integer", required: false, default: 20, description: "Maximum number of results to return (default 20)" },
    },
  },
  {
    name: "impact",
    description: "List the symbols that would be affected by modifying <symbol>. Use it to assess the blast radius before refactoring.",
    params: {
      symbol: { type: "string", required: true, description: "Symbol name for impact analysis" },
      depth: { type: "integer", required: false, default: 2, description: "Dependency traversal depth (default 2)" },
    },
  },
  {
    name: "node",
    description:
      "[Second choice after explore] Get full information for a single symbol: location, signature, call chain, and verbatim source (includeCode=true). When a name has overloads/multiple definitions, the full bodies of all matching definitions are returned at once; use file/line to pinpoint a specific overload. When you need several related symbols or a full flow, use explore.",
    params: {
      symbol: { type: "string", required: true, description: "Symbol name whose details to look up" },
      includeCode: { type: "boolean", required: false, default: false, description: "Whether to include full source (default false to save context)" },
      file: { type: "string", required: false, description: "Optional: disambiguate overloads by file path/filename (e.g. \"harness.rs\")" },
      line: { type: "integer", required: false, description: "Optional: disambiguate to a definition near this line number" },
    },
  },
  {
    name: "status",
    description: "Index health check (file/node/edge counts). Generally not needed unless troubleshooting.",
    params: {},
  },
  {
    name: "files",
    description: "Indexed file tree, with language and symbol counts. Faster than Glob for viewing project structure.",
    params: {
      path: { type: "string", required: false, description: "Filter by directory prefix (e.g. \"src/components\"); returns everything if omitted" },
      pattern: { type: "string", required: false, description: "Filter by glob pattern (e.g. \"*.tsx\", \"**/*.test.ts\")" },
      format: { type: "string", required: false, default: "tree", enum: ["tree", "flat", "grouped"], description: "Output format: tree (hierarchical, default), flat (flat list), grouped (grouped by language)" },
    },
  },
];

/** Agent read-only whitelist — management ops NOT included. */
const WIKI_TOOL_NAMES = new Set(WIKI_TOOLS.map((t) => t.name));
const CODE_GRAPH_TOOL_NAMES = new Set(CODE_GRAPH_TOOLS.map((t) => t.name));

// ═══════════════════════════════════════════════════════════════════════
//  Route Factory
// ═══════════════════════════════════════════════════════════════════════

export function createToolsRoutes(deps: ToolsRouteDeps): Hono {
  const app = new Hono();
  const { wikiService, wikiMgr, cgService, instancePool } = deps;

  // ── POST /tools/list ──

  app.post("/list", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const knowledgeId = body.knowledge_id;
    if (typeof knowledgeId !== "string" || !knowledgeId) {
      return c.json(wrapError(400, "knowledge_id is required"), 400);
    }

    let type: "wiki" | "code-graph";
    let tools: HttpToolDef[];
    let name: string;
    let summary: string | null;
    let status: string;

    if (isWikiId(knowledgeId)) {
      type = "wiki";
      tools = WIKI_TOOLS;
      const row = wikiService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "knowledge resource not found"), 404);
      name = row.name;
      summary = row.summary ?? null;
      status = row.status;
    } else if (isCodeGraphId(knowledgeId)) {
      type = "code-graph";
      tools = CODE_GRAPH_TOOLS;
      const row = cgService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "knowledge resource not found"), 404);
      name = row.repo_name || row.repo_url;
      summary = row.summary ?? null;
      status = row.status;
    } else {
      return c.json(wrapError(400, `invalid knowledge_id format: ${knowledgeId}`), 400);
    }

    return c.json(wrapOk({
      knowledge_id: knowledgeId,
      type,
      name,
      summary,
      status,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        params: t.params,
      })),
    }));
  });

  // ── POST /tools/call ──

  app.post("/call", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    const serviceId = c.req.header("x-tdai-service-id");
    if (!isValidIdSegment(serviceId)) {
      return c.json(wrapError(400, "x-tdai-service-id header is required"), 400);
    }
    const knowledgeId = body.knowledge_id;
    if (typeof knowledgeId !== "string" || !knowledgeId) {
      return c.json(wrapError(400, "knowledge_id is required"), 400);
    }
    const toolName = body.tool_name;
    if (typeof toolName !== "string" || !toolName) {
      return c.json(wrapError(400, "tool_name is required"), 400);
    }
    const params = body.params;
    if (!params || typeof params !== "object") {
      return c.json(wrapError(400, "params is required (object)"), 400);
    }

    const toolParams = params as Record<string, unknown>;

    if (isWikiId(knowledgeId)) {
      // Whitelist check
      if (!WIKI_TOOL_NAMES.has(toolName)) {
        return c.json(wrapError(403, `unknown tool: '${toolName}' for wiki resource '${knowledgeId}'. Use tools/list to discover available tools.`), 403);
      }

      const row = wikiService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "wiki not found"), 404);

      return executeWikiTool(serviceId, toolName, row, toolParams, wikiService, wikiMgr);
    }

    if (isCodeGraphId(knowledgeId)) {
      // Whitelist check
      if (!CODE_GRAPH_TOOL_NAMES.has(toolName)) {
        return c.json(wrapError(403, `unknown tool: '${toolName}' for code-graph resource '${knowledgeId}'. Use tools/list to discover available tools.`), 403);
      }

      const row = cgService.getById(serviceId, knowledgeId);
      if (!row) return c.json(wrapError(404, "code graph not found"), 404);

      return executeCodeGraphTool(serviceId, toolName, row, toolParams, cgService, instancePool);
    }

    return c.json(wrapError(400, `invalid knowledge_id format: ${knowledgeId}`), 400);
  });

  return app;
}

// ═══════════════════════════════════════════════════════════════════════
//  Wiki tool execution
// ═══════════════════════════════════════════════════════════════════════

async function executeWikiTool(
  serviceId: string,
  toolName: string,
  row: { wiki_id: string; team_id: string; status: string; name: string },
  params: Record<string, unknown>,
  wikiService: WikiService,
  wikiMgr: WikiSourceManager,
): Promise<Response> {
  const { wiki_id, team_id } = row;

  switch (toolName) {
    case "get_info": {
      const detail = wikiService.get(serviceId, team_id, wiki_id);
      if (!detail) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
      return Response.json(wrapOk(detail));
    }
    case "search": {
      const query = params.query;
      if (typeof query !== "string" || !query) {
        return Response.json(wrapError(400, "query is required"), { status: 400 });
      }
      if (row.status !== "ready") {
        return Response.json(wrapOk({ results: [], links: [], count: 0 }));
      }
      const limit = typeof params.limit === "number" ? params.limit : 20;
      const response = wikiMgr.search(wiki_id, query, limit);
      return Response.json(wrapOk(response));
    }
    case "list_pages": {
      if (row.status !== "ready") {
        return Response.json(wrapOk({ items: [] }));
      }
      const items = wikiService.pageLs(serviceId, team_id, wiki_id);
      if (items === null) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
      return Response.json(wrapOk({ items }));
    }
    case "read_page": {
      const refs = params.refs;
      if (!Array.isArray(refs) || refs.length === 0) {
        return Response.json(wrapError(400, "refs is required (non-empty array)"), { status: 400 });
      }
      if (row.status !== "ready") {
        return Response.json(wrapOk({ items: [] }));
      }
      const result = wikiService.pageReadMany(serviceId, team_id, wiki_id, refs as string[]);
      return Response.json(wrapOk({ items: result }));
    }
    case "get_graph": {
      if (row.status !== "ready") {
        return Response.json(wrapOk({ nodes: [], edges: [], communities: [] }));
      }
      const graphData = wikiMgr.graph(wiki_id);
      return Response.json(wrapOk(graphData));
    }
    case "list_raw": {
      const items = wikiService.rawLs(serviceId, team_id, wiki_id);
      if (items === null) return Response.json(wrapError(404, "wiki not found"), { status: 404 });
      return Response.json(wrapOk({ items }));
    }
    case "read_raw": {
      const filenames = params.filenames;
      if (!Array.isArray(filenames) || filenames.length === 0) {
        return Response.json(wrapError(400, "filenames is required (non-empty array)"), { status: 400 });
      }
      const result = wikiService.rawReadMany(serviceId, team_id, wiki_id, filenames as string[]);
      return Response.json(wrapOk({ items: result }));
    }
    default:
      return Response.json(wrapError(403, `unknown tool: ${toolName}`), { status: 403 });
  }
}

// ═══════════════════════════════════════════════════════════════════════
//  Code-Graph tool execution
// ═══════════════════════════════════════════════════════════════════════

// Reuse the query specs from code-graph routes

/**
 * Codegraph query tool names exposed externally (excluding get_info, which the caller handles specially).
 * Single source of truth: tools.ts's CODE_GRAPH_TOOLS, code-graph.ts's route registration,
 * and toCodeGraphToolName's validation list all come from here.
 */
export const CODEGRAPH_QUERY_TOOL_NAMES: readonly string[] = [
  "search", "explore", "callers", "callees", "impact", "node", "status", "files",
];

/**
 * Map an externally exposed tool name to the internal tool name accepted by executeTool.
 * Externally short names are used uniformly (node / status / files); internally the codegraph_ prefix is added uniformly.
 */
export function toCodeGraphToolName(externalName: string): string | undefined {
  return CODEGRAPH_QUERY_TOOL_NAMES.includes(externalName) ? `codegraph_${externalName}` : undefined;
}

async function executeCodeGraphTool(
  serviceId: string,
  toolName: string,
  row: { code_graph_id: string; team_id: string; status: string },
  params: Record<string, unknown>,
  cgService: CodeGraphService,
  instancePool: CodeGraphInstancePool,
): Promise<Response> {
  const { code_graph_id, team_id } = row;

  // get_info is a simple metadata return
  if (toolName === "get_info") {
    const detail = cgService.get(serviceId, team_id, code_graph_id);
    if (!detail) return Response.json(wrapError(404, "code graph not found"), { status: 404 });
    return Response.json(wrapOk(detail));
  }

  // All other tools require synced status
  if (row.status !== "ready") {
    return Response.json(wrapOk({ text: "", isError: false }));
  }

  // Map tool name to internal codegraph action
  const cgToolName = toCodeGraphToolName(toolName);
  if (!cgToolName) {
    return Response.json(wrapError(403, `unknown tool: ${toolName}`), { status: 403 });
  }

  // Build toolParams — map HTTP params to code-graph executeTool params
  const toolParams: Record<string, unknown> = { code_graph_id };
  for (const [k, v] of Object.entries(params)) {
    toolParams[k] = v;
  }

  let instance = instancePool.get(code_graph_id);
  if (!instance && instancePool.loadIfMissing) {
    const dir = cgService.dirFor(serviceId, team_id, code_graph_id);
    instance = await instancePool.loadIfMissing(code_graph_id, dir);
  }
  if (!instance) {
    return Response.json(wrapError(503, "code graph instance not loaded"), { status: 503 });
  }

  const result = await executeCodeTool(instance, cgToolName, toolParams);
  return Response.json(wrapOk(result), { status: result.isError ? 500 : 200 });
}
