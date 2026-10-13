/**
 * Before handing a response back to the agent, strip the injected `context_focus_question` out of the tool_call arguments.
 *
 * Why strip it: this field is injected to obtain compression hints; the hints already went into the Redis
 * side channel at the response-tap stage, and on the next turn backfill re-injects them into the request body **forwarded upstream** -- the agent never needs to see it.
 * And seeing it causes trouble: the client validates parameters against its own tool schema, and the extra field is judged as
 * `InputValidationError: An unexpected parameter ... was provided`, and the tool refuses to execute.
 *
 * -- Why streaming "defers by one frame" instead of deleting directly --------------------------------
 * Tool_call arguments in SSE are a series of JSON fragments (Anthropic's `input_json_delta`,
 * Responses' `function_call_arguments.delta`); a single fragment may break in the middle of a key name,
 * or in the middle of an escape sequence, so keys cannot be deleted fragment by fragment -- we must wait until the whole string is assembled.
 *
 * But we also cannot "hold everything back and emit a new event at the end": Responses events carry `sequence_number`,
 * and inserting a frame out of thin air would break the numbering. So here we always **hold back the last fragment event**: earlier fragments are emitted as usual,
 * only with the payload replaced by an empty string; once the arguments are complete, the held-back frame is emitted along with the full cleaned result.
 * The client does string concatenation, so `"" + "" + full string` is equivalent to the original, while the event count, order, sequence numbers and
 * `item_id` are all preserved as-is.
 *
 * The cost is that tool arguments no longer appear character by character in the client UI, but all at once when the block ends. No functional impact:
 * the client has to wait for complete JSON before executing the tool anyway.
 *
 * Although OpenAI Chat chunks have no sequence number, so inserting frames seems safe, the client validates tool_call
 * against shapes it recognizes (CodeBuddy requires `type: "function"`), and a re-emitted chunk, with or without these fields,
 * may be judged invalid -- if included, it may even be accumulated as a string into `"functionfunction"`. So it also uses frame holding.
 *
 * Any parse failure passes through as-is: a broken upstream response should be exposed to the client as-is and not processed a second time here.
 */

// The field name belongs to the compression extension; the host only calls it via the adapter, and when the extension is absent the whole chain automatically degrades to
// a no-op -- without the extension there is no injection, hence nothing to strip.
import {
  hasInjectedToolCleanup,
  shouldStripInjectedTool,
  stripInjectedToolArguments as stripCfqFromArguments,
  stripInjectedToolInput as stripCfqFromInput,
} from "../request-prepare-adapter.js";

export type CfqStripProtocol = "anthropic" | "openai" | "responses";
type ShouldStripTool = (toolName: string | undefined) => boolean;
/**
 * Handlers pass their opaque preparation stats; focused unit tests/direct
 * callers may pass the exact injected tool-name set.
 */
export type CfqStripSelection =
  | Record<string, unknown>
  | ReadonlySet<string>
  | null
  | undefined;

export interface CfqStripSummary {
  protocol: CfqStripProtocol;
  stream: boolean;
  strippedCount: number;
  toolNames: string[];
  /**
   * Tools that this request extended *and* the model actually called, so a call
   * carrying no injected field is a real omission rather than a turn the
   * injection never applied to.
   *
   * Without this, "stripped nothing" is ambiguous: a plain prose answer, a turn
   * that only called un-extended tools, and a model that ignored the field all
   * produce a count of zero. Only the last one is worth a warning.
   */
  eligibleTools: string[];
}

export type CfqStripObserver = (summary: CfqStripSummary) => void;
type MarkStripped = (identity: string, toolName: string) => void;

export function formatCfqStripSummary(summary: CfqStripSummary): string {
  return `success=true field=context_focus_question protocol=${summary.protocol} stream=${summary.stream} calls=${summary.strippedCount} tools=${summary.toolNames.join(",")}`;
}

/**
 * Observer that reports a successful strip and flags the one case that silently
 * costs compression later: the model called a tool we extended, but left the
 * injected field out, so there is nothing to carry over to the next turn.
 *
 * Deliberately narrower than the response-side `CFQ_NOT_PRODUCED` check, which
 * sees every tool call but not which of them were extended. This one knows the
 * extension set exactly, so it does not blame the model for calls that were
 * never asked to carry the field.
 *
 * Takes the pipeline logger itself rather than a bare callback: every call site
 * has one, and the structural `{ info }` shape keeps tests free to pass a stub.
 */
export function createCfqStripObserver(
  logger: { info(stage: string, detail: string): void },
): CfqStripObserver {
  return (summary) => {
    if (summary.strippedCount > 0) {
      logger.info("CFQ_STRIP_SUCCESS", formatCfqStripSummary(summary));
      return;
    }
    // Nothing stripped and nothing eligible: injection simply did not apply to
    // this turn. Staying quiet keeps the warning meaningful.
    if (summary.eligibleTools.length === 0) return;
    logger.info(
      "CFQ_INJECTED_NOT_FILLED",
      `⚠️ protocol=${summary.protocol} stream=${summary.stream} ` +
        `eligible_tools=${summary.eligibleTools.join(",")} stripped=0 — the model ` +
        `called these extended tool(s) without populating the injected field, so ` +
        `the side channel stores nothing and the next turn falls back to no_cfq`,
    );
  };
}

function createStripTracker(
  protocol: CfqStripProtocol,
  stream: boolean,
  observer: CfqStripObserver | undefined,
): { mark: MarkStripped; markEligible: (toolName: string) => void; report: () => void } {
  const identities = new Set<string>();
  const toolNames = new Set<string>();
  const eligibleTools = new Set<string>();
  return {
    mark(identity, toolName) {
      identities.add(identity);
      toolNames.add(toolName);
    },
    markEligible(toolName) {
      eligibleTools.add(toolName);
    },
    report() {
      if (!observer) return;
      // Report even when nothing was stripped: the observer needs the eligible
      // set to tell an omission from an inapplicable turn.
      if (identities.size === 0 && eligibleTools.size === 0) return;
      observer({
        protocol,
        stream,
        strippedCount: identities.size,
        toolNames: [...toolNames],
        eligibleTools: [...eligibleTools],
      });
    },
  };
}

function selectionHasWork(selection: CfqStripSelection): boolean {
  return selection instanceof Set
    ? selection.size > 0
    : hasInjectedToolCleanup(selection as Record<string, unknown> | null | undefined);
}

function selectionMatches(selection: CfqStripSelection, toolName: string | undefined): boolean {
  if (!toolName) return false;
  return selection instanceof Set
    ? selection.has(toolName)
    : shouldStripInjectedTool(
        selection as Record<string, unknown> | null | undefined,
        toolName,
      );
}

/**
 * Wrap the eligibility test so every match is recorded on the way through.
 *
 * The strippers ask this question at exactly the points where a tool call is
 * identified, which is also the only place that knows a call was eligible even
 * though it turned out to carry nothing. Recording here keeps that knowledge
 * without threading an extra callback through all three protocol strippers.
 */
function trackEligible(
  selection: CfqStripSelection,
  markEligible: (toolName: string) => void,
): ShouldStripTool {
  return (toolName) => {
    if (!selectionMatches(selection, toolName)) return false;
    markEligible(toolName!);
    return true;
  };
}

// -- SSE frame handling -----------------------------------------------------------------

/**
 * An SSE event block. Non-data lines such as `event:` are preserved as-is -- Responses clients dispatch by the `event:` header,
 * and touching it when rebuilding would throw everything off.
 */
interface SseFrame {
  lines: string[];
  dataLineIdx: number;
  dataStr: string;
}

function parseFrame(block: string): SseFrame | null {
  const lines = block.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("data: ")) return { lines, dataLineIdx: i, dataStr: line.slice(6) };
    if (line.startsWith("data:")) return { lines, dataLineIdx: i, dataStr: line.slice(5) };
  }
  return null;
}

/** Rebuild the event block with a new data payload (including the trailing blank line). */
function rebuildFrame(frame: SseFrame, data: unknown): string {
  const lines = frame.lines.slice();
  lines[frame.dataLineIdx] = `data: ${JSON.stringify(data)}`;
  return `${lines.join("\n")}\n\n`;
}

// -- Non-streaming -------------------------------------------------------------------

/** The tool_use block in Anthropic `content[]`. */
function stripAnthropicBody(
  body: Record<string, unknown>,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  const content = body.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const block of content) {
    const b = block as Record<string, unknown> | null;
    if (
      b?.type === "tool_use" &&
      shouldStrip(typeof b.name === "string" ? b.name : undefined) &&
      stripCfqFromInput(b.input)
    ) {
      changed = true;
      mark(typeof b.id === "string" ? b.id : `anthropic:${content.indexOf(block)}`, b.name as string);
    }
  }
  return changed;
}

/** OpenAI Chat `choices[].message.tool_calls[]`. */
function stripChatBody(
  body: Record<string, unknown>,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  const choices = body.choices;
  if (!Array.isArray(choices)) return false;
  let changed = false;
  for (const choice of choices) {
    const message = (choice as Record<string, unknown> | null)?.message as
      | Record<string, unknown>
      | undefined;
    const toolCalls = message?.tool_calls;
    if (!Array.isArray(toolCalls)) continue;
    for (const tc of toolCalls) {
      const fn = (tc as Record<string, unknown> | null)?.function as
        | Record<string, unknown>
        | undefined;
      if (!shouldStrip(typeof fn?.name === "string" ? fn.name : undefined)) continue;
      if (typeof fn?.arguments !== "string") continue;
      const cleaned = stripCfqFromArguments(fn.arguments);
      if (cleaned !== null) {
        fn.arguments = cleaned;
        changed = true;
        const toolName = fn.name as string;
        const toolId = (tc as Record<string, unknown>).id;
        mark(typeof toolId === "string" ? toolId : `openai:${toolName}`, toolName);
      }
    }
  }
  return changed;
}

/** The function_call item in Responses `output[]`. */
function stripResponsesOutput(
  output: unknown,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  if (!Array.isArray(output)) return false;
  let changed = false;
  for (const item of output) {
    const it = item as Record<string, unknown> | null;
    if (it?.type !== "function_call" || typeof it.arguments !== "string") continue;
    if (!shouldStrip(typeof it.name === "string" ? it.name : undefined)) continue;
    const cleaned = stripCfqFromArguments(it.arguments);
    if (cleaned !== null) {
      it.arguments = cleaned;
      changed = true;
      const toolName = it.name as string;
      const identity =
        typeof it.id === "string"
          ? it.id
          : typeof it.call_id === "string"
            ? it.call_id
            : `responses:${toolName}`;
      mark(identity, toolName);
    }
  }
  return changed;
}

function stripResponsesBody(
  body: Record<string, unknown>,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): boolean {
  // Top-level `output[]`, and `response.output[]` (the SSE final frame and some non-streaming wrappers).
  const nested = body.response as Record<string, unknown> | undefined;
  const a = stripResponsesOutput(body.output, shouldStrip, mark);
  const b = nested ? stripResponsesOutput(nested.output, shouldStrip, mark) : false;
  return a || b;
}

/**
 * Strip a non-streaming response body. When nothing changes, returns the original string to avoid pointless re-serialization.
 *
 * Must be called after `notifyUpstreamResponse` -- the side channel wants the model's raw output.
 */
export function stripCfqFromResponseText(
  protocol: CfqStripProtocol,
  text: string,
  selection: CfqStripSelection,
  observer?: CfqStripObserver,
): string {
  if (!text) return text;
  if (!selectionHasWork(selection)) return text;
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
    body = parsed as Record<string, unknown>;
  } catch {
    return text;
  }
  const tracker = createStripTracker(protocol, false, observer);
  const shouldStrip = trackEligible(selection, tracker.markEligible);
  const changed =
    protocol === "anthropic"
      ? stripAnthropicBody(body, shouldStrip, tracker.mark)
      : protocol === "openai"
        ? stripChatBody(body, shouldStrip, tracker.mark)
        : stripResponsesBody(body, shouldStrip, tracker.mark);
  tracker.report();
  return changed ? JSON.stringify(body) : text;
}

// -- Streaming -----------------------------------------------------------------------

/** A held-back fragment event: re-emitted with the full payload once the arguments are complete. */
interface HeldDelta {
  frame: SseFrame;
  evt: Record<string, unknown>;
}

type Emit = (chunk: string) => void;

/**
 * A per-protocol stripper. `flush` is responsible for re-emitting still-held frames when the stream ends -- if the upstream breaks midway,
 * and the held-back frame is lost along with it, the client ends up with a tool_call with empty arguments.
 */
interface Stripper {
  onBlock: (block: string) => void;
  flush: () => void;
}

/**
 * Anthropic: hold frames per block index, settle on `content_block_stop`.
 */
function makeAnthropicStripper(
  emit: Emit,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): Stripper {
  const toolBlocks = new Set<number>();
  const buf = new Map<number, string>();
  const held = new Map<number, HeldDelta>();
  const toolMeta = new Map<number, { id: string; name: string }>();

  /** Re-emit the held-back frame with the payload replaced by `partialJson`. */
  const release = (index: number, partialJson: string): void => {
    const h = held.get(index);
    if (!h) return;
    held.delete(index);
    const delta = h.evt.delta as Record<string, unknown>;
    delta.partial_json = partialJson;
    emit(rebuildFrame(h.frame, h.evt));
  };

  const onBlock = (block: string): void => {
    const frame = parseFrame(block);
    if (!frame || !frame.dataStr || frame.dataStr === "[DONE]") {
      emit(`${block}\n\n`);
      return;
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(frame.dataStr) as Record<string, unknown>;
    } catch {
      emit(`${block}\n\n`);
      return;
    }

    const index = typeof evt.index === "number" ? evt.index : -1;
    const type = evt.type;

    if (type === "content_block_start") {
      const cb = evt.content_block as Record<string, unknown> | undefined;
      const toolName = typeof cb?.name === "string" ? cb.name : undefined;
      if (cb?.type === "tool_use" && index >= 0 && shouldStrip(toolName)) {
        toolBlocks.add(index);
        buf.set(index, "");
        toolMeta.set(index, {
          id: typeof cb.id === "string" ? cb.id : `anthropic:${index}`,
          name: toolName!,
        });
        // `input` is usually {} at this point, but upstreams occasionally include the full arguments directly.
        if (stripCfqFromInput(cb.input)) {
          const meta = toolMeta.get(index)!;
          mark(meta.id, meta.name);
          emit(rebuildFrame(frame, evt));
          return;
        }
      }
      emit(`${block}\n\n`);
      return;
    }

    if (type === "content_block_delta" && toolBlocks.has(index)) {
      const delta = evt.delta as Record<string, unknown> | undefined;
      if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string") {
        buf.set(index, (buf.get(index) ?? "") + delta.partial_json);
        release(index, ""); // Yield: earlier fragments are emitted as empty strings
        held.set(index, { frame, evt });
        return;
      }
      emit(`${block}\n\n`);
      return;
    }

    if (type === "content_block_stop" && toolBlocks.has(index)) {
      const raw = buf.get(index) ?? "";
      const cleaned = stripCfqFromArguments(raw);
      if (cleaned !== null) {
        const meta = toolMeta.get(index);
        if (meta) mark(meta.id, meta.name);
      }
      release(index, cleaned ?? raw);
      toolBlocks.delete(index);
      buf.delete(index);
      toolMeta.delete(index);
      emit(`${block}\n\n`);
      return;
    }

    emit(`${block}\n\n`);
  };

  const flush = (): void => {
    for (const index of [...held.keys()]) {
      const raw = buf.get(index) ?? "";
      const cleaned = stripCfqFromArguments(raw);
      if (cleaned !== null) {
        const meta = toolMeta.get(index);
        if (meta) mark(meta.id, meta.name);
      }
      release(index, cleaned ?? raw);
    }
  };

  return { onBlock, flush };
}

/**
 * Responses: hold frames per item_id, settle on `function_call_arguments.done`.
 * The `output[]` in the final frame must also be cleaned -- the client may only recognize the complete item in the final frame.
 *
 * Three known gaps; the current client (codex) has not exposed problems, so they are not handled for now:
 *   - A held-back frame is only emitted when the next fragment of the same item arrives, so events in between get inserted ahead of it,
 *     making `sequence_number` non-monotonic (especially visible when parallel function_calls interleave).
 *   - Strip eligibility is only registered when `output_item.added` carries `name`; in implementations
 *     where `name` is given later, argument fragments go out with the CFQ intact, and only the one in the final frame is cleaned.
 *   - Terminal events only cover `completed` / `incomplete`; the `output[]` in
 *     `response.failed` is not cleaned.
 */
function makeResponsesStripper(
  emit: Emit,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): Stripper {
  const buf = new Map<string, string>();
  const held = new Map<string, HeldDelta>();
  const eligibleItemIds = new Set<string>();
  const toolMeta = new Map<string, { name: string }>();

  const release = (itemId: string, deltaText: string): void => {
    const h = held.get(itemId);
    if (!h) return;
    held.delete(itemId);
    h.evt.delta = deltaText;
    emit(rebuildFrame(h.frame, h.evt));
  };

  const onBlock = (block: string): void => {
    const frame = parseFrame(block);
    if (!frame || !frame.dataStr || frame.dataStr === "[DONE]") {
      emit(`${block}\n\n`);
      return;
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(frame.dataStr) as Record<string, unknown>;
    } catch {
      emit(`${block}\n\n`);
      return;
    }

    const type = evt.type;
    const itemId = typeof evt.item_id === "string" ? evt.item_id : "";

    if (type === "response.output_item.added") {
      const item = evt.item as Record<string, unknown> | undefined;
      const addedId = typeof item?.id === "string" ? item.id : "";
      const toolName = typeof item?.name === "string" ? item.name : undefined;
      if (item?.type === "function_call" && addedId && shouldStrip(toolName)) {
        eligibleItemIds.add(addedId);
        toolMeta.set(addedId, { name: toolName! });
        if (stripResponsesOutput([item], shouldStrip, mark)) {
          emit(rebuildFrame(frame, evt));
          return;
        }
      }
    } else if (
      type === "response.function_call_arguments.delta" &&
      itemId &&
      eligibleItemIds.has(itemId)
    ) {
      if (typeof evt.delta === "string") {
        buf.set(itemId, (buf.get(itemId) ?? "") + evt.delta);
        release(itemId, "");
        held.set(itemId, { frame, evt });
        return;
      }
    } else if (
      type === "response.function_call_arguments.done" &&
      itemId &&
      eligibleItemIds.has(itemId)
    ) {
      // `.done` carries the authoritative full arguments; fall back to our own assembly only if it is unavailable.
      const raw = typeof evt.arguments === "string" ? evt.arguments : (buf.get(itemId) ?? "");
      const stripped = stripCfqFromArguments(raw);
      const cleaned = stripped ?? raw;
      if (stripped !== null) {
        const meta = toolMeta.get(itemId);
        if (meta) mark(itemId, meta.name);
      }
      release(itemId, cleaned);
      buf.delete(itemId);
      if (typeof evt.arguments === "string" && evt.arguments !== cleaned) {
        evt.arguments = cleaned;
        emit(rebuildFrame(frame, evt));
        return;
      }
    } else if (type === "response.output_item.done") {
      if (stripResponsesOutput([evt.item], shouldStrip, mark)) {
        emit(rebuildFrame(frame, evt));
        return;
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const resp = evt.response as Record<string, unknown> | undefined;
      if (resp && stripResponsesOutput(resp.output, shouldStrip, mark)) {
        emit(rebuildFrame(frame, evt));
        return;
      }
    }

    emit(`${block}\n\n`);
  };

  const flush = (): void => {
    for (const itemId of [...held.keys()]) {
      const raw = buf.get(itemId) ?? "";
      const cleaned = stripCfqFromArguments(raw);
      const meta = toolMeta.get(itemId);
      if (cleaned !== null && meta) mark(itemId, meta.name);
      release(itemId, cleaned ?? raw);
    }
  };

  return { onBlock, flush };
}

/**
 * OpenAI Chat: hold frames by `choice:tool_call` index, settle when the finish chunk arrives.
 *
 * Same approach as the other two protocols (see the file header comment): no chunks are fabricated; only the contents of
 * `function.arguments` in the held-back frame are changed. Chat's fragmented tool_call entries are allowed to carry only `index` +
 * `function.arguments`, but the client is picky about "shapes it has not seen" (CodeBuddy validates tool_call by
 * `type`), and a re-emitted chunk missing one field would be judged invalid; holding frames guarantees
 * that every frame the client receives is identical to the upstream's as-is.
 */
function makeChatStripper(
  emit: Emit,
  shouldStrip: ShouldStripTool,
  mark: MarkStripped,
): Stripper {
  /** Held-back chat chunk: one frame may carry fragments of multiple tool_calls at once. */
  interface HeldChunk {
    frame: SseFrame;
    evt: Record<string, unknown>;
    /** key -> the `function` object in that frame carrying the arguments; the cleaned full arguments are written into it at settlement. */
    slots: Map<string, Record<string, unknown>>;
  }

  const buf = new Map<string, string>();
  const eligible = new Set<string>();
  const toolNameOf = new Map<string, string>();
  const toolIdOf = new Map<string, string>();
  const heldOrder: HeldChunk[] = [];
  const heldByKey = new Map<string, HeldChunk>();

  const emitHeld = (held: HeldChunk): void => {
    const at = heldOrder.indexOf(held);
    if (at >= 0) heldOrder.splice(at, 1);
    for (const key of held.slots.keys()) {
      if (heldByKey.get(key) === held) heldByKey.delete(key);
    }
    emit(rebuildFrame(held.frame, held.evt));
  };

  /** Write the cleaned, fully collected arguments back into the held-back fragment. */
  const settle = (key: string, fn: Record<string, unknown>): void => {
    const raw = buf.get(key) ?? "";
    const cleaned = stripCfqFromArguments(raw);
    if (cleaned !== null) {
      const toolName = toolNameOf.get(key);
      if (toolName) mark(toolIdOf.get(key) ?? key, toolName);
    }
    fn.arguments = cleaned ?? raw;
    buf.delete(key);
    eligible.delete(key);
  };

  const flush = (): void => {
    for (const held of [...heldOrder]) {
      for (const [key, fn] of held.slots) settle(key, fn);
      emitHeld(held);
    }
  };

  const onBlock = (block: string): void => {
    const frame = parseFrame(block);
    if (!frame || !frame.dataStr) {
      emit(`${block}\n\n`);
      return;
    }
    if (frame.dataStr === "[DONE]") {
      flush();
      emit(`${block}\n\n`);
      return;
    }

    let evt: Record<string, unknown>;
    try {
      evt = JSON.parse(frame.dataStr) as Record<string, unknown>;
    } catch {
      emit(`${block}\n\n`);
      return;
    }

    const choices = evt.choices;
    if (!Array.isArray(choices)) {
      emit(`${block}\n\n`);
      return;
    }

    let current: HeldChunk | null = null;
    let finished = false;
    for (const choice of choices) {
      const ch = choice as Record<string, unknown> | null;
      if (!ch) continue;
      if (ch.finish_reason !== null && ch.finish_reason !== undefined) finished = true;
      const delta = ch.delta as Record<string, unknown> | undefined;
      const toolCalls = delta?.tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      const choiceIndex = typeof ch.index === "number" ? ch.index : 0;
      for (const tc of toolCalls) {
        const t = tc as Record<string, unknown> | null;
        const fn = t?.function as Record<string, unknown> | undefined;
        if (!t) continue;
        // Relies on the upstream giving index (mandatory in the chat streaming spec). If really missing, parallel tool_calls would
        // collapse into the same key and their arguments get concatenated together -- all upstreams currently provide it, so no extra fallback for now.
        const tcIndex = typeof t.index === "number" ? t.index : 0;
        const key = `${choiceIndex}:${tcIndex}`;
        const toolName = typeof fn?.name === "string" ? fn.name : undefined;
        if (toolName && shouldStrip(toolName)) {
          eligible.add(key);
          toolNameOf.set(key, toolName);
        }
        if (typeof t.id === "string") toolIdOf.set(key, t.id);
        if (!eligible.has(key) || typeof fn?.arguments !== "string" || fn.arguments === "") {
          continue;
        }
        buf.set(key, (buf.get(key) ?? "") + fn.arguments);

        // Yield: when a new fragment of the same tool_call arrives, the earlier fragment is always replaced with an empty string.
        // When two fragments land in the same frame, only the payload can be replaced; the frame cannot be sent early -- it is still in hand,
        // and sending early would leak the uncleaned original, then settlement would send the whole frame again.
        const previous = heldByKey.get(key);
        if (previous) {
          const slot = previous.slots.get(key);
          if (slot) slot.arguments = "";
          if (previous !== current) {
            previous.slots.delete(key);
            heldByKey.delete(key);
            if (previous.slots.size === 0) emitHeld(previous);
          }
        }

        current ??= { frame, evt, slots: new Map() };
        current.slots.set(key, fn);
        heldByKey.set(key, current);
      }
    }

    if (current) {
      if (finished) {
        // The closing frame itself carries the last batch of fragments: first settle the earlier held-back frames, then emit itself as-is.
        flush();
        for (const [key, fn] of current.slots) settle(key, fn);
        for (const key of current.slots.keys()) heldByKey.delete(key);
        emit(rebuildFrame(frame, evt));
        return;
      }
      heldOrder.push(current);
      return;
    }

    // Settlement must come before the finish chunk, otherwise the client has already wrapped up.
    if (finished) flush();
    emit(`${block}\n\n`);
  };

  return { onBlock, flush };
}

/**
 * The client-direction CFQ stripping stream. Attached at the last mile of the response, leaving the tap path unaffected.
 */
export function createCfqStripStream(
  protocol: CfqStripProtocol,
  selection: CfqStripSelection,
  observer?: CfqStripObserver,
): TransformStream<Uint8Array, Uint8Array> {
  // No schema was extended in this request: preserve chunk boundaries and
  // bytes exactly. Besides avoiding needless buffering, this protects tools
  // that legitimately own a field with the same name.
  if (!selectionHasWork(selection)) {
    return new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(chunk);
      },
    });
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let sseBuf = "";
  const tracker = createStripTracker(protocol, true, observer);
  const shouldStrip = trackEligible(selection, tracker.markEligible);

  // `emit` is rebound to the current controller on every callback; the stripper itself does not hold the controller.
  let emit: Emit = () => {};
  const forward: Emit = (text) => emit(text);
  const stripper =
    protocol === "anthropic"
      ? makeAnthropicStripper(forward, shouldStrip, tracker.mark)
      : protocol === "responses"
        ? makeResponsesStripper(forward, shouldStrip, tracker.mark)
        : makeChatStripper(forward, shouldStrip, tracker.mark);

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      emit = (text) => controller.enqueue(encoder.encode(text));
      sseBuf += decoder.decode(chunk, { stream: true });

      // SSE accepts LF and CRLF line endings. Normalise rewritten frames to LF;
      // inactive requests took the byte-for-byte passthrough branch above.
      const parts = sseBuf.split(/\r?\n\r?\n/);
      sseBuf = parts.pop() ?? "";
      for (const part of parts) {
        if (part !== "") stripper.onBlock(part);
      }
    },
    flush(controller) {
      emit = (text) => controller.enqueue(encoder.encode(text));
      // First settle the held-back frames, then spit out the leftover half-frame as-is -- the leftover must be an incomplete event,
      // and handing it to the stripper would only append an event terminator that should not be there.
      stripper.flush();
      if (sseBuf) controller.enqueue(encoder.encode(sseBuf));
      tracker.report();
    },
  });
}
