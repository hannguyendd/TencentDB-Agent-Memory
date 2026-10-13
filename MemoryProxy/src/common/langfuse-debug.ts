/**
 * Langfuse debug helpers -- gated by `langfuse.debug=true`, used to stuff the native structure of the LLM request
 * + client fingerprints into Langfuse reports as far as possible, for **troubleshooting / client reverse engineering**.
 *
 * Current state breakdown (pitfalls before merging):
 *   1. The Anthropic side `anthropicHandler.buildLangfuseInput` already has a debug branch, but
 *      it only keeps the native structure of messages+system; output is still text concatenation (tool_use /
 *      thinking / stop_reason are lost); metadata only has stream/retried/upstreamUrl.
 *   2. The 5 langfuse report sites in the OpenAI protocol handler.ts **do not read the debug flag at all**,
 *      hardcoded to flatten via flattenMessagesForOpik -- CodeBuddy requests take exactly this path,
 *      so even with debug on, the native CB body cannot be captured.
 *
 * What this file adds is the **shared** part -- the OpenAI protocol input builder + generic debug metadata.
 * The Anthropic-side input builder (`buildLangfuseInput`) is already inlined in anthropicHandler.ts,
 * and is not moved over to avoid a circular dependency. Output handling is branched by each handler itself on the debug flag.
 *
 * See the appendix of docs/design/2026-07-30-cc-request-routing-plan.md and the
 * commit message of this commit for details.
 */

import type { CcRequestKind } from "./cc-request-classifier.js";
import { findLastCacheControlIndex } from "./cc-request-classifier.js";

// --- Allowlist and truncation limits --------------------------------------------------
// Request header prefix: consistent with identity.ts:172, to avoid drifting perceptions of CB headers across places.
const HEADER_PREFIX_WHITELIST = ["x-", "cb-", "codebuddy-"];
// Maximum number of characters a single tool description / string field is truncated to (prevents a single langfuse report from bloating).
const STRING_TRUNC = 200;
// Maximum number of tools to capture (the first N are enough to identify the client fingerprint).
const TOOLS_MAX = 8;

/**
 * Langfuse input builder for OpenAI protocol messages.
 *
 * - `debug=true`: return the messages array as-is (preserving the string/array content CodeBuddy may stuff in,
 *   internal tags such as `<additional_data>` / `<question_answer>`, the cache_control
 *   marker, the native tool_use form, thinking blocks, etc.).
 * - `debug=false`: use the fallback passed in by the caller (generally handler.ts:flattenMessagesForOpik),
 *   flattening the content array into role+string form, saving langfuse storage cost by 2-5x.
 *
 * The `fallback` parameter is passed explicitly rather than imported, so the handler keeps its own flatten
 * implementation (reused by other call sites on the opik/opik-fork side); this file is not responsible for flatten semantics.
 */
export function buildLangfuseInputChat(
  messages: unknown[],
  debug: boolean,
  fallback: (m: unknown[]) => unknown[],
): unknown {
  if (debug) {
    // Return the original messages array directly -- preserving the native role/content structure.
    return messages;
  }
  return fallback(messages);
}

// ─── Debug metadata ─────────────────────────────────────────────────────────

export interface RequestDebugMetadataInput {
  body: Record<string, unknown>;
  headers?: Record<string, string>;
  agentSource?: string;
  requestKind?: CcRequestKind;
  spaceId?: string;
  turnSeq?: number;
  requestPath?: string;
  protocol?: "anthropic" | "openai";
  debug: boolean;
}

/**
 * Extract "client fingerprint + key request-classification fields" from body / headers / routing context and stuff them into
 * Langfuse's observationMetadata / traceMetadata.
 *
 * When `debug=false`, always returns an **empty object** (does not pollute production metadata).
 *
 * Extracted fields (all flat keys, convenient for display in the Langfuse UI):
 *   - `model` / `stream` / `max_tokens` / `temperature` / `top_p` / `top_k`
 *   - `thinking_type` / `stop_sequences_len` / `system_len` / `messages_len`
 *   - `tools_len` / `tools_summary` — name + desc of the first N tools, truncated to 200 chars
 *   - `cache_control_marker_idx` — position of the last cache_control marker in messages
 *     (the core signal for identifying CC fork/main/sidequery; see cc-request-classifier.ts)
 *   - `body_metadata` — Anthropic body.metadata (including user_id etc.)
 *   - `body_extra_keys` — names of "non-standard fields" at the top level of the body (CB / cursor often sneak in extension fields)
 *   - `agent_source` / `request_kind` / `space_id` / `turn_seq` / `request_path`
 *   - `header_<name>` — client headers with allowlisted prefixes (x-* / cb-* / codebuddy-*)
 *
 * Tools/description are all truncated to prevent a single report from bloating. Extraction failures silently return the fields obtained so far
 * (missing one or two debug fields does not affect troubleshooting, and must not throw exceptions that affect business logic).
 */
export function buildRequestDebugMetadata(
  opts: RequestDebugMetadataInput,
): Record<string, unknown> {
  if (!opts.debug) return {};

  const out: Record<string, unknown> = {};
  try {
    const b = opts.body ?? {};

    // -- Common top-level body fields --
    if (typeof b.model === "string") out.model = b.model;
    if (typeof b.stream === "boolean") out.stream = b.stream;
    if (typeof b.max_tokens === "number") out.max_tokens = b.max_tokens;
    if (typeof b.temperature === "number") out.temperature = b.temperature;
    if (typeof b.top_p === "number") out.top_p = b.top_p;
    if (typeof b.top_k === "number") out.top_k = b.top_k;

    // Anthropic thinking block
    const thinking = b.thinking as { type?: unknown } | undefined;
    if (thinking && typeof thinking === "object" && typeof thinking.type === "string") {
      out.thinking_type = thinking.type;
    }

    // stop_sequences (OpenAI: `stop`; Anthropic: `stop_sequences`)
    const stopSeq = Array.isArray(b.stop_sequences)
      ? (b.stop_sequences as unknown[])
      : Array.isArray(b.stop)
      ? (b.stop as unknown[])
      : null;
    if (stopSeq) out.stop_sequences_len = stopSeq.length;

    // System prompt length (Anthropic has body.system; OpenAI puts it in messages[0].role='system')
    if (typeof b.system === "string") {
      out.system_len = b.system.length;
    } else if (Array.isArray(b.system)) {
      let total = 0;
      for (const blk of b.system as unknown[]) {
        const t = (blk as { text?: unknown })?.text;
        if (typeof t === "string") total += t.length;
      }
      out.system_len = total;
    }

    const msgs = Array.isArray(b.messages) ? (b.messages as unknown[]) : [];
    out.messages_len = msgs.length;

    // Tools array -- name + desc (truncated) of the first N, enough for a fingerprint
    if (Array.isArray(b.tools)) {
      const tools = b.tools as unknown[];
      out.tools_len = tools.length;
      const summary: Array<{ name?: string; desc?: string }> = [];
      for (let i = 0; i < Math.min(tools.length, TOOLS_MAX); i++) {
        const t = tools[i] as Record<string, unknown> | undefined;
        if (!t) continue;
        // Anthropic: {name, description}; OpenAI: {function: {name, description}}
        const fn = (t.function as Record<string, unknown> | undefined) ?? t;
        const name = typeof fn.name === "string" ? fn.name : undefined;
        const descRaw = typeof fn.description === "string" ? fn.description : undefined;
        const entry: { name?: string; desc?: string } = {};
        if (name) entry.name = truncate(name, STRING_TRUNC);
        if (descRaw) entry.desc = truncate(descRaw, STRING_TRUNC);
        if (entry.name || entry.desc) summary.push(entry);
      }
      if (summary.length) out.tools_summary = summary;
    }

    // Cache control marker position -- the core signal for CC request classification
    if (msgs.length > 0) {
      const idx = findLastCacheControlIndex(msgs);
      if (idx >= 0) out.cache_control_marker_idx = idx;
    }

    // Anthropic body.metadata (may contain client context such as user_id / session_id)
    if (b.metadata && typeof b.metadata === "object" && !Array.isArray(b.metadata)) {
      out.body_metadata = b.metadata as Record<string, unknown>;
    }

    // Non-standard top-level body fields (extension keys sneaked in by the client -- to identify client fingerprints)
    const standardKeys = new Set([
      "model", "messages", "system", "tools", "tool_choice",
      "temperature", "top_p", "top_k", "max_tokens",
      "stream", "stream_options", "thinking",
      "stop", "stop_sequences", "metadata",
      "n", "user", "seed", "response_format", "presence_penalty", "frequency_penalty",
    ]);
    const extra = Object.keys(b).filter((k) => !standardKeys.has(k));
    if (extra.length) out.body_extra_keys = extra;

    // -- Routing context --
    if (opts.agentSource) out.agent_source = opts.agentSource;
    if (opts.requestKind) out.request_kind = opts.requestKind;
    if (opts.spaceId) out.space_id = opts.spaceId;
    if (typeof opts.turnSeq === "number") out.turn_seq = opts.turnSeq;
    if (opts.requestPath) out.request_path = opts.requestPath;
    if (opts.protocol) out.protocol = opts.protocol;

    // -- Request headers (allowlisted prefixes) --
    if (opts.headers) {
      for (const [rawK, v] of Object.entries(opts.headers)) {
        const k = rawK.toLowerCase();
        // Skip headers containing sensitive information
        if (k === "authorization" || k === "x-api-key" || k === "cookie") continue;
        if (!HEADER_PREFIX_WHITELIST.some((p) => k.startsWith(p))) continue;
        out[`header_${k}`] = truncate(String(v), STRING_TRUNC);
      }
    }
  } catch {
    // Debug metadata is only auxiliary and must never affect business logic; on an exception, return the part already filled
  }
  return out;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}
