/**
 * TAPD MCP JSON-RPC client.
 *
 * Key findings (2026-09-15, all verified against the real gateway):
 *   1. `Accept: application/json, text/event-stream` is required; if missing -> HTTP 406.
 *   2. Business tools take two steps: lookup_tool_param_schema -> proxy_execute_tool.
 *      (lookup_tapd_tool is a semantic discovery tool used only during development; skipped at runtime to save a round trip.)
 *   3. proxy_execute_tool's tool_args is an **object**, not a string.
 *   4. The response needs a second parse: result.content[0].text may still be a JSON string.
 *   5. `page` must be passed as a number (a string makes the server report `str - int`); `limit` accepts either.
 *   6. workspace_id / id must be passed as strings (19-digit ids exceed the JS safe integer range).
 */

import { TaskSourceError } from "../../types.js";

export interface TapdCallOptions {
  /** MCP endpoint, injected by the registry from deployment config. */
  endpoint: string;
  /** Bearer access_token or PAT. */
  token: string;
  /** Custom header name; when set, the token goes in that header, otherwise in Authorization. */
  tokenHeader?: string;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { code?: number; message?: string };
}

export class TapdMcpClient {
  constructor(private readonly opts: TapdCallOptions) {}

  /**
   * Call a business tool and return the parsed data (the `{limit,offset,count,page,data}` envelope is stripped automatically).
   */
  async call(toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> {
    const raw = await this.callRaw(toolName, toolArgs);
    return unwrap(raw);
  }

  /** Call a business tool and return the raw parsed result (pagination envelope kept). */
  async callRaw(toolName: string, toolArgs: Record<string, unknown>): Promise<unknown> {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: "proxy_execute_tool", arguments: { tool_name: toolName, tool_args: toolArgs } },
    });

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      // Empirically: the gateway returns 406 when this header is missing.
      Accept: "application/json, text/event-stream",
    };
    if (this.opts.tokenHeader) headers[this.opts.tokenHeader] = this.opts.token;
    else headers.Authorization = `Bearer ${this.opts.token}`;

    const res = await fetchWithTimeout(this.opts.endpoint, {
      method: "POST",
      headers,
      body,
      timeoutMs: this.opts.timeoutMs ?? 30_000,
    });

    if (res.status === 401 || res.status === 403) {
      throw new TaskSourceError("task_source_unauthorized", "credential rejected by TAPD");
    }
    if (!res.ok) {
      throw new TaskSourceError("task_source_upstream_error", `TAPD returned HTTP ${res.status}`);
    }

    const json = (await res.json()) as JsonRpcResponse;
    if (json.error) {
      throw new TaskSourceError(
        "task_source_upstream_error",
        json.error.message ?? "TAPD MCP error",
      );
    }
    /**
     * **Business-layer failure**: the JSON-RPC succeeded (no error) and HTTP is also 200, but
     * `result.isError === true` -- in which case content[0].text holds the **error text**,
     * not business data.
     *
     * This must be checked before looksLikeUpstreamError: the latter relies on text-pattern matching,
     * and misses error wordings it did not anticipate; isError is a protocol flag and far more reliable.
     * If not intercepted, the error text would be imported onto the board as the task description.
     */
    if (json.result?.isError === true) {
      const detail =
        json.result.content
          ?.map((c) => (typeof c?.text === "string" ? c.text : ""))
          .join("\n")
          .trim() || "unknown TAPD MCP tool error";
      throw new TaskSourceError("task_source_upstream_error", detail.slice(0, 200));
    }

    const text = json.result?.content?.[0]?.text ?? "";
    // On server-side parameter validation failure, a Chinese error text is returned (e.g. "参数X不存在于工具Y的参数定义中", i.e. "parameter X does not exist in tool Y's parameter definition"),
    // rather than a JSON envelope. If silently treated as "0 results", a config error would be disguised as an empty list, which is very hard to troubleshoot.
    if (looksLikeUpstreamError(text)) {
      throw new TaskSourceError("task_source_upstream_error", text.trim().slice(0, 200));
    }
    // Second parse: text may still be a JSON string; if parsing fails, return it as plain text.
    return parseMaybeJson(text);
  }
}

/** Strip TAPD's unified pagination envelope and return the data array. */
export function unwrap(raw: unknown): unknown {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const env = raw as { data?: unknown };
    if (Array.isArray(env.data)) return env.data;
  }
  return raw;
}

/** Get the pagination total; falls back to the array length when there is no envelope. */
export function totalOf(raw: unknown, fallback: number): number {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const count = (raw as { count?: unknown }).count;
    if (typeof count === "number") return count;
    if (typeof count === "string" && /^\d+$/.test(count)) return Number(count);
  }
  return fallback;
}

/**
 * Recognize error text returned by the server (neither JSON nor data).
 *
 * Empirically: when parameters are invalid, the gateway returns text like
 *   "参数with_v_status不存在于工具bugs_get的参数定义中,请检查后重试" (parameter with_v_status does not exist in tool bugs_get's parameter definition, please check and retry)
 * The HTTP status of such text is still 200, so it must be recognized by content patterns.
 */
function looksLikeUpstreamError(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith("{") || t.startsWith("[")) return false;
  // Chinese: parameter validation failure (server error text is Chinese; patterns below must stay Chinese)
  if (/参数.*不存在|不存在于工具|请检查后重试|Traceback/.test(t)) return true;
  // Auth failure: the MCP gateway endpoint returns "缺少 TAPD 认证信息 / AUTH_MISSING" (missing TAPD auth info),
  // and a failed Taihu identity resolution returns "decode taihu identity fail".
  // If such errors are not thrown on the spot, asRows treats them as "not an array" and silently returns an empty list,
  // making the user wrongly believe "the account has no project permissions".
  if (/缺少\s*TAPD\s*认证信息|AUTH_MISSING|缺少认证|unauthorized|decode .*identity fail/i.test(t)) {
    return true;
  }
  return false;
}

function parseMaybeJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return text;
  try {
    return JSON.parse(trimmed);
  } catch {
    return text;
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit & { timeoutMs: number },
): Promise<Response> {
  const { timeoutMs, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...rest, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new TaskSourceError("task_source_timeout", "TAPD request timed out");
    }
    throw new TaskSourceError(
      "task_source_upstream_error",
      err instanceof Error ? err.message : "network error",
    );
  } finally {
    clearTimeout(timer);
  }
}
