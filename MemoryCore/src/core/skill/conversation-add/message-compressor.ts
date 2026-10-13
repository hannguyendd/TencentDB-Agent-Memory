/**
 * SkillMessageCompressor — compress oversized tool_call / tool_result payloads
 * before they enter the skill buffer.
 *
 * Corresponds to design doc `2026-07-15-skill-trigger-in-core-design.md` §6:
 *   - only compress tool_call / tool_result; user / assistant / system are never compressed
 *   - compress only when content bytes > 2KB: first 1KB + last 1KB + a placeholder hint in the middle
 *   - metadata.truncated = true, metadata.original_bytes = <original byte count>
 *
 * Notes on the byte-slicing implementation:
 *   Slicing a Buffer directly may cut in the middle of a UTF-8 multi-byte character, and converting back to a string would
 *   produce the U+FFFD replacement character. Here we slice the Buffer and then toString('utf8'),
 *   and on the Node side an incomplete multi-byte sequence at the end/start is replaced with U+FFFD — but this does not affect
 *   the semantics of the downstream LLM review (the hint text explains the truncation). For tool payloads, which are
 *   usually ASCII/JSON, the probability of a corrupted boundary character is very low; tests use loose assertions.
 */

export type CompressibleRole =
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "system";

export interface CompressibleMessage {
  role: CompressibleRole;
  content: string;
  /** Optional tool identity for tool_call / tool_result. */
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface CompressOptions {
  /** Byte threshold; a tool message's content bytes are compressed only when > the threshold. Default 2048 (2KB). */
  toolContentThresholdBytes: number;
  /** Bytes kept at the head. Default 1024 (1KB). */
  headBytes: number;
  /** Bytes kept at the tail. Default 1024 (1KB). */
  tailBytes: number;
  /** Middle placeholder string. */
  placeholder: string;
}

export const DEFAULT_COMPRESS_OPTIONS: CompressOptions = {
  toolContentThresholdBytes: 2048,
  headBytes: 1024,
  tailBytes: 1024,
  placeholder: "\n\n[Middle content too long and compressed; only head and tail shown]\n\n",
};

const COMPRESSIBLE_ROLES = new Set<CompressibleRole>(["tool_call", "tool_result"]);

/**
 * Compress a single message. Returns a new object if compressed, otherwise
 * returns the original message reference unchanged.
 */
export function compressMessage(
  msg: CompressibleMessage,
  optsOverride: Partial<CompressOptions> = {},
): CompressibleMessage {
  const opts: CompressOptions = { ...DEFAULT_COMPRESS_OPTIONS, ...optsOverride };
  if (!COMPRESSIBLE_ROLES.has(msg.role)) return msg;

  const bytes = Buffer.byteLength(msg.content, "utf8");
  if (bytes <= opts.toolContentThresholdBytes) return msg;

  const buf = Buffer.from(msg.content, "utf8");
  const head = buf.subarray(0, opts.headBytes).toString("utf8");
  const tail = buf.subarray(buf.length - opts.tailBytes).toString("utf8");

  const nextContent = `${head}${opts.placeholder}${tail}`;
  const nextMetadata: Record<string, unknown> = {
    ...(msg.metadata ?? {}),
    truncated: true,
    original_bytes: bytes,
  };

  return {
    ...msg,
    content: nextContent,
    metadata: nextMetadata,
  };
}

/**
 * Compress an array of messages. Returns a new array; unchanged messages
 * share the original reference (identity-preserving for downstream diffing).
 */
export function compressMessages(
  messages: CompressibleMessage[],
  optsOverride: Partial<CompressOptions> = {},
): CompressibleMessage[] {
  if (messages.length === 0) return [];
  return messages.map((m) => compressMessage(m, optsOverride));
}
