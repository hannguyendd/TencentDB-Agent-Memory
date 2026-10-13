/**
 * prepareArchivePayload — the "compress + fallback" archive payload assembly shared by direct-trigger (`/v3/skill/extract`) and
 * the conversation-add handler.
 *
 * It is extracted so the two paths have **only one implementation**, otherwise subtle differences easily drift in.
 *
 * Steps (equivalent logic of the §③ path-routing segment inside handle() in `add-handler.ts`):
 *   ① forceCompress=true → compressMessages(incoming); otherwise passthrough
 *   ② combined = existing + compressed
 *   ③ only when forceCompress=true and totalBytes(combined) > chunkMax
 *      → applyOversizeStrategy (the fallback truncation happens only on the compression path, equivalent to the original add-handler behavior)
 *   ④ return { messages, usedCompress, usedOversize }
 *
 * Calling convention:
 *   - conversation/add: existing = data-current, forceCompress = (rawBytes >= threshold)
 *   - skill_extract  : existing = [], forceCompress = true (direct-trigger always compresses)
 */

import {
  compressMessages,
  type CompressOptions,
  type CompressibleMessage,
} from "./message-compressor.js";
import {
  applyOversizeStrategy,
  type OversizeMessage,
  type OversizeOptions,
} from "./oversize-strategy.js";

export interface PrepareArchiveOptions {
  compress: CompressOptions;
  oversize: OversizeOptions;
  /** Always true for direct-trigger; conversation/add passes true only on the compression path. */
  forceCompress: boolean;
}

export interface PrepareArchiveResult {
  messages: OversizeMessage[];
  /** Whether compressMessages was taken (true only when some tool message > threshold). */
  usedCompress: boolean;
  /** Whether the oversize fallback truncation was triggered. */
  usedOversize: boolean;
}

export function prepareArchivePayload(
  existing: OversizeMessage[],
  incoming: CompressibleMessage[],
  opts: PrepareArchiveOptions,
): PrepareArchiveResult {
  // ① forceCompress decides whether to take compression
  const compressed: CompressibleMessage[] = opts.forceCompress
    ? compressMessages(incoming, opts.compress)
    : incoming;

  // usedCompress reflects "whether anything was actually compressed away" — not "whether forceCompress is set".
  // compressMessages only actually changes content when a tool message's content > threshold;
  // short messages are identity-returned even under forceCompress and do not count as real compression.
  const usedCompress = opts.forceCompress && compressed.some(
    (m, i) => m !== incoming[i],
  );

  // ② concatenate
  const combined: OversizeMessage[] = [
    ...existing,
    ...(compressed as unknown as OversizeMessage[]),
  ];

  // ③ decide whether the oversize fallback is needed — triggered only on the forceCompress path, aligned with the original
  //    add-handler behavior (the normal path never has combined > chunkMax; only if still over
  //    after forced compression does the fallback apply). On the skill_extract side forceCompress=true, so this check naturally takes effect.
  if (!opts.forceCompress) {
    return { messages: combined, usedCompress, usedOversize: false };
  }
  const combinedBytes = totalMessagesBytes(combined);
  if (combinedBytes <= opts.oversize.chunkMaxBytes) {
    return { messages: combined, usedCompress, usedOversize: false };
  }

  const out = applyOversizeStrategy(combined, opts.oversize);
  return {
    messages: out.messages,
    usedCompress,
    usedOversize: out.truncated,
  };
}

function totalMessagesBytes(msgs: Array<{ role: string; content: string }>): number {
  let sum = 0;
  for (const m of msgs) sum += Buffer.byteLength(JSON.stringify(m), "utf8");
  return sum;
}
