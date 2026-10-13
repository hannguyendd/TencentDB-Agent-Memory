/**
 * wire.ts — handler wiring entry point for skill conversation-add.
 *
 * After the 2026-07-30 pooling refactor:
 *   - the old wireConversationAdd (per-instance handler + per-instance worker) has been removed.
 *   - for each instance the gateway calls wireConversationAddHandler to build only handler/trigger/sink/buffer,
 *     and workers are managed by the single process-wide SkillWorkerPool.
 */

import type { StorageAdapter } from "../../storage/adapter.js";
import type { ISkillExtractor, ExtractorLogger } from "../queue/types.js";

import { SkillBufferStorage } from "./buffer-storage.js";
import {
  LocalSkillAgentTaskQueue,
  RedisSkillAgentTaskQueue,
  type ISkillAgentTaskQueue,
  type RedisLike as AgentQueueRedisLike,
} from "./agent-task-queue.js";
import { SkillTriggerService } from "./trigger-service.js";
import { SkillConversationAddHandler, type HandlerThresholds } from "./add-handler.js";
import type { CompressOptions } from "./message-compressor.js";
import type { OversizeOptions } from "./oversize-strategy.js";
import type { SkillCandidatesSink } from "./extract-worker.js";
import { SkillCoreSink, type MetadataServiceLike } from "./skill-core-sink.js";

export interface WireConversationAddDeps {
  storage: StorageAdapter;
  /** Production: ioredis client; tests: LocalSkillAgentTaskQueue is injected directly into `queue`, overriding this */
  redis?: AgentQueueRedisLike;
  /** Queue injected by tests; if omitted, a RedisSkillAgentTaskQueue is constructed from redis */
  queue?: ISkillAgentTaskQueue;
  /** Redis key prefix, default "skill" — aligned with design doc §5 */
  redisKeyPrefix?: string;

  /**
   * The metadata service the sink needs to register skill assets as a fallback (idempotent).
   * When omitted the sink is a no-op — the skill has already been persisted by the extractor's tool-call,
   * but the frontend control page may not show it (in standalone mode there is no onSkillCreated hook).
   */
  metadataService?: MetadataServiceLike;

  /**
   * Retained for compatibility with the old signature (wireConversationAddHandler does not use the extractor internally;
   * the real extraction is fetched on demand by SkillWorkerPool's resolveExtractor). The gateway side currently
   * puts in a noop placeholder.
   */
  extractor: ISkillExtractor;

  logger: ExtractorLogger;

  /** Handler threshold overrides */
  thresholds?: Partial<HandlerThresholds>;

  /** Per-tool-message head/tail compression rule overrides (corresponds to SkillConfig.compress). */
  compressOptions?: Partial<CompressOptions>;

  /** Fallback splitting parameter overrides (corresponds to chunkMaxBytes / headKeepBytes / tailKeepBytes derived from SkillConfig.extraction). */
  oversizeOptions?: Partial<OversizeOptions>;

  /** COS sub-path (default "skill_buffer") */
  bufferSubPath?: string;
}

/**
 * Builds only the 4-piece set the handler needs (handler / trigger / sink / buffer) +
 * queue (dispatched by redis/in-memory if not injected). **Does not start workers**.
 *
 * Process-wide workers are managed uniformly by SkillWorkerPool; the first time the gateway accesses each instance
 * it calls this function to get the handler bundle, puts it in the in-flight cache, and reuses it afterwards.
 */
export interface WiredConversationAddHandler {
  handler: SkillConversationAddHandler;
  trigger: SkillTriggerService;
  sink: SkillCandidatesSink;
  queue: ISkillAgentTaskQueue;
  buffer: SkillBufferStorage;
}

export function wireConversationAddHandler(
  deps: WireConversationAddDeps,
): WiredConversationAddHandler {
  const buffer = new SkillBufferStorage({
    storage: deps.storage,
    subPath: deps.bufferSubPath,
  });

  let queue: ISkillAgentTaskQueue;
  if (deps.queue) {
    queue = deps.queue;
  } else if (deps.redis) {
    queue = new RedisSkillAgentTaskQueue({
      client: deps.redis,
      keyPrefix: deps.redisKeyPrefix ?? "skill",
    });
  } else {
    // degradation without Redis: only usable in standalone single-machine scenarios
    queue = new LocalSkillAgentTaskQueue();
    deps.logger.warn(
      "[skill-conversation-add] no redis nor queue injected — falling back to in-memory queue (single-node only)",
    );
  }

  const trigger = new SkillTriggerService({ buffer, queue });
  const handler = new SkillConversationAddHandler({
    buffer,
    trigger,
    thresholds: deps.thresholds,
    compressOptions: deps.compressOptions,
    oversizeOptions: deps.oversizeOptions,
  });

  const sink = new SkillCoreSink({
    metadata: deps.metadataService,
    logger: deps.logger,
  });

  return { handler, trigger, sink, queue, buffer };
}
