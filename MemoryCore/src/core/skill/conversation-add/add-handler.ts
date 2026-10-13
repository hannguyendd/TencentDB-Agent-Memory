/**
 * SkillConversationAddHandler — §7 Handler main flow.
 *
 * Handles `POST /v3/skill/conversation/add`:
 *   ① validate required fields + role
 *   ② compute raw_bytes
 *   ③ route by path: normal (< requestCompressThreshold) / compressed (≥) / oversize (> chunkMax after concatenation)
 *   ④ concatenate data-current and accumulate counters
 *   ⑤ check thresholds → trigger archiving (SkillTriggerService)
 *   ⑥ write back data-current + meta
 */

import {
  DEFAULT_COMPRESS_OPTIONS,
  type CompressibleMessage,
  type CompressOptions,
  type CompressibleRole,
} from "./message-compressor.js";
import {
  DEFAULT_OVERSIZE_OPTIONS,
  type OversizeMessage,
  type OversizeOptions,
} from "./oversize-strategy.js";
import { prepareArchivePayload } from "./prepare-archive.js";
import type { SkillBufferStorage, SessionKey, SessionMeta } from "./buffer-storage.js";
import type { SkillTriggerService } from "./trigger-service.js";
import { obsLogger } from "../../report/obs-logger.js";

const VALID_ROLES: ReadonlySet<CompressibleRole> = new Set([
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "system",
]);

/**
 * The set of roles counted toward the archive threshold `tool_call_count`.
 *
 * **Only `tool_call` is counted, not `tool_result`.** The two are naturally paired 1:1 (every
 * time the agent calls a tool a result comes back), so counting both doubles the count, and users would
 * observe "the agent archives after 5 tool calls" — not the 10 in the configuration at all.
 *
 * Specifically, in VALID_ROLES "tool_call" is the call the agent actively initiates,
 * and "tool_result" is the paired return. The semantics of the archive trigger is "number of times the agent uses tools",
 * so only the call side is counted.
 *
 * The validation path (in validate()) still requires tool_call_id for both tool_call and tool_result
 * — that is a **structural validity** check, unrelated to counting; two different things.
 */
const TOOL_CALL_ROLES: ReadonlySet<CompressibleRole> = new Set(["tool_call"]);

/** The set of roles that need tool_call_id during validation (call and result both carry the pairing anchor). */
const TOOL_PAIR_ROLES: ReadonlySet<CompressibleRole> = new Set(["tool_call", "tool_result"]);

const ID_FORBIDDEN_CHAR = "|";

export interface AddConversationInput {
  /**
   * Added 2026-07-30: multi-tenant instance ID. Passed through into the AgentTuple so the worker pool,
   * on dequeue, can dynamically resolve the CoS/VDB/LLM resources of the corresponding instance by instance_id.
   * In standalone mode the gateway falls back to "default". If missing, it is rejected at the validate stage.
   */
  instance_id: string;
  session_id: string;
  space_id: string;
  user_id: string;
  team_id: string;
  agent_id: string;
  /** Business-side task reference, passed through to task.task_ref_id when the archive is persisted. */
  task_id?: string;
  messages: CompressibleMessage[];
  /**
   * Extraction mode; passed as 'strict' only when the upstream handler receives body.strict_mode:true.
   * The archive stage passes it through SkillTriggerService.archive({mode}) → SkillTaskEntry.mode
   * → Worker → SkillExtractor.extract({mode:'strict'}) → uses the STRICT prompt.
   * Omitted means the default (SKILL_REVIEW_PROMPT v2, lenient), fully compatible with old clients.
   */
  mode?: 'strict';
  /**
   * req_id of the upstream HTTP handler, used by obsLogger segment events to correlate the chain.
   * If omitted, events just lack a req_id field; business logic is unaffected.
   */
  perfRequestId?: string;
}

export interface AddConversationResult {
  /** Semantic status: ok = normal append / archived = archiving was triggered. */
  status: "ok" | "archived";
  archived?: {
    task_id: string;
    archived_at_ms: number;
    archive_key: string;
    /** Triggered when normal reaches the threshold / compressed always triggers / oversize triggers after fallback */
    reason: "tool_calls" | "bytes" | "compressed" | "oversize";
  };
}

export interface HandlerThresholds {
  /** tool_call cumulative threshold. Default 10. */
  toolCallThreshold: number;
  /** Cumulative byte threshold. Default 40960 (40KB). */
  bytesThreshold: number;
  /** When this add's bytes ≥ this value, take the compression path. Default 40960. */
  requestCompressThresholdBytes: number;
}

export const DEFAULT_HANDLER_THRESHOLDS: HandlerThresholds = {
  toolCallThreshold: 10,
  bytesThreshold: 40 * 1024,
  requestCompressThresholdBytes: 40 * 1024,
};

export interface SkillConversationAddHandlerOptions {
  buffer: SkillBufferStorage;
  trigger: SkillTriggerService;
  thresholds?: Partial<HandlerThresholds>;
  compressOptions?: Partial<CompressOptions>;
  oversizeOptions?: Partial<OversizeOptions>;
  now?: () => number;
}

export class HandlerValidationError extends Error {
  constructor(public readonly field: string, message: string) {
    super(message);
    this.name = "HandlerValidationError";
  }
}

export class SkillConversationAddHandler {
  private readonly buffer: SkillBufferStorage;
  private readonly trigger: SkillTriggerService;
  private readonly thresholds: HandlerThresholds;
  private readonly compressOptions: CompressOptions;
  private readonly oversizeOptions: OversizeOptions;
  private readonly now: () => number;

  constructor(opts: SkillConversationAddHandlerOptions) {
    this.buffer = opts.buffer;
    this.trigger = opts.trigger;
    this.thresholds = { ...DEFAULT_HANDLER_THRESHOLDS, ...opts.thresholds };
    this.compressOptions = { ...DEFAULT_COMPRESS_OPTIONS, ...opts.compressOptions };
    this.oversizeOptions = { ...DEFAULT_OVERSIZE_OPTIONS, ...opts.oversizeOptions };
    this.now = opts.now ?? (() => Date.now());
  }

  async handle(input: AddConversationInput): Promise<AddConversationResult> {
    // [obs] handler-internal segments: readBuffer / prepareArchive / trigger.archive / writeBack.
    // Runs on the obsLogger foundation (structured events + FileLogger + ClickHouse backend),
    // correlating the full chain with the upstream handleConversationAdd + trigger + worker via req_id.
    const rid = input.perfRequestId;

    // ① validate
    this.validate(input);
    const sess: SessionKey = {
      instance_id: input.instance_id,
      space_id: input.space_id,
      user_id: input.user_id,
      team_id: input.team_id,
      agent_id: input.agent_id,
      session_id: input.session_id,
    };

    // ② compute raw_bytes
    const rawBytes = totalMessagesBytes(input.messages);

    // ③ route by path: read current state + use the shared helper for compression + fallback
    const useCompress = rawBytes >= this.thresholds.requestCompressThresholdBytes;
    const t0Buf = Date.now();
    const [current, meta] = await Promise.all([
      this.buffer.readCurrent(sess),
      this.buffer.readMeta(sess),
    ]);
    obsLogger.info("skill.add_handler.read_buffer", {
      req_id: rid, session_id: input.session_id, instance_id: input.instance_id,
      dur_ms: Date.now() - t0Buf,
      current_msgs: current.messages.length,
      raw_bytes: rawBytes,
      use_compress: useCompress,
    });

    // Semantics specific to conversation-add: only the compression path takes the oversize fallback (see the comment below for the original implementation);
    // when using the helper, forceCompress=useCompress; when useCompress=false the helper internally
    // also won't take applyOversizeStrategy — because on the normal path combinedBytes should not be > chunkMax
    // (in that case rawBytes would already be >= requestCompressThresholdBytes and have taken the compression path).
    // The oversize determination in the helper is semantically equivalent to the original implementation: both are "combined > chunkMax".
    const t0Prep = Date.now();
    const prepared = prepareArchivePayload(
      current.messages as OversizeMessage[],
      input.messages,
      {
        compress: this.compressOptions,
        oversize: this.oversizeOptions,
        forceCompress: useCompress,
      },
    );
    obsLogger.info("skill.add_handler.prepare_archive", {
      req_id: rid, session_id: input.session_id, instance_id: input.instance_id,
      dur_ms: Date.now() - t0Prep,
      msg_in: input.messages.length,
      msg_out: prepared.messages.length,
      used_oversize: prepared.usedOversize,
    });
    const combinedMessages: OversizeMessage[] = prepared.messages;
    const usedOversize = prepared.usedOversize;

    // ④ update meta counters
    // Count only tool_call, not tool_result — the two are paired 1:1, counting both would make a threshold of 10
    // effectively "archive after 5 tool calls", violating the configuration semantics. See the TOOL_CALL_ROLES comment for details.
    const addedToolCalls = countRoles(input.messages, TOOL_CALL_ROLES);
    const nextTool = meta.tool_call_count + addedToolCalls;
    const nextBytes = meta.byte_count + rawBytes;

    // ⑤ threshold check
    const hitTool = nextTool >= this.thresholds.toolCallThreshold;
    const hitBytes = nextBytes >= this.thresholds.bytesThreshold;
    const shouldArchive = useCompress || hitTool || hitBytes;

    let result: AddConversationResult = { status: "ok" };

    if (shouldArchive) {
      // archive segment
      const reason: NonNullable<AddConversationResult["archived"]>["reason"] = usedOversize
        ? "oversize"
        : useCompress
          ? "compressed"
          : hitTool
            ? "tool_calls"
            : "bytes";

      const t0Arch = Date.now();
      const archiveRes = await this.trigger.archive({
        session: sess,
        bufferAtTrigger: { messages: combinedMessages as Array<Record<string, unknown>> },
        taskRefId: input.task_id,
        // strict_mode passthrough: input.mode has a value only when the upstream handler receives body.strict_mode:true,
        // going through trigger → SkillTaskEntry.mode → Worker → SkillExtractor STRICT prompt.
        // Omitted means the default; old clients see not a single byte of change.
        ...(input.mode ? { mode: input.mode } : {}),
        // pass req_id through to the trigger's internal segment events (write_archive / mutex_* / enqueue_agent)
        perfRequestId: input.perfRequestId,
      });
      obsLogger.info("skill.add_handler.trigger_archive", {
        req_id: rid, session_id: input.session_id, instance_id: input.instance_id, instance_id: input.instance_id,
        dur_ms: Date.now() - t0Arch,
        task_id: archiveRes.taskId,
        archive_key: archiveRes.archiveKey,
        reason,
      });

      // after archiving, clear data-current + counters
      const nowMs = this.now();
      const nextMeta: SessionMeta = {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: 0,
        byte_count: 0,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: archiveRes.archivedAtMs,
      };

      const t0Wb = Date.now();
      await Promise.all([
        this.buffer.writeCurrent(sess, { messages: [] }),
        this.buffer.writeMeta(sess, nextMeta),
      ]);
      obsLogger.info("skill.add_handler.write_back", {
        req_id: rid, session_id: input.session_id, instance_id: input.instance_id, instance_id: input.instance_id,
        dur_ms: Date.now() - t0Wb,
        archived: true,
      });

      result = {
        status: "archived",
        archived: {
          task_id: archiveRes.taskId,
          archived_at_ms: archiveRes.archivedAtMs,
          archive_key: archiveRes.archiveKey,
          reason,
        },
      };
    } else {
      // archiving not triggered: write the concatenated data-current straight back
      const nowMs = this.now();
      const nextMeta: SessionMeta = {
        session_id: sess.session_id,
        space_id: sess.space_id,
        user_id: sess.user_id,
        team_id: sess.team_id,
        agent_id: sess.agent_id,
        tool_call_count: nextTool,
        byte_count: nextBytes,
        last_appended_at_ms: nowMs,
        last_archived_at_ms: meta.last_archived_at_ms,
      };
      const t0Wb = Date.now();
      await Promise.all([
        this.buffer.writeCurrent(sess, { messages: combinedMessages as Array<Record<string, unknown>> }),
        this.buffer.writeMeta(sess, nextMeta),
      ]);
      obsLogger.info("skill.add_handler.write_back", {
        req_id: rid, session_id: input.session_id, instance_id: input.instance_id, instance_id: input.instance_id,
        dur_ms: Date.now() - t0Wb,
        archived: false,
        tool_count: nextTool,
        byte_count: nextBytes,
      });
    }

    return result;
  }

  private validate(input: AddConversationInput): void {
    const required: Array<keyof AddConversationInput> = [
      "instance_id",
      "session_id",
      "space_id",
      "user_id",
      "team_id",
      "agent_id",
    ];
    for (const f of required) {
      const v = input[f];
      if (typeof v !== "string" || v.length === 0) {
        throw new HandlerValidationError(String(f), `${String(f)} is required and must be non-empty string`);
      }
      if ((v as string).includes(ID_FORBIDDEN_CHAR)) {
        throw new HandlerValidationError(
          String(f),
          `${String(f)} must not contain '|' (reserved for agent tuple)`,
        );
      }
    }
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
      throw new HandlerValidationError("messages", "messages must be a non-empty array");
    }
    for (let i = 0; i < input.messages.length; i++) {
      const m = input.messages[i]!;
      if (!VALID_ROLES.has(m.role as CompressibleRole)) {
        throw new HandlerValidationError(`messages[${i}].role`, `invalid role: ${m.role}`);
      }
      if (typeof m.content !== "string") {
        throw new HandlerValidationError(`messages[${i}].content`, "content must be string");
      }
      if (TOOL_PAIR_ROLES.has(m.role as CompressibleRole)) {
        // tool_call_id is **required** (tool_call and tool_result are paired through it)
        // tool_name is **optional**: the Anthropic protocol's tool_use block has a name, while the OpenAI protocol's
        //   role=tool message itself has no tool_name field, only tool_call_id. Requiring tool_name
        //   would force the proxy side to look up assistant.tool_calls in reverse to fill it in, a detour caused by
        //   protocol differences; simply relax it to optional (for skill extraction, the content is what matters).
        if (typeof m.tool_call_id !== "string" || m.tool_call_id.length === 0) {
          throw new HandlerValidationError(
            `messages[${i}].tool_call_id`,
            "tool_call/tool_result must carry tool_call_id",
          );
        }
        if (m.tool_name !== undefined && (typeof m.tool_name !== "string" || m.tool_name.length === 0)) {
          throw new HandlerValidationError(
            `messages[${i}].tool_name`,
            "tool_name if provided must be non-empty string",
          );
        }
      }
    }
  }
}

function totalMessagesBytes(msgs: CompressibleMessage[]): number {
  let sum = 0;
  for (const m of msgs) {
    sum += Buffer.byteLength(JSON.stringify(m), "utf8");
  }
  return sum;
}

function countRoles(msgs: CompressibleMessage[], roles: ReadonlySet<CompressibleRole>): number {
  let n = 0;
  for (const m of msgs) if (roles.has(m.role as CompressibleRole)) n++;
  return n;
}
