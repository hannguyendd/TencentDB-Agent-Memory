/**
 * TDAI Gateway — Configuration management.
 *
 * Reads gateway configuration from:
 * 1. `tdai-gateway.yaml` (or JSON) in CWD or data dir
 * 2. Environment variables (override individual fields)
 *
 * Minimal config: just LLM API credentials. Everything else has sensible defaults.
 */

import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { getEnv } from "../utils/env.js";
import { parseConfig as parseMemoryConfig } from "../config.js";
import type { MemoryTdaiConfig } from "../config.js";
import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
// v2.6 Plan E fallback: constant used when yaml does not configure supportedAgents
import { DEFAULT_SUPPORTED_AGENTS_FALLBACK } from "../metadata/default-supported-agents.js";

// ============================
// Gateway config types
// ============================

/**
 * Deployment mode determines how the system manages state and coordination:
 *
 * - "standalone": Open-source single-node mode.
 *     Pipeline state lives in-process (Map/setTimeout/SerialQueue).
 *     No external dependencies beyond LLM API and optional VDB.
 *     Suitable for single-machine / sidecar / developer setups.
 *
 * - "service": Cloud service (multi-tenant) mode.
 *     Pipeline state is externalized through IStateBackend.
 *     Timer Scanner + Pipeline Worker run inside the gateway process.
 *     Supports multi-replica coordination and HA.
 *     May require deployment-specific remote backends.
 */
export type DeployMode = "standalone" | "service";

/**
 * FS-dimension backend selection (dimension ②, symmetric to STORE_MODE for DB).
 *
 * - `local` — LocalStorageBackend (filesystem under data.baseDir)
 * - `cos`   — per-instance CosStorageBackend
 * - `rowfs` — ProfileRowStorageBackend over a profile-row-capable store
 *             (requires STORE_MODE whose store serves profile rows; the
 *             combination is validated at assembly, not here)
 *
 * env: `FILE_STORE_MODE`; yaml: `data.fileStore`. Default by deploy mode
 * (§5.3.1): service → cos, standalone → local.
 */
export type FileStoreMode = "local" | "cos" | "rowfs";

/**
 * Backend for the composite's non-profile key space ("others") when
 * `fileStore === "rowfs"` (env `FILE_STORE_OTHERS` / yaml
 * `data.fileStoreOthers`). `mongofs` keeps every byte in the instance's
 * Mongo database (the TCS zero-disk form) and is only legal with
 * STORE_MODE=mongodb — validated by the selection layer, not here.
 */
export type FileStoreOthersMode = "local" | "cos" | "mongofs";

/**
 * Resolve the P9 kill switch (`TDAI_BACKEND_RESOLVER` / `features.backendResolver`).
 *
 * Default `true`: the assembly layer resolves backends through the
 * `BackendResolver` selection layer. Set to `off`/`false`/`0` to fall back to
 * the legacy global-mode branches (R1 mitigation: keep the switch for the old branches). Invalid values
 * fail fast, consistent with {@link resolveFileStoreMode}.
 */
export function resolveBackendResolverFlag(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  if (v === "off" || v === "false" || v === "0") return false;
  if (v === "on" || v === "true" || v === "1") return true;
  throw new Error(
    `invalid TDAI_BACKEND_RESOLVER/features.backendResolver: ${JSON.stringify(raw)} (expected on/off)`,
  );
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
  db: number;
  keyPrefix: string;
}

export interface SharkConfig {
  baseUrl?: string;
  vdbTtlMs: number;
  cosBufferMs: number;
  maxInstances: number;
}

export interface ScannerConfig {
  instances: string;
  instancesSharkUrl?: string;
  intervalMs: number;
  nodeId?: string;
}

export interface WorkerConfig {
  pollMs: number;
  /** Number of concurrent consumer coroutines (default: 60) */
  concurrency: number;
  /** Distributed execution lock TTL. */
  lockTtlMs?: number;
  /** Idle time before a PEL message can be taken over; must be greater than lockTtlMs. */
  pendingStaleMs?: number;
  /** PEL stale scan interval. */
  pendingRecoveryIntervalMs?: number;
  /** PEL heartbeat interval for parked/lock-free in-flight tasks. */
  parkedClaimHeartbeatMs?: number;
  /** Upper limit of scopes retrying lock acquisition at the same time. */
  lockRetryConcurrency?: number;
  /** Upper limit of lock-conflict parking; when not configured, PipelineWorker computes it from the concurrency. */
  maxParkedTasks?: number;
}

export interface CosExtraConfig {
  domain?: string;
  /** Generation log retention in days. Default: 30. Set 0 to disable lifecycle management. */
  generationLogRetentionDays: number;
}

export interface KafkaConfig {
  /** Whether to enable Kafka (default: false) */
  enabled: boolean;
  /** Kafka broker list (comma-separated) */
  brokers: string;
  /** Topic name (default: "memory_monitor") */
  topic: string;
  /** Consumer group ID (used by Consumers only, such as Monitor) */
  groupId?: string;
  /** Total number of partitions (used by Producers only, for hash partitioning) */
  totalPartitions?: number;
}

export interface OTelConfig {
  /** Whether to enable the OTel SDK (default: false) */
  enabled: boolean;
  /** Collector endpoint (default: http://localhost:4317) */
  endpoint: string;
  /** Protocol: "grpc" | "http/protobuf" (default: "grpc") */
  protocol: "grpc" | "http/protobuf";
  /** OTLP request headers, used for authentication etc., in key=value comma-separated format */
  headers?: string;
  /** Service name (default: "core") */
  serviceName: string;
  /** Service version */
  serviceVersion: string;
  /** Instance identifier */
  instanceId?: string;
  /** Zhiyan APM tenant ID */
  tenantId: string;
  /** Metric export interval (seconds, default: 60) */
  metricExportInterval?: number;
  /** Log export interval (seconds, default: 5) */
  logExportInterval: number;
}

export interface ClickHouseConfig {
  /** Whether to enable ClickHouse dual write (default: false) */
  enabled: boolean;
  /** ClickHouse HTTP endpoint */
  endpoint: string;
  /** Username */
  username: string;
  /** Password */
  password: string;
  /** Database name */
  database: string;
  /** Target table name to write to (used by Monitor; other components may leave it empty) */
  table?: string;
  /** Maximum number of entries per batch write */
  maxBatchSize?: number;
  /** Flush interval (seconds) */
  flushInterval?: number;
  /** Maximum length of the buffer queue; data is dropped when exceeded */
  maxQueueSize?: number;
}

export interface LangfuseConfig {
  /** Whether to enable Langfuse LLM trace reporting (default: false) */
  enabled: boolean;
  /** Langfuse instance address (e.g. http://langfuse.example.local:3000) */
  host: string;
  /** Langfuse public key */
  publicKey: string;
  /** Langfuse secret key */
  secretKey: string;
}

/**
 * Observability config (unified format, shared by the four components).
 * Each component enables the corresponding sub-config as needed; unused sub-configs just stay enabled=false.
 *
 * Each sub-config is enabled according to deployment needs; unused sub-configs just stay enabled=false.
 *
 * yaml example:
 * ```yaml
 * observability:
 *   otel:
 *     enabled: true
 *     endpoint: "http://otel.example.com:4317"
 *     protocol: "grpc"
 *     serviceName: "core"
 *     serviceVersion: "1.0.0"
 *     tenantId: "<APM_TENANT_ID>"
 *     metricExportInterval: 60
 *     logExportInterval: 5
 *   clickhouse:
 *     enabled: true
 *     endpoint: "http://clickhouse.example.local:8123"
 *     username: "default"
 *     password: "xxx"
 *     database: "tdai_eval"
 *     maxBatchSize: 1000
 *     flushInterval: 5
 *     maxQueueSize: 10000
 *   kafka:
 *     enabled: true
 *     brokers: "kafka.example.local:9092"
 *     topic: "memory_monitor"
 *     totalPartitions: 32
 *   langfuse:
 *     enabled: true
 *     host: "http://langfuse.example.local:3000"
 *     publicKey: "pk-lf-xxx"
 *     secretKey: "sk-lf-yyy"
 * ```
 */
export interface ObservabilityConfig {
  /** OTel SDK config (Trace + Log). */
  otel: OTelConfig;
  /** ClickHouse dual-write config. */
  clickhouse: ClickHouseConfig;
  /** Kafka config. */
  kafka: KafkaConfig;
  /** Barad cloud monitoring reporting config. */
  barad?: BaradConfig;
  /** Zhiyan Monitor Metric reporting config. */
  zhiyan?: ZhiYanConfig;
  /** Langfuse LLM trace reporting config. */
  langfuse: LangfuseConfig;
}

/** Barad cloud monitoring reporting config. */
export interface BaradConfig {
  /** Whether to enable Barad reporting (default: false) */
  enabled: boolean;
  /** Reporting region, such as ap-guangzhou */
  region: string;
  /** Namespace (default: "qce/memory") */
  namespace: string;
  /** Reporting frequency (seconds) (default: 60) */
  freq: number;
  /** Test environment reporting address (overrides the default region-assembled address) */
  testEndpoint?: string;
  /** Test environment query address (used for integration test data verification) */
  testQueryEndpoint?: string;
  /** Collection interval (seconds) (default: 10) */
  collectInterval?: number;
}

/** Zhiyan Monitor Metric reporting config. Component used: Monitor ✓ */
export interface ZhiYanConfig {
  /** Whether to enable Zhiyan Metric reporting (default: false) */
  enabled: boolean;
  /** Zhiyan Monitor reporting address */
  endpoint: string;
  /** Application identifier (required by Zhiyan Monitor), format: {businessID}_{appID}_{appName} */
  appMark: string;
  /** Group name (default: "default") */
  group: string;
  /** Environment identifier, such as dev/test/prod */
  env: string;
  /** Metric namespace prefix (default: "memory") */
  namespace: string;
  /** Reporting interval (seconds) (default: 60) */
  exportInterval: number;
}

export interface GatewayConfig {
  /**
   * Deployment mode. Default: "standalone".
   *
   * env: TDAI_DEPLOY_MODE=standalone|service
   * yaml: deployMode: service
   */
  deployMode: DeployMode;
  server: {
    port: number;
    host: string;
    /**
     * Optional API token for HTTP authentication.
     *
     * When set (non-empty string), every route except `GET /health` and CORS
     * preflight (`OPTIONS *`) requires an `Authorization: Bearer <apiKey>`
     * header. Requests without a valid token receive HTTP 401.
     *
     * **Default: undefined** — authentication is disabled, all routes are
     * open (preserves legacy behaviour). A WARN is emitted at startup if the
     * gateway binds to a non-loopback host without an API key set, to avoid
     * silently exposing an unauthenticated endpoint to the network.
     *
     * env: `TDAI_GATEWAY_API_KEY`
     * yaml: `server.apiKey`
     */
    apiKey?: string;
    /**
     * Optional CORS allow-list.
     *
     * When empty (default), the gateway sends **no** `Access-Control-Allow-*`
     * headers and rejects CORS preflight (`OPTIONS`) with 403 if an `Origin`
     * header is present — browsers will then block all cross-origin requests
     * via same-origin policy.
     *
     * When set, each request's `Origin` is matched against this list and
     * `Access-Control-Allow-Origin` is echoed back only on match. Use the
     * single entry `"*"` to restore the legacy permissive behaviour (only
     * appropriate for local development).
     *
     * env: `TDAI_CORS_ORIGINS` (comma-separated)
     * yaml: `server.corsOrigins` (string[])
     */
    corsOrigins: string[];
  };
  data: {
    /** Base directory for TDAI data storage. */
    baseDir: string;
    /**
     * FS-dimension backend switch (env `FILE_STORE_MODE` / yaml `data.fileStore`).
     * Always resolved (default applied by deploy mode, §5.3.1).
     */
    fileStore: FileStoreMode;
    /**
     * Rowfs "others" switch (env `FILE_STORE_OTHERS` / yaml
     * `data.fileStoreOthers`). Always resolved; only consumed when
     * `fileStore === "rowfs"`.
     */
    fileStoreOthers: FileStoreOthersMode;
  };
  features: {
    /**
     * P9: route store/storage assembly through the BackendResolver selection
     * layer. `false` → legacy global-mode branches (rollback switch).
     *
     * env: `TDAI_BACKEND_RESOLVER` (on/off); yaml: `features.backendResolver`.
     * Default: true.
     */
    backendResolver: boolean;
  };
  llm: StandaloneLLMConfig;
  /** Parsed memory-tdai plugin config (recall, capture, extraction, pipeline, etc.). */
  memory: MemoryTdaiConfig;

  /**
   * Optional Skill module config — passed through to MemoryTdaiConfig.skill
   * at load time. Kept at the top level here so gateway-only deployments
   * can configure skills without nesting under `memory.skill`. The loader
   * shallow-merges this onto `memory.skill` (yaml top-level wins).
   */
  skill?: import("../core/skill/types.js").SkillConfigInput;

  // ── Service-mode config (also settable via env vars, env takes priority) ──

  /** State backend type. env: STATE_BACKEND. yaml: stateBackend */
  stateBackend?: "redis" | "local";
  /** Default instance ID for standalone pipeline. env: TDAI_INSTANCE_ID. yaml: instanceId */
  instanceId: string;
  redis: RedisConfig;
  shark: SharkConfig;
  scanner: ScannerConfig;
  worker: WorkerConfig;
  cos: CosExtraConfig;
  /** Observability config (yaml: observability, env: KAFKA_METRIC_*) */
  observability: ObservabilityConfig;
  /**
   * Metadata module config (env takes precedence over yaml; see applyMetadataEnvFromGatewayConfig).
   * yaml: metadata.*
   * env: TDAI_METADATA_*
   */
  metadata: GatewayMetadataConfig;
  /**
   * Task external source config (env takes precedence over yaml; see applyTaskSourceEnvFromGatewayConfig).
   * yaml: taskSource.* (camelCase keys, same style as sections like metadata / skill)
   * env:  TASK_SOURCE_* / TAI_PAT_URL
   *
   * Which keys each source has is declared by the provider's own requiredEnv, and the generic layer presets nothing,
   * so sources uses a Record rather than fixed fields; the conversion from camelCase keys to env names is handled uniformly by
   * task-source-env.ts, and only the structured config is kept here.
   *
   * Note: if overrides passes this field it **replaces it wholesale** (same as metadata / upstream,
   * no one-level shallow merge), and passing partial fields would drop the other fields resolved from yaml.
   */
  taskSource: GatewayTaskSourceConfig;
  /**
   * Analytics query module config (reads usage/session/tool-call data from the Proxy-side ClickHouse).
   * Completely independent of observability.clickhouse (OTel export to tdai_eval).
   *
   * env: ANALYTICS_CLICKHOUSE_*
   * yaml: analytics.clickhouse.*
   */
  analytics?: {
    clickhouse: ClickHouseConfig;
  };
  /**
   * v2 InstanceUpstream: supported-agents metadata.
   * See docs/design/2026-08-25-instance-upstream-config.md §6.A for the data source and sync mechanism.
   *
   * The source of truth is the code constant in Proxy `src/supported-agents.ts`; the yaml here is the Core-side runtime copy,
   * used for the §6.A supported-agents HTTP endpoint + the Core store layer's seed of the default group.
   *
   * When missing or an empty array, when Core's seed logic triggers it gets an empty array -> the default row is not seeded,
   * Panel B1 list returns items=[] -> Proxy takes the "zero-row fallback", with behavior equivalent to v1 (everything goes through the global upstream).
   * This guarantees that forgetting to configure Core yaml does not interrupt the business, but with missing config the v2 panel UI behaves abnormally (empty list).
   */
  upstream: {
    supportedAgents: import("../metadata/types.js").SupportedAgent[];
  };

  /** Offload server executor config (yaml: offload) */
  offload: {
    forceTriggerThreshold: number;
    pendingMaxAgeSeconds: number;
    l1Temperature: number;
    l1MaxTokens: number;
    l1TimeoutMs: number;
    l15Temperature: number;
    l15MaxTokens: number;
    l15TimeoutMs: number;
    l2Temperature: number;
    l2MaxTokens: number;
    l2TimeoutMs: number;
    l2NullThreshold: number;
    mildOffloadRatio: number;
    aggressiveCompressRatio: number;
    emergencyCompressRatio: number;
    maxRetries: number;
  };
}

/** v3 metadata Gateway yaml config (§6.3). */
export interface GatewayMetadataStoreConfig {
  sqliteBaseDir?: string;
  mongoUri?: string;
  mongoTransactions?: boolean;
  storeCacheMaxInstances?: number;
  /** Metadata database name prefix, default tdai_metadata; database name is {prefix}_{instance_id} */
  mongoDbPrefix?: string;
}

export interface GatewayMemorySystemUserConfig {
  userId?: string;
  displayName?: string;
  userKey?: string;
}

export interface GatewayMetadataSystemUserConfig {
  memory?: GatewayMemorySystemUserConfig;
}

export interface GatewayMetadataConfig {
  maxUsersPerInstance: number;
  maxTeamsPerInstance: number;
  configParamsFile?: string;
  store?: GatewayMetadataStoreConfig;
  /** Internal static system users (auth/verify only; not persisted). */
  systemUser?: GatewayMetadataSystemUserConfig;
}

/**
 * Task external source config (yaml: `taskSource`).
 *
 * Follows the **camelCase** style of the other sections in yaml: keys are config items (camelCase), not env names.
 * task-source-env.ts converts the camelCase keys to the
 * `TASK_SOURCE_<ID>_<SUFFIX>` that the provider actually reads, then backfills env.
 */
export interface GatewayTaskSourceConfig {
  /** Enabled source ids, comma-separated (corresponds to env `TASK_SOURCE_ENABLED`). */
  enabled?: string;
  /**
   * Config of each source, keyed by source id (lowercase, such as `tapd`).
   *
   * The keys under each source are camelCase config item names, converted to `TASK_SOURCE_<ID>_<UPPER_SNAKE_CASE>`.
   * For example `tapd: { mcpUrl }` -> `TASK_SOURCE_TAPD_MCP_URL`.
   *
   * Why no keys are preset: the suffix is declared by the provider's own `requiredEnv`
   * (e.g. TAPD has MCP_URL / SITE_BASE_URL), which the generic layer should not know.
   */
  sources?: Record<string, Record<string, string>>;
  /**
   * Token request page shared across sources (corresponds to env `TAI_PAT_URL`).
   * Multiple sources share the same token page (such as Taihu PAT), so it is lifted to the top level rather than under each source.
   */
  taiPatUrl?: string;
}

// ============================
// Config loading
// ============================

// ============================
// Utility Functions
// ============================

/**
 * Convert the Kafka brokers config value to a string[] array.
 *
 * Background: in the gateway config, KafkaConfig.brokers is typed as string (comma-separated),
 * but MetricBackendConfig.brokers expects string[]. If the string is passed in directly,
 * KafkaJS would parse it character by character, turning the port number into NaN.
 *
 * @param brokers - comma-separated broker address string, or already a string[] array
 * @returns array of broker addresses (trimmed, empty elements filtered out)
 */
export function parseBrokers(brokers: string | string[]): string[] {
  if (Array.isArray(brokers)) return brokers;
  if (!brokers) return [];
  return brokers.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Resolve the FS-dimension switch (`FILE_STORE_MODE` / `data.fileStore`).
 *
 * Semantics (design doc §5.3.1, finalized 2026-08-31):
 * - unset → default by deploy mode: service → `cos`, standalone → `local`;
 * - set to a valid value → that value wins over the default;
 * - set to anything else → config parse failure, fail-fast (throw).
 */
export function resolveFileStoreMode(
  raw: string | undefined,
  deployMode: DeployMode,
): FileStoreMode {
  if (raw === undefined) return deployMode === "service" ? "cos" : "local";
  if (raw === "local" || raw === "cos" || raw === "rowfs") return raw;
  throw new Error(
    `invalid FILE_STORE_MODE/data.fileStore: ${JSON.stringify(raw)} (expected "local" | "cos" | "rowfs")`,
  );
}

/**
 * Resolve the rowfs "others" switch (`FILE_STORE_OTHERS` /
 * `data.fileStoreOthers`). Only meaningful with `fileStore === "rowfs"`;
 * same semantics as {@link resolveFileStoreMode}: unset → per-mode default,
 * invalid → fail-fast. The `mongofs × STORE_MODE` legality check happens in
 * the selection layer (`validateResolution`), not here.
 */
export function resolveFileStoreOthersMode(
  raw: string | undefined,
  deployMode: DeployMode,
): FileStoreOthersMode {
  if (raw === undefined) return deployMode === "service" ? "cos" : "local";
  if (raw === "local" || raw === "cos" || raw === "mongofs") return raw;
  throw new Error(
    `invalid FILE_STORE_OTHERS/data.fileStoreOthers: ${JSON.stringify(raw)} (expected "local" | "cos" | "mongofs")`,
  );
}

/**
 * Overrides accepted by {@link loadGatewayConfig} / the TdaiGateway constructor.
 *
 * `server` / `data` / `llm` are merged one level deep onto the parsed base
 * (see the merge at the end of loadGatewayConfig), so callers may pass partial
 * nested blocks — e.g. `data: { baseDir }` keeps the resolved `fileStore`
 * default. Typing them as nested Partial makes the type match the runtime
 * merge behaviour.
 */
export type GatewayConfigOverrides = Omit<Partial<GatewayConfig>, "server" | "data" | "llm" | "features"> & {
  server?: Partial<GatewayConfig["server"]>;
  data?: Partial<GatewayConfig["data"]>;
  features?: Partial<GatewayConfig["features"]>;
  llm?: Partial<GatewayConfig["llm"]>;
};

/**
 * Load gateway config from file + environment variables.
 *
 * Resolution order for config file:
 * 1. `TDAI_GATEWAY_CONFIG` env var (explicit path)
 * 2. `./tdai-gateway.yaml` or `./tdai-gateway.json` in CWD
 * 3. `<dataDir>/tdai-gateway.yaml` or `<dataDir>/tdai-gateway.json`
 * 4. Pure environment-variable config (no file)
 */
export function loadGatewayConfig(overrides?: GatewayConfigOverrides): GatewayConfig {
  let fileConfig: Record<string, unknown> = {};

  // Try to load config file
  const configPath = resolveConfigPath();
  if (configPath) {
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      if (configPath.endsWith(".json")) {
        fileConfig = JSON.parse(raw);
      } else {
      // Full YAML support (arbitrary nesting, anchors, lists, multi-line).
        // We still postprocess ${VAR} env-var interpolation on string leaves
        // below so existing configs that relied on the previous simple parser
        // keep working.
        const parsed = YAML.parse(raw);
        fileConfig = (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          ? parsed as Record<string, unknown>
          : {};
      }
      fileConfig = expandEnvVars(fileConfig) as Record<string, unknown>;
    } catch {
      // Config file is optional — malformed files fall back to env-only config.
    }
  }

  // Server config
  const serverConfig = obj(fileConfig, "server");
  const port = envInt("TDAI_GATEWAY_PORT") ?? num(serverConfig, "port") ?? 8420;
  const host = env("TDAI_GATEWAY_HOST") ?? str(serverConfig, "host") ?? "127.0.0.1";

  // Optional auth / CORS — both default to "disabled" so existing setups keep
  // working unchanged. When unset the gateway behaves exactly like before this
  // change (open v1 routes, permissive CORS *will not* be re-introduced — see
  // resolveCorsOrigins below: empty list means "send no CORS headers").
  const apiKey = env("TDAI_GATEWAY_API_KEY") ?? str(serverConfig, "apiKey");
  const corsOrigins = resolveCorsOrigins(serverConfig);

  // Data config (expand leading ~ to $HOME so Node.js fs/path can resolve it)
  const dataConfig = obj(fileConfig, "data");
  const rawBaseDir = env("TDAI_DATA_DIR") ?? str(dataConfig, "baseDir") ?? resolveDefaultDataDir();
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";
  const baseDir = rawBaseDir.startsWith("~/") ? path.join(home, rawBaseDir.slice(2)) : rawBaseDir;

  // LLM config
  //
  // provider supports two modes:
  //   - "openai" (default): connect directly to an OpenAI-compatible service
  //   - "proxy": go through context_proxy; at runtime baseUrl is assembled into `${baseUrl}/proxy/<iid>/v1`,
  //             and Authorization uses the memory system user key. The gateway layer is responsible for the final resolution,
  //             see resolveEffectiveLlmConfig in src/gateway/llm-resolver.ts.
  const llmConfig = obj(fileConfig, "llm");
  const llmProxyConfig = obj(llmConfig, "proxy");
  const rawLlmProvider = env("TDAI_LLM_PROVIDER") ?? str(llmConfig, "provider");
  const llmProvider: "openai" | "proxy" =
    rawLlmProvider === "proxy" ? "proxy" : "openai";
  const llm: StandaloneLLMConfig = {
    baseUrl: env("TDAI_LLM_BASE_URL") ?? str(llmConfig, "baseUrl") ?? "https://api.openai.com/v1",
    apiKey: env("TDAI_LLM_API_KEY") ?? str(llmConfig, "apiKey") ?? "",
    model: env("TDAI_LLM_MODEL") ?? str(llmConfig, "model") ?? "gpt-4o",
    maxTokens: envInt("TDAI_LLM_MAX_TOKENS") ?? num(llmConfig, "maxTokens") ?? 4096,
    timeoutMs: envInt("TDAI_LLM_TIMEOUT_MS") ?? num(llmConfig, "timeoutMs") ?? 120_000,
    provider: llmProvider,
    proxy: {
      useMemorySystemUserKey: bool(llmProxyConfig, "useMemorySystemUserKey") ?? true,
    },
    // When env exists, use env directly to resolve (yaml can be explicitly turned off);
    // only fall back to yaml when env is not set, consistent with the semantics of other LLM fields.
    stream: (() => {
      const envVal = env("TDAI_LLM_STREAM");
      if (envVal !== undefined) return envVal === "true";
      return bool(llmConfig, "stream") ?? false;
    })(),
  };

  // Memory config (reuse the plugin's parseConfig for full compatibility)
  const memoryRaw = obj(fileConfig, "memory");
  const topLevelPromptMode = str(fileConfig, "promptMode") ?? str(obj(fileConfig, "prompts"), "mode");
  const memoryCompatRaw: Record<string, unknown> = { ...memoryRaw };
  if (!str(memoryCompatRaw, "promptMode") && topLevelPromptMode) {
    memoryCompatRaw.promptMode = topLevelPromptMode;
  }
  const memory = parseMemoryConfig(memoryCompatRaw);

  // ── Standalone LLM override pass-through to MemoryTdaiConfig.llm ──
  // The gateway has its own top-level `llm` block (read above into the
  // `llm` variable), and `parseMemoryConfig` ALSO has a `memory.llm` block
  // that defaults to enabled=false. When the gateway's top-level llm is
  // configured (baseUrl + apiKey), splice it onto memory.llm so the
  // SkillExtractor / L1 / L2 / L3 runners see a usable runner without
  // requiring the user to duplicate the block under `memory.llm`.
  // With provider=proxy, splice even if apiKey is empty -- because the final apiKey is
  // provided by memory systemUser.userKey, and llm.apiKey is only an explicit config when provider=openai.
  const shouldSpliceLlm =
    !memory.llm.enabled && llm.baseUrl && (llm.apiKey || llm.provider === "proxy");
  if (shouldSpliceLlm) {
    memory.llm = {
      enabled: true,
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      maxTokens: llm.maxTokens ?? 4096,
      timeoutMs: llm.timeoutMs ?? 120_000,
      provider: llm.provider,
      proxy: {
        useMemorySystemUserKey: llm.proxy?.useMemorySystemUserKey ?? true,
      },
    };
  }

  // ── Standalone embedding override pass-through ──
  // Some existing gateway configs place `embedding` at the top level next to
  // `llm`. The memory parser expects it under `memory.embedding`, so splice the
  // top-level block into MemoryTdaiConfig for backward compatibility.
  const topLevelEmbedding = obj(fileConfig, "embedding");
  if (topLevelEmbedding) {
    memory.embedding = {
      ...memory.embedding,
      enabled: bool(topLevelEmbedding, "enabled") ?? memory.embedding.enabled,
      provider: str(topLevelEmbedding, "provider") ?? memory.embedding.provider,
      baseUrl: str(topLevelEmbedding, "baseUrl") ?? memory.embedding.baseUrl,
      apiKey: str(topLevelEmbedding, "apiKey") ?? memory.embedding.apiKey,
      model: str(topLevelEmbedding, "model") ?? memory.embedding.model,
      dimensions: num(topLevelEmbedding, "dimensions") ?? memory.embedding.dimensions,
      sendDimensions: bool(topLevelEmbedding, "sendDimensions") ?? memory.embedding.sendDimensions,
      conflictRecallTopK: num(topLevelEmbedding, "conflictRecallTopK") ?? memory.embedding.conflictRecallTopK,
      maxInputChars: num(topLevelEmbedding, "maxInputChars") ?? memory.embedding.maxInputChars,
      timeoutMs: num(topLevelEmbedding, "timeoutMs") ?? memory.embedding.timeoutMs,
      recallTimeoutMs: num(topLevelEmbedding, "recallTimeoutMs") ?? memory.embedding.recallTimeoutMs,
      captureTimeoutMs: num(topLevelEmbedding, "captureTimeoutMs") ?? memory.embedding.captureTimeoutMs,
      proxyUrl: str(topLevelEmbedding, "proxyUrl") ?? memory.embedding.proxyUrl,
    };
  }

  // ── Skill module config ──
  // Resolution order:
  //   1. Top-level `skill` block in yaml (preferred — skill is a top-level
  //      gateway feature, not buried under `memory`).
  //   2. `memory.skill` (if user nested it under memory by accident).
  //   3. env var TDAI_SKILL_ENABLED forces enabled=true so a one-line
  //      shell flag opts in without touching yaml.
  // The result is *also* spliced onto memory.skill so TdaiCore (which reads
  // from cfg.skill in its config) sees it regardless of which path wired it.
  const topLevelSkill = (fileConfig.skill && typeof fileConfig.skill === "object" && !Array.isArray(fileConfig.skill))
    ? (fileConfig.skill as import("../core/skill/types.js").SkillConfigInput)
    : undefined;
  const envSkillEnabled = env("TDAI_SKILL_ENABLED");
  const skillFromAnywhere: import("../core/skill/types.js").SkillConfigInput | undefined =
    topLevelSkill ?? memory.skill ?? (envSkillEnabled === "true" || envSkillEnabled === "1" ? { enabled: true } : undefined);
  if (skillFromAnywhere) {
    // Last write wins: env-only override forces enabled=true on top of yaml.
    if (envSkillEnabled === "true" || envSkillEnabled === "1") {
      skillFromAnywhere.enabled = true;
    }
    memory.skill = skillFromAnywhere;
  }

  // Deploy mode: "standalone" (open-source single-node) or "service" (cloud multi-tenant)
  const rawMode = env("TDAI_DEPLOY_MODE") ?? str(fileConfig, "deployMode") ?? "standalone";
  const deployMode: DeployMode = rawMode === "service" ? "service" : "standalone";

  // FS-dimension switch (dimension ②). env > yaml > deploy-mode default.
  // An explicitly-set but invalid value is a config parse failure → fail-fast
  // (§5.3.1 rule 2); the rowfs × store-mode combination check happens at
  // assembly time (D8③), not here.
  const fileStore = resolveFileStoreMode(
    env("FILE_STORE_MODE") ?? str(dataConfig, "fileStore"),
    deployMode,
  );
  const fileStoreOthers = resolveFileStoreOthersMode(
    env("FILE_STORE_OTHERS") ?? str(dataConfig, "fileStoreOthers"),
    deployMode,
  );

  // P9 kill switch: assembly via BackendResolver (default) vs legacy branches.
  const featuresConfig = obj(fileConfig, "features");
  const backendResolver = resolveBackendResolverFlag(
    env("TDAI_BACKEND_RESOLVER") ?? (bool(featuresConfig, "backendResolver") === false ? "off" : undefined),
  );

  // State backend (env > yaml > auto from deployMode)
  const rawBackend = env("STATE_BACKEND") ?? str(fileConfig, "stateBackend");
  const stateBackend = rawBackend === "redis" || rawBackend === "local" ? rawBackend : undefined;

  // Instance ID: service mode requires explicit instanceId from request headers (x-tdai-service-id),
  // standalone mode uses configured or defaults to "default".
  const instanceId = env("TDAI_INSTANCE_ID") ?? str(fileConfig, "instanceId")
    ?? (deployMode === "standalone" ? "default" : undefined);

  // Remote state backend config
  const redisConfig = obj(fileConfig, "redis");
  const redis: RedisConfig = {
    host: env("REDIS_HOST") ?? str(redisConfig, "host") ?? "127.0.0.1",
    port: envInt("REDIS_PORT") ?? num(redisConfig, "port") ?? 6379,
    password: env("REDIS_PASSWORD") ?? str(redisConfig, "password"),
    db: envInt("REDIS_DB") ?? num(redisConfig, "db") ?? 0,
    // v2 default prefix: physically isolated from the pre-upgrade "tdai_memory".
    // Reason for the upgrade: the sk/bk hash tag was upgraded from {p:inst} to {p:inst:tid:aid},
    // old keys and new keys are not mutually exclusive, and mixed running would break the lock mutual-exclusion semantics; switching the prefix isolates them physically,
    // and old data is discarded. If pending tasks in redis need to be preserved on upgrade, stop the service first + wait for the queue to drain.
    keyPrefix: env("REDIS_KEY_PREFIX") ?? str(redisConfig, "keyPrefix") ?? "tdai_memory_v2",
  };

  // Remote config source settings
  const sharkConfig = obj(fileConfig, "shark");
  const shark: SharkConfig = {
    baseUrl: env("SHARK_BASE_URL") ?? str(sharkConfig, "baseUrl"),
    vdbTtlMs: envInt("CONFIG_VDB_TTL_MS") ?? num(sharkConfig, "vdbTtlMs") ?? 300_000,
    cosBufferMs: envInt("CONFIG_COS_BUFFER_MS") ?? num(sharkConfig, "cosBufferMs") ?? 120_000,
    maxInstances: envInt("CONFIG_MAX_INSTANCES") ?? num(sharkConfig, "maxInstances") ?? 1000,
  };

  // Scanner config
  const scannerConfig = obj(fileConfig, "scanner");
  const scanner: ScannerConfig = {
    instances: env("SCANNER_INSTANCES") ?? str(scannerConfig, "instances") ?? "default",
    instancesSharkUrl: env("SCANNER_INSTANCES_SHARK_URL") ?? str(scannerConfig, "instancesSharkUrl"),
    intervalMs: envInt("SCANNER_INTERVAL_MS") ?? num(scannerConfig, "intervalMs") ?? 500,
    nodeId: env("SCANNER_NODE_ID") ?? str(scannerConfig, "nodeId"),
  };

  // Worker config
  const workerConfig = obj(fileConfig, "worker");
  const worker: WorkerConfig = {
    pollMs: envInt("WORKER_POLL_MS") ?? num(workerConfig, "pollMs") ?? 200,
    concurrency: envInt("WORKER_CONCURRENCY") ?? num(workerConfig, "concurrency") ?? 60,
    lockTtlMs: envInt("WORKER_LOCK_TTL_MS") ?? num(workerConfig, "lockTtlMs"),
    pendingStaleMs: envInt("WORKER_PENDING_STALE_MS") ?? num(workerConfig, "pendingStaleMs"),
    pendingRecoveryIntervalMs: envInt("WORKER_PENDING_RECOVERY_INTERVAL_MS") ?? num(workerConfig, "pendingRecoveryIntervalMs"),
    parkedClaimHeartbeatMs: envInt("WORKER_PARKED_HEARTBEAT_MS") ?? num(workerConfig, "parkedClaimHeartbeatMs"),
    lockRetryConcurrency: envInt("WORKER_LOCK_RETRY_CONCURRENCY") ?? num(workerConfig, "lockRetryConcurrency"),
    maxParkedTasks: envInt("WORKER_MAX_PARKED_TASKS") ?? num(workerConfig, "maxParkedTasks"),
  };

  // COS extra config
  const cosConfig = obj(fileConfig, "cos");
  const cos: CosExtraConfig = {
    domain: env("COS_DOMAIN") ?? str(cosConfig, "domain"),
    generationLogRetentionDays: envInt("COS_GENERATION_LOG_RETENTION_DAYS")
      ?? num(cosConfig, "generationLogRetentionDays")
      ?? 30,
  };
  if (!Number.isInteger(cos.generationLogRetentionDays) || cos.generationLogRetentionDays < 0) {
    throw new Error("cos.generationLogRetentionDays must be a non-negative integer");
  }

  // Observability config (yaml: observability.{otel,clickhouse,kafka}, env fallback)
  const observabilityConfig = obj(fileConfig, "observability");

  // OTel config
  const otelConfig = obj(observabilityConfig, "otel");
  const otel: OTelConfig = {
    enabled: otelConfig.enabled !== undefined
      ? Boolean(otelConfig.enabled)
      : env("TDAI_OTEL_ENABLED") === "true",
    endpoint: str(otelConfig, "endpoint") ?? env("OTEL_EXPORTER_OTLP_ENDPOINT") ?? "http://localhost:4317",
    protocol: (str(otelConfig, "protocol") ?? env("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "grpc") as "grpc" | "http/protobuf",
    serviceName: str(otelConfig, "serviceName") ?? env("OTEL_SERVICE_NAME") ?? "core",
    serviceVersion: str(otelConfig, "serviceVersion") ?? "1.0.0",
    tenantId: str(otelConfig, "tenantId") ?? env("OTEL_TENANT_ID") ?? "",
    logExportInterval: num(otelConfig, "logExportInterval") ?? envInt("OTEL_LOG_EXPORT_INTERVAL") ?? 5,
  };

  // ClickHouse config
  const chConfig = obj(observabilityConfig, "clickhouse");
  const clickhouse: ClickHouseConfig = {
    enabled: chConfig.enabled !== undefined
      ? Boolean(chConfig.enabled)
      : env("CLICKHOUSE_ENABLED") === "true",
    endpoint: str(chConfig, "endpoint") ?? env("CLICKHOUSE_ENDPOINT") ?? "",
    username: str(chConfig, "username") ?? env("CLICKHOUSE_USERNAME") ?? "default",
    password: str(chConfig, "password") ?? env("CLICKHOUSE_PASSWORD") ?? "",
    database: str(chConfig, "database") ?? env("CLICKHOUSE_DATABASE") ?? "tdai_eval",
  };

  // Analytics ClickHouse config (reads Proxy CH — independent from observability CH)
  const analyticsYaml = obj(fileConfig, "analytics");
  const analyticsChYaml = obj(analyticsYaml, "clickhouse");
  const analyticsChEnabledEnv = env("ANALYTICS_CLICKHOUSE_ENABLED");
  const analyticsClickhouse: ClickHouseConfig = {
    enabled: analyticsChEnabledEnv !== undefined
      ? analyticsChEnabledEnv === "true"
      : analyticsChYaml.enabled !== undefined
        ? Boolean(analyticsChYaml.enabled)
        : false,
    endpoint: env("ANALYTICS_CLICKHOUSE_ENDPOINT") ?? str(analyticsChYaml, "endpoint") ?? "",
    username: env("ANALYTICS_CLICKHOUSE_USERNAME") ?? str(analyticsChYaml, "username") ?? "default",
    password: env("ANALYTICS_CLICKHOUSE_PASSWORD") ?? str(analyticsChYaml, "password") ?? "",
    database: env("ANALYTICS_CLICKHOUSE_DATABASE") ?? str(analyticsChYaml, "database") ?? "context_proxy",
  };

  // Kafka config
  const kafkaConfig = obj(observabilityConfig, "kafka");
  const kafka: KafkaConfig = {
    brokers: str(kafkaConfig, "brokers") ?? env("KAFKA_METRIC_BROKERS") ?? "",
    topic: str(kafkaConfig, "topic") ?? env("KAFKA_METRIC_TOPIC") ?? "memory_monitor",
    enabled: kafkaConfig.enabled !== undefined
      ? Boolean(kafkaConfig.enabled)
      : (env("KAFKA_METRIC_ENABLED") === "true" || Boolean(str(kafkaConfig, "brokers") ?? env("KAFKA_METRIC_BROKERS"))),
  };

  // Langfuse config
  const langfuseConfig = obj(observabilityConfig, "langfuse");
  const langfuse: LangfuseConfig = {
    enabled: langfuseConfig.enabled !== undefined
      ? Boolean(langfuseConfig.enabled)
      : env("LANGFUSE_ENABLED") === "true",
    host: str(langfuseConfig, "host") ?? env("LANGFUSE_HOST") ?? "",
    publicKey: str(langfuseConfig, "publicKey") ?? env("LANGFUSE_PUBLIC_KEY") ?? "",
    secretKey: str(langfuseConfig, "secretKey") ?? env("LANGFUSE_SECRET_KEY") ?? "",
  };

  const observability: ObservabilityConfig = { otel, clickhouse, kafka, langfuse };

  // Offload executor config (yaml: offload)
  const metadataConfig = obj(fileConfig, "metadata");
  const storeYaml = obj(metadataConfig, "store");
  const systemUserYaml = obj(metadataConfig, "systemUser");
  const memorySystemUserYaml = obj(systemUserYaml, "memory");
  const metadataStore: GatewayMetadataStoreConfig | undefined =
    str(storeYaml, "sqliteBaseDir") || str(storeYaml, "mongoUri") ||
    str(storeYaml, "mongoDbPrefix") ||
    bool(storeYaml, "mongoTransactions") !== undefined || num(storeYaml, "storeCacheMaxInstances") !== undefined
      ? {
          sqliteBaseDir: str(storeYaml, "sqliteBaseDir"),
          mongoUri: str(storeYaml, "mongoUri"),
          mongoTransactions: bool(storeYaml, "mongoTransactions") ?? true,
          storeCacheMaxInstances: num(storeYaml, "storeCacheMaxInstances"),
          mongoDbPrefix: str(storeYaml, "mongoDbPrefix"),
        }
      : undefined;
  const metadata: GatewayMetadataConfig = {
    maxUsersPerInstance: positiveQuotaLimit(
      envInt("TDAI_METADATA_MAX_USERS") ?? num(metadataConfig, "maxUsersPerInstance"),
      500,
    ),
    maxTeamsPerInstance: positiveQuotaLimit(
      envInt("TDAI_METADATA_MAX_TEAMS") ?? num(metadataConfig, "maxTeamsPerInstance"),
      100,
    ),
    configParamsFile: process.env.TDAI_METADATA_CONFIG_PARAMS_FILE || str(metadataConfig, "configParamsFile") || undefined,
    store: metadataStore,
    systemUser: str(memorySystemUserYaml, "userId") || str(memorySystemUserYaml, "userKey") ||
      str(memorySystemUserYaml, "displayName")
      ? {
          memory: {
            userId: str(memorySystemUserYaml, "userId"),
            displayName: str(memorySystemUserYaml, "displayName"),
            userKey: str(memorySystemUserYaml, "userKey"),
          },
        }
      : undefined,
  };
  /**
   * Task external source: yaml uses the **camelCase** style (consistent with sections like metadata / skill),
   * read here as structured config, then converted to env names and backfilled by task-source-env.ts.
   *
   * Values have already passed through expandEnvVars at file load time, so `${VAR}` interpolation still works --
   * making it convenient to keep internal addresses in .env and only do the mapping in yaml.
   */
  const taskSourceConfig = obj(fileConfig, "taskSource");
  const sourcesRaw = obj(taskSourceConfig, "sources");
  const taskSourceSources: Record<string, Record<string, string>> = {};
  for (const [sourceId, raw] of Object.entries(sourcesRaw)) {
    const id = sourceId.trim();
    if (!id || !isSafeTaskSourceId(id)) continue;
    const entries = (raw && typeof raw === "object" && !Array.isArray(raw))
      ? raw as Record<string, unknown>
      : {};
    const cfg: Record<string, string> = {};
    for (const [k, v] of Object.entries(entries)) {
      if (typeof v !== "string") continue;
      const key = k.trim();
      if (!key) continue;
      cfg[key] = v.trim();
    }
    if (Object.keys(cfg).length) taskSourceSources[id] = cfg;
  }
  const taskSource: GatewayTaskSourceConfig = {
    enabled: str(taskSourceConfig, "enabled")?.trim() || undefined,
    sources: Object.keys(taskSourceSources).length ? taskSourceSources : undefined,
    taiPatUrl: str(taskSourceConfig, "taiPatUrl")?.trim() || undefined,
  };

  // supported-agents of v2 InstanceUpstream (§6.A):
  // -- Data source priority (v2.6+) --
  //   1. yaml `upstream.supportedAgents` **non-empty** -> yaml prevails (allows ops to temporarily take an agent offline)
  //   2. yaml not configured / empty array -> **automatically falls back** to `DEFAULT_SUPPORTED_AGENTS_FALLBACK`
  //      (a Core code constant, in one-to-one correspondence with Proxy `src/supported-agents.ts`)
  //
  // This way, when Core upgrades and rolls out a new agent, it suffices to **change the fallback constant in sync**, with no need to force ops to change yaml,
  // avoiding the pitfall of "forgot to configure yaml -> seed an empty array -> old instance behavior silently lost".
  const upstreamConfig = obj(fileConfig, "upstream");
  const supportedAgentsRaw = (upstreamConfig["supportedAgents"] ?? []) as unknown[];
  const parsedFromYaml: import("../metadata/types.js").SupportedAgent[] = Array.isArray(supportedAgentsRaw)
    ? supportedAgentsRaw
        .filter((e): e is Record<string, unknown> => typeof e === "object" && e !== null)
        .map((e) => ({
          agent_source: String(e.agent_source ?? ""),
          protocol: (e.protocol as "anthropic" | "openai-chat" | "openai-responses") ?? "openai-chat",
          display_name: String(e.display_name ?? ""),
        }))
        .filter((a) => a.agent_source !== "")
    : [];
  // When yaml has a value (non-empty) yaml prevails; otherwise fall back to the code constant
  const supportedAgents = parsedFromYaml.length > 0
    ? parsedFromYaml
    : [...DEFAULT_SUPPORTED_AGENTS_FALLBACK];
  const upstream = { supportedAgents };

  const offloadConfig = obj(fileConfig, "offload");
  const offload = {
    forceTriggerThreshold: num(offloadConfig, "forceTriggerThreshold") ?? 4,
    pendingMaxAgeSeconds: num(offloadConfig, "pendingMaxAgeSeconds") ?? 30,
    l1Temperature: num(offloadConfig, "l1Temperature") ?? 0.3,
    l1MaxTokens: num(offloadConfig, "l1MaxTokens") ?? 8000,
    l1TimeoutMs: num(offloadConfig, "l1TimeoutMs") ?? 120_000,
    l15Temperature: num(offloadConfig, "l15Temperature") ?? 0.2,
    l15MaxTokens: num(offloadConfig, "l15MaxTokens") ?? 3000,
    l15TimeoutMs: num(offloadConfig, "l15TimeoutMs") ?? 120_000,
    l2Temperature: num(offloadConfig, "l2Temperature") ?? 0.4,
    l2MaxTokens: num(offloadConfig, "l2MaxTokens") ?? 16000,
    l2TimeoutMs: num(offloadConfig, "l2TimeoutMs") ?? 120_000,
    l2NullThreshold: num(offloadConfig, "l2NullThreshold") ?? 6,
    mildOffloadRatio: num(offloadConfig, "mildOffloadRatio") ?? 0.5,
    aggressiveCompressRatio: num(offloadConfig, "aggressiveCompressRatio") ?? 0.85,
    emergencyCompressRatio: num(offloadConfig, "emergencyCompressRatio") ?? 0.95,
    maxRetries: num(offloadConfig, "maxRetries") ?? 3,
  };

  const base: GatewayConfig = {
    deployMode,
    stateBackend,
    instanceId,
    server: { port, host, apiKey, corsOrigins },
    data: { baseDir, fileStore, fileStoreOthers },
    features: { backendResolver },
    llm,
    memory,
    redis,
    shark,
    scanner,
    worker,
    cos,
    observability,
    analytics: { clickhouse: analyticsClickhouse },
    metadata,
    upstream,
    taskSource,
    offload,
    skill: skillFromAnywhere,
  };

  // Merge overrides one level deep so partial `server`/`data`/`llm` patches
  // (frequently used by e2e tests) don't accidentally drop sibling fields
  // such as `corsOrigins` introduced after they were written.
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    server: { ...base.server, ...(overrides.server ?? {}) },
    data: { ...base.data, ...(overrides.data ?? {}) },
    features: { ...base.features, ...(overrides.features ?? {}) },
    llm: { ...base.llm, ...(overrides.llm ?? {}) },
  };
}

// ============================
// Helpers
// ============================

function resolveConfigPath(): string | null {
  // 1. Explicit env var
  const explicit = getEnv("TDAI_GATEWAY_CONFIG")?.trim();
  if (explicit && fs.existsSync(explicit)) return explicit;

  // 2. CWD
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(process.cwd(), name);
    if (fs.existsSync(p)) return p;
  }

  // 3. Default data dir
  const dataDir = resolveDefaultDataDir();
  for (const name of ["tdai-gateway.yaml", "tdai-gateway.json"]) {
    const p = path.join(dataDir, name);
    if (fs.existsSync(p)) return p;
  }

  return null;
}

function resolveDefaultDataDir(): string {
  const home = getEnv("HOME") ?? getEnv("USERPROFILE") ?? "/tmp";

  // New canonical location: everything related to standalone/Hermes-mode TDAI
  // is collected under ~/.memory-tencentdb/ to avoid scattering top-level dirs
  // in $HOME. The Gateway data dir lives at:
  //
  //   ~/.memory-tencentdb/memory-tdai/
  //
  // Note: this only governs the standalone/Hermes fallback. Under the openclaw
  // host the plugin data dir is decided by `resolveStateDir() + "memory-tdai"`
  // (typically ~/.openclaw/memory-tdai/) which is intentionally NOT changed.
  const root = getEnv("MEMORY_TENCENTDB_ROOT") ?? path.join(home, ".memory-tencentdb");
  const newDefault = path.join(root, "memory-tdai");

  // Backward compatibility: if the new location does not yet exist but the
  // legacy ~/memory-tdai still has data, keep using the legacy dir so existing
  // users don't silently lose their memory store. The install script
  // (install_hermes_memory_tencentdb.sh, Step 0) will migrate it on next run.
  try {
    if (!fs.existsSync(newDefault)) {
      const legacy = path.join(home, "memory-tdai");
      if (fs.existsSync(legacy)) {
        // Stderr-only deprecation hint; doesn't pollute structured logs.
        process.stderr.write(
          `[tdai-gateway] DEPRECATED: using legacy data dir ${legacy}; ` +
          `move it to ${newDefault} (or set TDAI_DATA_DIR / MEMORY_TENCENTDB_ROOT) to silence this warning.\n`,
        );
        return legacy;
      }
    }
  } catch {
    // existsSync should not throw, but guard anyway.
  }

  return newDefault;
}

function env(key: string): string | undefined {
  const v = getEnv(key)?.trim();
  return v || undefined;
}

function envInt(key: string): number | undefined {
  const v = env(key);
  if (!v) return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function obj(c: Record<string, unknown>, key: string): Record<string, unknown> {
  const v = c[key];
  return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/**
 * Legal shape of a source id: lowercase letters / digits / hyphens (such as `tapd`, `jira`).
 *
 * The source id participates in assembling env names (`TASK_SOURCE_<UPPERCASE_ID>_<SUFFIX>`), and the characters in an env name
 * must be controllable -- otherwise yaml could inject `_` or newlines via the id, assembling the env name into
 * unexpected names such as `TASK_SOURCE_A_ENV_B`, or even overwriting other variables. So it is tightened to this character set.
 */
const TASK_SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function isSafeTaskSourceId(id: string): boolean {
  return TASK_SOURCE_ID_PATTERN.test(id);
}

function str(src: Record<string, unknown>, key: string): string | undefined {
  const v = src[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function num(src: Record<string, unknown>, key: string): number | undefined {
  const v = src[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function positiveQuotaLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && value > 0 ? value : fallback;
}

function bool(src: Record<string, unknown>, key: string): boolean | undefined {
  const v = src[key];
  return typeof v === "boolean" ? v : undefined;
}

/**
 * Read `server.corsOrigins` from yaml or `TDAI_CORS_ORIGINS` from env.
 *
 * Accepted yaml shapes (yaml has precedence over env):
 *   server:
 *     corsOrigins: []                              # explicit empty → no CORS
 *     corsOrigins: ["https://app.example.com"]     # array of allowed origins
 *     corsOrigins: "https://a,https://b"           # comma-separated string
 *
 * Env: `TDAI_CORS_ORIGINS="https://a,https://b"`
 *
 * Returns `[]` when nothing is set — the server interprets that as
 * "do not emit any CORS headers" (most restrictive default).
 */
function resolveCorsOrigins(serverConfig: Record<string, unknown>): string[] {
  // 1. YAML takes precedence so an explicit `corsOrigins: []` can mean
  //    "I want CORS off" even when the env var leaks in from the shell.
  const raw = serverConfig["corsOrigins"];
  if (Array.isArray(raw)) {
    return raw.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map(s => s.trim());
  }
  if (typeof raw === "string" && raw.trim()) {
    return raw.split(",").map(s => s.trim()).filter(Boolean);
  }

  // 2. Fall back to env. Empty string from env is treated as "not set".
  const envValue = env("TDAI_CORS_ORIGINS");
  if (!envValue) return [];
  return envValue.split(",").map(s => s.trim()).filter(Boolean);
}

/**
 * Recursively replace ``${VAR_NAME}`` placeholders in string leaves with
 * the corresponding ``process.env`` value. Missing variables expand to an
 * empty string, matching the behaviour of the previous simple YAML parser
 * so existing configs keep working after the switch to the full YAML lib.
 *
 * - Only whole-string matches (``"${VAR}"``) are substituted, preserving
 *   types: numbers/booleans/null pass through unchanged.
 * - Arrays and nested objects are walked in-place (new arrays/objects are
 *   returned; the input is not mutated).
 */
function expandEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    const m = value.match(/^\$\{(\w+)\}$/);
    if (m) {
      return process.env[m[1]!] ?? "";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(expandEnvVars);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = expandEnvVars(v);
    }
    return out;
  }
  return value;
}
