/**
 * Direct passthrough runner — full implementation (Phase 4).
 *
 * Migrated from directHandler.ts::handleDirectPassthrough (756 lines).
 * Semantically 1:1 equivalent to the old implementation, but now hosted by the pipeline runner:
 *   - stripDirectPrefix / buildDirectUpstreamUrl / detectProtocol reuse the old helpers
 *   - buildDirectRequestHeaders -> uses pipeline SKIP_REQUEST_HEADERS_HOP_BY_HOP
 *     (the latent leak recorded in Phase 0.4 addendum §2.4 is fixed as well:
 *      the HOP_BY_HOP version is replaced by the WITH_INTERNAL version, so a client-supplied x-tdai-user-key is not passed through)
 *   - flatten + obs / stream tap / non-stream parse are all inlined (aligned segment by segment with the old code)
 *
 * WARNING: the only behavior change from the old implementation (a deliberate latent-leak fix, addendum §2.4):
 *   The old version used HOP_BY_HOP (4 items) SKIP_REQUEST_HEADERS; if a client supplied
 *   `x-tdai-user-key` it was passed through to upstream (leaking the proxy's internal identity). The new pipeline uses
 *   WITH_INTERNAL (5 items) and blocks it along the way.
 *   -> If a test pinned the old behavior of passthrough, it will detect this change and fail; decide by the pin's purpose
 *     whether to allow it (usually it should be allowed, since the old behavior was itself a bug).
 */

import type { Context } from "hono";
import type { ProxyConfig } from "../../types.js";
import { writeLog } from "../../logger.js";
import { log } from "../../report/log.js";
import {
  apiKeyToKeyId,
  extractBearerToken,
  opikCreateLlmSpan,
  opikCreateTrace,
  uuidv7,
} from "../../opik.js";
import { extractSpaceIdFromPath } from "../../credit-reporter.js";
import { extractSseUsage, flattenMessagesForOpik } from "./openai-chat.js";
import { resolveSessionKey } from "../../guard-adapter.js";
import { SKIP_REQUEST_HEADERS_WITH_INTERNAL, filterResponseHeaders } from "../../common/constants.js";
import {
  stripDirectPrefix,
  buildDirectUpstreamUrl,
  detectProtocol,
  type DirectUpstreamProtocol as UpstreamProtocol,
} from "./direct-helpers.js";

// ─── Header helpers ─────────────────────────────────────────────────────────

/** Copy request headers (strip hop-by-hop + the x-tdai-user-key internal identity header —
 * the latent leak recorded in addendum §2.4 is fixed as well). */
function buildDirectRequestHeaders(c: Context): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) {
    if (!SKIP_REQUEST_HEADERS_WITH_INTERNAL.has(k.toLowerCase())) {
      headers[k] = v;
    }
  }
  return headers;
}

function extractApiKey(c: Context): string {
  const xApiKey = c.req.header("x-api-key");
  if (xApiKey) return xApiKey;
  const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
  return extractBearerToken(authHeader);
}

// ─── Anthropic messages flatten (fully identical to the old directHandler's standalone implementation) ────────

// flattenAnthropicMessagesForOpik reuses the full implementation from the anthropic runner
// (the original standalone direct version is identical in content to the anthropic version; the only difference is that it does not accept a system parameter;
// simply not passing system achieves the original behavior).
import { flattenAnthropicMessagesForOpik } from "./anthropic.js";

// ─── Observability context + reporters ──────────────────────────────────────

interface DirectObsContext {
  config: ProxyConfig;
  protocol: UpstreamProtocol;
  traceId: string;
  keyId: string;
  sessionKey: string;
  startTime: string;
  upstreamUrl: string;
  modelId: string;
  spaceId?: string;
  upstreamRequestId?: string;
  flatMessages: unknown[];
}

function reportUsage(
  ctx: DirectObsContext,
  usage: Record<string, unknown>,
  endTime: string,
  stream: boolean,
  outputMessage: { role: "assistant"; content: unknown } | null,
): void {
  try {
    writeLog(ctx.config, {
      timestamp: endTime,
      event: "usage",
      modelId: ctx.modelId,
      keyId: ctx.keyId,
      sessionKey: ctx.sessionKey,
      upstreamUrl: ctx.upstreamUrl,
      stream,
      usage,
      spaceId: ctx.spaceId,
      upstreamRequestId: ctx.upstreamRequestId,
    });
  } catch (err: unknown) {
    log.warn("direct.usage_log_failed", { error: String(err) });
  }
  try {
    opikCreateLlmSpan(ctx.config, {
      traceId: ctx.traceId,
      projectName: ctx.keyId,
      name: ctx.modelId,
      startTime: ctx.startTime,
      endTime,
      inputMessages: ctx.flatMessages,
      outputMessage,
      model: ctx.modelId,
      usage,
      tags: ["direct", `protocol:${ctx.protocol}`],
    });
  } catch (err: unknown) {
    log.warn("direct.opik_span_failed", { error: String(err) });
  }
}

// ─── Stream consumers ───────────────────────────────────────────────────────

function consumeAnthropicStreamForObs(stream: ReadableStream<Uint8Array>, ctx: DirectObsContext): void {
  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    const usage: Record<string, unknown> = {};
    let outputText = "";
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";
        for (const part of parts) {
          const lines = part.split("\n");
          let dataStr = "";
          for (const line of lines) {
            if (line.startsWith("data: ")) dataStr = line.slice(6);
            else if (line.startsWith("data:")) dataStr = line.slice(5);
          }
          if (!dataStr || dataStr === "[DONE]") continue;
          try {
            const evt = JSON.parse(dataStr) as Record<string, unknown>;
            const evtType = evt.type as string;
            if (evtType === "message_start") {
              const message = evt.message as Record<string, unknown> | undefined;
              if (message?.usage) Object.assign(usage, message.usage as Record<string, unknown>);
            } else if (evtType === "message_delta") {
              if (evt.usage) Object.assign(usage, evt.usage as Record<string, unknown>);
            } else if (evtType === "content_block_delta") {
              const delta = evt.delta as Record<string, unknown> | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") outputText += delta.text;
            }
          } catch { /* skip */ }
        }
      }
    } catch (err: unknown) {
      log.warn("direct.stream_read_failed", { protocol: "anthropic", error: String(err) });
    }
    if (Object.keys(usage).length === 0) return;
    reportUsage(ctx, usage, new Date().toISOString(), true,
      outputText ? { role: "assistant", content: outputText } : null);
  })().catch((err: unknown) => {
    log.warn("direct.stream_consume_failed", { protocol: "anthropic", error: String(err) });
  });
}

function consumeOpenAiStreamForObs(stream: ReadableStream<Uint8Array>, ctx: DirectObsContext): void {
  (async () => {
    const decoder = new TextDecoder();
    let sseBuf = "";
    let lastUsage: Record<string, unknown> | null = null;
    let outputText = "";
    try {
      const reader = stream.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        const parts = sseBuf.split("\n\n");
        sseBuf = parts.pop() ?? "";
        for (const part of parts) {
          for (const line of part.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const dataStr = trimmed.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;
            try {
              const evt = JSON.parse(dataStr) as Record<string, unknown>;
              if (evt.usage && typeof evt.usage === "object") lastUsage = evt.usage as Record<string, unknown>;
              const choices = evt.choices as unknown[] | undefined;
              if (Array.isArray(choices) && choices.length > 0) {
                const delta = (choices[0] as Record<string, unknown>).delta as Record<string, unknown> | undefined;
                if (delta && typeof delta.content === "string") outputText += delta.content;
              }
            } catch { /* skip */ }
          }
        }
      }
    } catch (err: unknown) {
      log.warn("direct.stream_read_failed", { protocol: "openai", error: String(err) });
    }
    if (!lastUsage || Object.keys(lastUsage).length === 0) return;
    reportUsage(ctx, lastUsage, new Date().toISOString(), true,
      outputText ? { role: "assistant", content: outputText } : null);
  })().catch((err: unknown) => {
    log.warn("direct.stream_consume_failed", { protocol: "openai", error: String(err) });
  });
}

// ─── Non-stream parsers ─────────────────────────────────────────────────────

function parseAnthropicResponse(respText: string): {
  usage: Record<string, unknown> | null;
  outputContent: string | null;
} {
  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const content = respJson.content;
    if (Array.isArray(content)) {
      const textParts: string[] = [];
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "text" && typeof block.text === "string") textParts.push(block.text);
      }
      outputContent = textParts.join("\n");
    }
  } catch { /* non-JSON */ }
  return { usage, outputContent };
}

function parseOpenAiResponse(respText: string): {
  usage: Record<string, unknown> | null;
  outputContent: string | null;
} {
  let usage: Record<string, unknown> | null = null;
  let outputContent: string | null = null;
  try {
    const respJson = JSON.parse(respText) as Record<string, unknown>;
    if (respJson.usage && typeof respJson.usage === "object") {
      usage = respJson.usage as Record<string, unknown>;
    }
    const choices = respJson.choices;
    if (Array.isArray(choices) && choices.length > 0) {
      const msg = (choices[0] as Record<string, unknown>).message as Record<string, unknown> | undefined;
      if (msg && typeof msg.content === "string") outputContent = msg.content;
    }
  } catch { /* non-JSON */ }
  if (!usage) {
    const sseUsage = extractSseUsage(respText);
    if (sseUsage) usage = sseUsage;
  }
  return { usage, outputContent };
}

// ─── Main runner ────────────────────────────────────────────────────────────

/**
 * runDirectPipeline — full /direct/* processing chain, semantically equivalent to handleDirectPassthrough.
 *
 * runPipeline() dispatches to this function if and only if:
 *   - protocol.name === "passthrough" (passthroughProtocol)
 *   - agent === null (passthrough is not bound to an agent)
 */
export async function runDirectPipeline(c: Context, config: ProxyConfig): Promise<Response> {
  const traceId = uuidv7();
  const startTime = new Date().toISOString();

  const stripped = stripDirectPrefix(c.req.path);
  const upstreamUrl = buildDirectUpstreamUrl(config.upstream.url, c.req.path, c.req.url);
  const method = c.req.method.toUpperCase();
  const protocol = method === "POST" ? detectProtocol(stripped) : null;

  // ── Branch A: minimal passthrough without observation ──────────────
  if (!protocol) {
    const headers = buildDirectRequestHeaders(c);
    const hasBody = method !== "GET" && method !== "HEAD";
    const body = hasBody ? c.req.raw.body : null;
    log.debug("direct.forward_start", { method, requestPath: c.req.path, upstreamUrl, observed: false });
    let upstreamResp: Response;
    try {
      upstreamResp = await fetch(upstreamUrl, {
        method,
        headers,
        body,
        ...(body ? { duplex: "half" } : {}),
      } as RequestInit);
    } catch (err: unknown) {
      log.error("direct.forward_failed",
        { method, requestPath: c.req.path, upstreamUrl },
        err instanceof Error ? err : new Error(String(err)));
      return c.json({
        error: "Upstream request failed",
        detail: err instanceof Error ? err.message : String(err),
      }, 502);
    }
    return new Response(upstreamResp.body, {
      status: upstreamResp.status,
      headers: filterResponseHeaders(upstreamResp.headers),
    });
  }

  // ── Branch B: observation + passthrough ────────────────────────────
  const rawBody = await c.req.arrayBuffer();
  const bodyText = new TextDecoder().decode(rawBody);
  let parsedBody: Record<string, unknown> | null = null;
  try {
    parsedBody = JSON.parse(bodyText) as Record<string, unknown>;
  } catch { /* non-JSON → degrade to pure passthrough (no observation) */ }

  const modelId = parsedBody && typeof parsedBody.model === "string" ? parsedBody.model : "unknown";
  const messages = parsedBody && Array.isArray(parsedBody.messages) ? parsedBody.messages : [];
  const isStream = parsedBody?.stream === true;

  const apiKey = extractApiKey(c);
  const keyId = apiKey ? apiKeyToKeyId(apiKey) : "unknown";
  const spaceId = extractSpaceIdFromPath(c.req.path) ?? "";

  const lcHeaders: Record<string, string> = {};
  for (const [k, v] of c.req.raw.headers.entries()) lcHeaders[k.toLowerCase()] = v;
  const sessionKey = resolveSessionKey(config, lcHeaders, c.req.path, parsedBody ?? {}, keyId);

  const headers = buildDirectRequestHeaders(c);

  log.debug("direct.forward_start", {
    method, requestPath: c.req.path, upstreamUrl,
    observed: true, protocol, modelId, isStream,
  });

  let upstreamResp: Response;
  try {
    upstreamResp = await fetch(upstreamUrl, { method, headers, body: rawBody });
  } catch (err: unknown) {
    log.error("direct.forward_failed",
      { method, requestPath: c.req.path, upstreamUrl, protocol },
      err instanceof Error ? err : new Error(String(err)));
    return c.json({
      error: "Upstream request failed",
      detail: err instanceof Error ? err.message : String(err),
    }, 502);
  }

  const upstreamRequestId = upstreamResp.headers.get("x-request-id") ?? "";
  const respHeaders = filterResponseHeaders(upstreamResp.headers);

  const flatMessages = protocol === "anthropic"
    ? flattenAnthropicMessagesForOpik(messages)
    : flattenMessagesForOpik(messages);

  if (parsedBody) {
    opikCreateTrace(config, {
      traceId,
      projectName: keyId,
      name: `${modelId} / ${keyId}`,
      startTime,
      input: { messages: flatMessages },
      tags: [
        `protocol:${protocol}`,
        isStream ? "stream" : "non-stream",
        `session:${sessionKey}`,
        "direct",
      ],
    });
  }

  const obsCtx: DirectObsContext = {
    config, protocol, traceId, keyId, sessionKey, startTime,
    upstreamUrl, modelId, spaceId, upstreamRequestId, flatMessages,
  };

  // ── Streaming ──
  if (isStream) {
    if (!upstreamResp.body) {
      return new Response(null, { status: upstreamResp.status, headers: respHeaders });
    }
    const [clientStream, tapStream] = upstreamResp.body.tee();
    if (parsedBody) {
      if (protocol === "anthropic") consumeAnthropicStreamForObs(tapStream, obsCtx);
      else consumeOpenAiStreamForObs(tapStream, obsCtx);
    } else {
      tapStream.cancel().catch(() => { /* noop */ });
    }
    return new Response(clientStream, { status: upstreamResp.status, headers: respHeaders });
  }

  // ── Non-streaming ──
  const respBuf = await upstreamResp.arrayBuffer();
  const respText = new TextDecoder().decode(respBuf);
  const endTime = new Date().toISOString();

  if (parsedBody) {
    const { usage, outputContent } = protocol === "anthropic"
      ? parseAnthropicResponse(respText)
      : parseOpenAiResponse(respText);
    if (usage && upstreamResp.ok) {
      reportUsage(obsCtx, usage, endTime, false,
        outputContent ? { role: "assistant", content: outputContent } : null);
    }
  }

  return new Response(respBuf, { status: upstreamResp.status, headers: respHeaders });
}
