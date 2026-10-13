/**
 * iWiki MCP client (Streamable HTTP, JSON-RPC 2.0).
 *
 * Wraps three MCP tools: list children, get body, get metadata.
 * Concrete field names/parameter shapes follow the MCP server contract and are not hard-coded in source comments
 * (to avoid leaking upstream implementation details with the code; when it changes, go by measurement).
 *
 * Authentication: personal token (Bearer), injected by the caller via SourceContext;
 * the endpoint address comes from deployment config `WIKI_SOURCE_IWIKI_MCP_URL`, with no built-in default.
 *
 * Response envelope: { result: { content: [{ type:"text", text:"..." }] } }; errors go through { error: { message } }
 */

import type { SourceContext } from "../../types.js";

export class IWikiMcpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IWikiMcpError";
  }
}

interface McpEnvelope {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/**
 * Extract text from { result: { content: [{text}] } }; if it is already a string, return as is.
 *
 * Key point: MCP has two layers of errors —
 *   1) HTTP 401/403, non-2xx, JSON-RPC { error } — handled by callTool;
 *   2) **business-layer failure**: JSON-RPC succeeds (no error) but `result.isError === true`,
 *      in which case result.content holds the **error text**, not the document body.
 * If the 2nd layer is not intercepted, the error text would be judged non-empty by the downstream `filter(c => c.markdown)`,
 * and error content would be written into the wiki raw as the document body. So isError must be checked first here.
 */
function unwrap(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in result) {
    const env = result as McpEnvelope;
    if (env.isError === true) {
      const detail =
        env.content
          ?.map((c) => (typeof c?.text === "string" ? c.text : ""))
          .join("\n")
          .trim() || "unknown MCP tool error";
      throw new IWikiMcpError(`iWiki MCP tool error: ${detail}`);
    }
    const text = env.content?.[0]?.text;
    if (typeof text === "string") {
      // Some tools return a JSON string, others directly return markdown/text
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
  }
  return result;
}

async function callTool(
  ctx: SourceContext,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const url = ctx.endpoint.replace(/\/+$/, "");

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${ctx.secret}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
      signal: AbortSignal.timeout(ctx.timeoutMs ?? 15000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const isNetwork = /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR/i.test(detail);
    throw new IWikiMcpError(
      isNetwork
        // Note: do not put the endpoint address into the error message — it is an intranet address and would be returned to the frontend with the response.
        ? `Unable to connect to the iWiki MCP endpoint: ${detail}. Please confirm WIKI_SOURCE_IWIKI_MCP_URL is configured correctly and the network is reachable.`
        : `iWiki MCP request failed (${toolName}): ${detail}`,
    );
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new IWikiMcpError("iWiki token invalid or expired (the Taihu personal token is invalid or has expired)", resp.status);
  }
  if (!resp.ok) {
    throw new IWikiMcpError(`iWiki MCP error (${toolName}): HTTP ${resp.status}`, resp.status);
  }

  let json: { error?: { message?: string }; result?: unknown };
  try {
    json = (await resp.json()) as { error?: { message?: string }; result?: unknown };
  } catch {
    throw new IWikiMcpError(`iWiki MCP non-JSON response (${toolName})`);
  }
  if (json.error) {
    throw new IWikiMcpError(`iWiki MCP error (${toolName}): ${json.error.message ?? "unknown"}`);
  }
  return unwrap(json.result);
}

/** Page tree node (measured fields: docid / title / parentid / has_children). */
export interface IWikiTreeNode {
  docid: number;
  title: string;
  parentid?: number;
  has_children?: boolean;
}

function assertNodeArray(raw: unknown): IWikiTreeNode[] {
  if (Array.isArray(raw)) return raw as IWikiTreeNode[];
  // Error envelope: { msg:"error", message:"..." }
  // Note: do not put the upstream tool method name into the error message — it is an internal implementation detail and would be returned to the frontend with the response.
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (o.msg === "error" && typeof o.message === "string") {
      throw new IWikiMcpError(o.message);
    }
  }
  throw new IWikiMcpError("unexpected response: not a node array");
}

/**
 * Fetch the **direct children** document list (not the whole tree).
 *
 * @param parentId parent document id, must be a number
 */
export async function getSpacePageTree(
  ctx: SourceContext,
  parentId: number,
): Promise<IWikiTreeNode[]> {
  const raw = await callTool(ctx, "getSpacePageTree", { parentid: parentId });
  return assertNodeArray(raw);
}

/** Get the space root's direct children by spaceKey. */
export async function getSpaceRoot(
  ctx: SourceContext,
  spaceKey: string,
): Promise<IWikiTreeNode[]> {
  const raw = await callTool(ctx, "getSpacePageTree", { spaceKey });
  return assertNodeArray(raw);
}

/** Fetch a single document (returns markdown). Measured: only accepts docid (string). */
export async function getDocument(
  ctx: SourceContext,
  docId: string,
): Promise<{ markdown: string; title?: string }> {
  const raw = await callTool(ctx, "getDocument", { docid: docId });
  if (typeof raw === "string") return { markdown: raw };
  const obj = (raw ?? {}) as Record<string, unknown>;
  const markdown =
    (typeof obj.markdown === "string" && obj.markdown) ||
    (typeof obj.content === "string" && obj.content) ||
    (typeof obj.body === "string" && obj.body) ||
    (typeof obj.text === "string" && obj.text) ||
    "";
  return {
    markdown,
    title: typeof obj.title === "string" ? obj.title : undefined,
  };
}

/**
 * Document metadata (title/update time/content type), used to fill in titles in the list.
 *
 * `contentType` measured values: "FOLDER" (directory) or ordinary document types.
 * /p/<docid> links may be directory pages; it must be relied on to decide whether to expand children,
 * otherwise directories would be treated as single documents and all child documents lost.
 */
export async function getMetadata(
  ctx: SourceContext,
  docId: string,
): Promise<{ title?: string; updatedAt?: string; contentType?: string }> {
  const raw = await callTool(ctx, "metadata", { docid: docId });
  const obj = (raw ?? {}) as Record<string, unknown>;
  return {
    title: typeof obj.title === "string" ? obj.title : undefined,
    updatedAt: typeof obj.updatetime === "string" ? obj.updatetime : undefined,
    contentType: typeof obj.content_type === "string" ? obj.content_type : undefined,
  };
}
