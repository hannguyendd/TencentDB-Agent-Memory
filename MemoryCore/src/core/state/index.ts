/**
 * State Backend — interface + default implementation exports + backend factory.
 *
 * The default implementation (LocalStateBackend) lives in core alongside the interface and works out of the box.
 * Remote state backends are dynamically loaded at runtime on demand; if the current build does not include the corresponding implementation,
 * an explicit error is thrown when the configuration requires a remote backend.
 */

export type {
  IStateBackend,
  PipelineSessionState,
  TimerEntry,
  TaskPayload,
  CaptureAtomicParams,
  CaptureAtomicResult,
} from "./types.js";
export { DEFAULT_PIPELINE_STATE } from "./types.js";

export { LocalStateBackend } from "./local-backend.js";

import type { IStateBackend, TimerEntry } from "./types.js";
import { LocalStateBackend } from "./local-backend.js";

export interface StateBackendConfig {
  type: "local" | "redis";
  local?: {
    onTimerExpired?: (entry: TimerEntry) => void;
  };
  redis?: {
    /** backend connection URL */
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    /** database index (default: 0) */
    db?: number;
    keyPrefix?: string;
    consumerGroup?: string;
  };
}

/**
 * Factory function: creates the corresponding State Backend according to the configuration.
 *
 * - type === "local": built-in LocalStateBackend, zero external dependencies
 * - remote backend: dynamically loads the remote state backend implementation; if the current build does not include it,
 *   throws an explicit error.
 */
export async function createStateBackend(config: StateBackendConfig): Promise<IStateBackend> {
  if (config.type === "redis") {
    const redisCfg = config.redis;
    if (!redisCfg) throw new Error("redis config is required when state_backend=redis");

    let RedisStateBackendCtor: typeof import("../../integrations/redis/index.js").RedisStateBackend;
    try {
      ({ RedisStateBackend: RedisStateBackendCtor } = await import("../../integrations/redis/index.js"));
    } catch (err) {
      throw new Error(
        "[state-backend] Redis integration is not available — install or initialize " +
        "src/integrations/redis/ (private submodule) to use state_backend=redis, " +
        "or switch to state_backend=local. " +
        `Original error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Dynamically import the remote backend client only when needed.
    const { default: Redis } = await import("ioredis");

    let client;
    if (redisCfg.url) {
      client = new Redis(redisCfg.url);
    } else {
      client = new Redis({
        host: redisCfg.host ?? "127.0.0.1",
        port: redisCfg.port ?? 6379,
        password: redisCfg.password,
        db: redisCfg.db ?? 0,
      });
    }

    const backend = new RedisStateBackendCtor({
      client: client as never,
      keyPrefix: redisCfg.keyPrefix,
      consumerGroup: redisCfg.consumerGroup,
    });
    await backend.initialize();
    return backend;
  }

  // default: local
  const backend = new LocalStateBackend(config.local);
  await backend.initialize?.();
  return backend;
}
