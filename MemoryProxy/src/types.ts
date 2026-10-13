/** Shared type definitions for context-proxy. */

/**
 * Optional private forwarding extension config.
 *
 * The host only understands a few generic fields; every other setting is kept
 * opaque in `options` and passed through to the private extension untouched.
 * The host never inspects, defaults, or type-checks the opaque payload.
 */
export interface CostGuardConfig {
  /** Master switch for the private forwarding extension. */
  enabled: boolean;
  /**
   * Whether the `/cost-guard` URL marker is required to activate the router.
   *
   *   - `false` (default, historical behavior): every request that reaches a
   *     primary handler goes through the cost-guard router (subject to
   *     `enabled`). The `/{agent}/{spaceId}/cost-guard/...` routes are NOT
   *     registered and return 404. This is what production runs — clients that
   *     never learned about the marker continue to work unchanged.
   *   - `true` (opt-in, test env): the router is only activated when the
   *     request path contains the `/cost-guard` segment. Paths without the
   *     marker skip the router and passthrough directly to the default
   *     upstream. Used to A/B compare guarded vs. bare traffic side by side.
   *
   * Independent of `enabled`: when `enabled=false` every request is a
   * passthrough regardless of this flag, matching pre-existing semantics.
   */
  markerOptIn?: boolean;
  /**
   * Pin the agent profile by id ("claude-code", "codebuddy").
   * Empty or "auto" (default) = auto-detect from request headers.
   */
  agentProfile?: string;
  /**
   * Anthropic-specific upstream override (global fallback upstream for anthropic-protocol requests).
   * Per-agent override (upstream.agents[agent].url) takes higher priority.
   */
  anthropicUpstream?: {
    url: string;
  };
  /**
   * Opaque private options, forwarded to the extension as-is.
   *
   * Known keys the current cost-guard build understands (still untyped here):
   * `taskArchiveEnabled`, `compress*` / `gate*`, `judge` (enabled, baseUrl,
   * timeouts, everyNToolTurns, latch*), `requestPrepare`, `controlPlane`,
   * analyze/cheap model fields, `agents` (per-agent cheap overrides).
   */
  options: Record<string, unknown>;
}

/**
 * ProxyStorage configuration -- a unified storage abstraction layer that moves injection/skill data from Redis to COS/SQLite/FS.
 * See docs/design/2026-07-10-cos-ttl-nottl-split-plan.md
 *
 * When `enabled: true`, the injection layer and Skill layer use ProxyStorage in place of the Redis repo;
 * otherwise the original Redis path is used entirely. CostGuard's `cg:sess:*` is unaffected.
 *
 * Storage key prefixes come in two tiers:
 *   - `ttl/` -- hot cache (Session Init State / Injection Hook prewarm), paired with a COS
 *     lifecycle rule that auto-deletes objects unmodified for `ttlDays` days. Can be rebuilt if lost, invisible to the business.
 *   - `nottl/` -- business state (Binding / Skill extraction / Skill version lock), **no** rule configured,
 *     retained permanently.
 */
export interface StorageConfig {
  /** Master switch. false = use the original Redis path entirely; this migration code is equivalent to not loaded. */
  enabled: boolean;
  /** Preferred backend; if init fails, degrade in the order cos -> sqlite -> fs -> memory. */
  backend: "cos" | "sqlite" | "fs" | "memory";
  /**
   * Lifetime (days) of objects under the `ttl/` prefix. Applies only to the ttl prefix; nottl is entirely unaffected.
   * Defaults to 7 days, aligned with the granularity of COS lifecycle rules (COS scans daily).
   */
  ttlDays: number;

  cos: {
    /**
     * Business namespace prefix (isolated from core's memory_v2/cos_data).
     * bucket/region/endpointDomain are all parsed from the CosUrl returned by Shark; no configuration needed.
     */
    rootPrefix: string;
    /**
     * Optional: force use of VPC intranet / a custom domain (e.g. `cos.example.com`).
     * If empty, use the host in the CosUrl returned by Shark.
     */
    endpointDomain?: string;
    /**
     * Fetch temporary credentials from Shark -- each spaceId gets its own STS, with permissions strictly bound to
     * the two prefixes `proxy_cache/{ttl|nottl}/{spaceId}/*`.
     * See docs/design/2026-07-12-cos-shark-sts-credential-plan.md §3.1.
     */
    shark: {
      /** Shark base URL, e.g. `http://gateway.example.com:8000`. */
      baseUrl: string;
      /** shark HTTP request timeout. Default 10s. */
      timeoutMs: number;
      /** Retry count for 5xx / 429 / network errors / timeouts. Default 2. */
      retryCount: number;
      /** How many ms before STS expiry to refresh early. Default 2min. */
      refreshBufferMs: number;
      /** Upper limit of the per-spaceId backend pool (LRU). Default 100. */
      maxSpaces: number;
      /** Delay in ms before closing the old backend on LRU evict. Default 30_000. */
      graceCloseDelayMs: number;
    };
  };

  sqlite: {
    /** Empty = use PROXY_DB_PATH or ~/.tdai-memory-proxy/proxy.db. */
    dbPath: string;
  };

  fs: {
    fsRoot: string;
  };
}

/** Redis connection configuration for session store (CostGuard + Injection). */
export interface RedisConfig {
  enabled: boolean;
  /** Redis connection URL (e.g. redis://:password@host:port/db). Overrides host/port/password/db if set. */
  url: string;
  /** Redis host. Default: "127.0.0.1". */
  host: string;
  /** Redis port. Default: 6379. */
  port: number;
  /** Redis password. Default: "". */
  password: string;
  /** Redis database index. Default: 0. */
  db: number;
  /** Key prefix for CostGuard session keys. Default: "cg:sess:". */
  keyPrefix: string;
  /** Session TTL in seconds. Default: 1800 (30 minutes). */
  ttlSeconds: number;
  /** Injection layer TTL override (seconds). Defaults to ttlSeconds. */
  injectionTtlSeconds?: number;
  /**
   * Per-session turn-sequence counter TTL, in days. Default: 30.
   *
   * Must outlive `ttlSeconds` by a wide margin: session state expiring only
   * costs a cache miss, but the turn sequence expiring restarts the session at
   * 1 and collides with the usage rows it already wrote.
   */
  turnSeqTtlDays?: number;
}

/** Per-Memory-instance input-token rate limiting. */
export interface RateLimitConfig {
  /** Input tokens per rolling minute. 0 disables the limiter. */
  tpm: number;
  /** Requests per rolling minute, using the same instance × model dimension. */
  qpm: number;
}

/**
 * Langfuse LLM observability configuration.
 *
 * Reported via the official Langfuse SDK. One trace = one turn (one user input);
 * tool-loop requests within the same turn are merged into multiple generations under the same trace.
 */
export interface LangfuseConfig {
  enabled: boolean;
  /** Langfuse instance base URL, e.g. http://localhost:3000. */
  host: string;
  /** Langfuse public key (pk-lf-...). */
  publicKey: string;
  /** Langfuse secret key (sk-lf-...). */
  secretKey: string;
  /**
   * Debug mode: when reporting generations, keep the original Anthropic body structure
   * (including `cache_control` markers / `thinking` blocks / native tool_use form),
   * instead of flattening via `flattenAnthropicMessagesForOpik`.
   *
   * Use: troubleshooting issues that require seeing the native structure, such as request classification (Fork vs SideQuery vs Main), cache hit rate,
   *      and validity of thinking signatures.
   *
   * Cost: report size grows 2-5x (cache_control blocks and thinking blocks are all carried over),
   *      and Langfuse storage cost increases. **Off by default in production**; turn on only when troubleshooting.
   */
  debug?: boolean;

  // -- Batch reporting tuning (prevents span loss under high concurrency) --

  /**
   * Maximum depth of the in-memory queue (excess is dropped).
   * Maps to OTel BatchSpanProcessor's maxQueueSize. Default 8192.
   */
  maxQueueSize: number;
  /**
   * Maximum number of spans exported per batch.
   * Maps to LangfuseSpanProcessor's flushAt / OTel maxExportBatchSize. Default 256.
   */
  flushAt: number;
  /**
   * Scheduled flush interval (seconds).
   * Maps to LangfuseSpanProcessor's flushInterval / OTel scheduledDelayMillis. Default 2.
   */
  flushInterval: number;
}

/** Session initialization configuration. */
export interface SessionInitConfig {
  enabled: boolean;
  /** Max retries before degrading (bypass session init on next request). */
  maxRetries: number;
  /**
   * Whether to append the `[Agent]` section of the `<session_context>` block
   * (agent id / name / description / prompt) to the system prompt on every
   * request after session init completes.
   *
   * - `true`  (default): inject `[Agent]` — LLM sees agent identity/persona.
   * - `false`          : suppress `[Agent]` — the block loses the agent segment
   *   (and the entire block disappears if `injectTaskContext` is also false).
   *
   * Global toggle; not per-agent. Use to silence all agent descriptions.
   */
  injectAgentContext?: boolean;
  /**
   * Whether to append the `[Task]` section of the `<session_context>` block
   * (task id / name / description / goal) to the system prompt on every
   * request after session init completes.
   *
   * - `true`  (default): inject `[Task]` — LLM sees the task description.
   * - `false`          : suppress `[Task]` — the block loses the task segment
   *   (and the entire block disappears if `injectAgentContext` is also false).
   *
   * Global toggle; not per-task. Use to silence all task descriptions.
   */
  injectTaskContext?: boolean;
  /**
   * DEBUG-ONLY. When set, session init skips the interactive team → agent →
   * task form flow entirely and registers the session with the given identity
   * on the FIRST request that carries a conversation id. Useful for e2e tests
   * and local smoke checks where you want to exercise the injection pipeline
   * without stepping through the fake AskUserQuestion dialog turns.
   *
   * Leave undefined (or omit the block) in production. The identity is not
   * validated against the caller — it is trusted as-is because this is a
   * developer-facing bypass, not a security feature.
   */
  debugForceIdentity?: {
    team_id: string;
    agent_id: string;
    task_id?: string;
  };
  /**
   * DEBUG: force the userId identified from the request (from auth verify / x-user-id header etc.)
   * to be overridden with the specified value. Used for local integration debugging -- when the client-sent tokenhub-uid does not match the kernel-uid
   * (kernel-side assets hang under a different real user_id), so assets cannot be fetched via kernel /team/list,
   * causing the CB state machine to take the "no active agents, passing through" bypass.
   *
   * With this field configured, the handler layer replaces the identified user_id with this one, so the CB state machine
   * fetches the asset list as the real kernel user, and the full team->agent->task form flow pops up.
   *
   * For local/e2e integration only; be sure to leave empty in production.
   */
  debugForceUserId?: string;
  /**
   * DEBUG: enable verbose diagnostic logs (including the request tools schema, system prompt summary,
   * user input text, etc.). Only for local integration debugging of session-init form interaction issues.
   * Be sure to keep false or unset in production (off by default).
   */
  debugVerboseLogging?: boolean;
  /**
   * Automatically preselect team/agent/task identity from request headers.
   *
   * When the first-round request headers already carry identity fields, first validate whether they exist in the team/agent/task
   * lists (visible to the currently authenticated user): on a hit, skip the corresponding interactive selection step; on missing/failed validation, handle per
   * `onMismatch`. Coexists with control-plane token reverse lookup -- the header is only a "shortcut path"
   * and does not change the original form/reverse-lookup flow.
   *
   * Decision rules (see session/preset.ts):
   * - Only team hit (no agent)           -> jump to the agent selection stage
   * - team + agent hit (task optional)   -> register directly, skip all forms
   * - Any "provided" field not found in the list -> treated as mismatch, handled per onMismatch
   * - No team header                      -> follow the original flow entirely (zero behavior change)
   */
  /**
   * When the user chooses "skip" in the task_select stage, this task_id is used as the default association.
   * This task_id need not actually exist in the control-plane metadata -- it is only recorded as a label and does not affect
   * retrieval isolation (primary dimensions are team/user/agent/session).
   *
   * Default "default" (enabled). To disable, set it to an empty string in YAML: `defaultTaskId: ""`.
   */
  defaultTaskId?: string;
  /**
   * Skip the asset_confirm pre-dialog; by default treat the user as having chosen "Yes, associate team assets".
   * When enabled, the first round goes directly into the team -> agent -> task selection flow (or auto-select cascade).
   * Default false (keep original behavior, pop up the asset_confirm dialog).
   */
  skipAssetConfirm?: boolean;
  headerAutoSelect?: {
    /** Whether to enable header auto-preselect. Default true. */
    enabled: boolean;
    /** Header name (lowercase) carrying team_id. Default "x-team-id". */
    teamHeader: string;
    /** Header name (lowercase) carrying agent_id. Default "x-agent-id". */
    agentHeader: string;
    /** Header name (lowercase) carrying task_id. Default "x-task-id". */
    taskHeader: string;
    /** When the header value is not found in the user-visible list: 'form' falls back to the interactive form (default) | 'bypass' skips session init directly. */
    onMismatch: "form" | "bypass";
  };
}

export interface TdaiConfig {
  enabled: boolean;
  endpoint: string;
  apiKey: string;
  serviceId: string;
  memory: {
    enabled: boolean;
    /** Master switch for all TDAI memory prompt injection. */
    inject: boolean;
    writeL0: boolean;
    recallL1: boolean;
    injectL2L3: boolean;
    l1Limit: number;
    l2Limit: number;
    timeoutMs: number;
  };
}

/**
 * Core skill data-plane configuration.
 *
 * The proxy talks to the openclaw-plugin gateway (the "core") for two purposes:
 *   1. RAG-driven `<cloud_skills>` injection (calls /v3/skill/search).
 *   2. Fire-and-forget skill extraction trigger (calls /v3/skill/extract?mode=async).
 *
 * The same `serviceToken` is also injected by the /skill-bridge reverse proxy
 * when the LLM curls skill operations, so that the token never appears in any
 * prompt the LLM sees.
 */
export interface CoreSkillConfig {
  /** Default `http://127.0.0.1:8420`. */
  endpoint: string;
  /** Bearer token for /v3/skill/* and /skill-bridge auth-injection. */
  serviceToken: string;
  /** `x-tdai-service-id` header value. Default `context-proxy`. */
  serviceId: string;
  /** Per-call timeout (ms). Default 1500 — RAG is on the session_init hot path. */
  timeoutMs: number;
}

/**
 * Instance-upstream config cache (per-instance config for custom model routing).
 *
 * On each handler call the proxy uses skill.endpoint + /v3/internal/meta/instance-upstream/list
 * to fetch this spaceId's model group config (three kinds of rows: default / custom / extraction), and caches the result in-process
 * by spaceId. The cache's internal semantics are fixed (hard expiry + stale-if-error + 256 LRU +
 * empty array zero-row fallback = official); this config exposes only one tunable: TTL.
 *
 * See `docs/design/2026-08-25-instance-upstream-config.md` §7.1.
 */
export interface InstanceUpstreamConfig {
  /**
   * Cache TTL (seconds). Default 30. Determines the maximum delay for "Panel changes custom model -> proxy takes effect".
   *
   * Only positive integers accepted; invalid/negative/0/NaN/fractional values all fall back to the default 30s with one warn line.
   * Do not set below 5s: it would turn core /v3/internal/meta/instance-upstream/list into a hotspot.
   */
  cacheTtlSec: number;
}

/**
 * Knowledge tools injector configuration.
 *
 * Independent from `coreSkill` so knowledge gateway routing can diverge from
 * skill (e.g. skill via kernel direct-IP, knowledge via API Gateway).
 * Mirrors `CoreSkillConfig` fields — `CoreKnowledgeClient` accepts the same
 * Pick<endpoint | serviceToken | serviceId | timeoutMs>.
 */
export interface KnowledgeConfig {
  /** Master switch. `false` (default) → injector not registered, no injection. */
  enabled: boolean;
  endpoint: string;
  serviceToken: string;
  serviceId: string;
  timeoutMs: number;
}

/** Skill runtime-side configuration. */
export interface SkillRuntimeConfig {
  /**
   * Whether the main model is allowed to create/modify skills. Default false.
   * The quality of the main model is uncontrollable, so write capability is off by default to avoid low-quality skills being created.
   * When explicitly set to true:
   *   - <skill_tools> injects all 10 tools (including write operations)
   *   - /skill-bridge allows write operations (create/update/patch/delete/files_write/files_remove)
   * When false:
   *   - <skill_tools> injects only read-only tools (search/list/view/files_read)
   *   - /skill-bridge rejects write operations with 403
   */
  allowLlmWrite: boolean;

  // Historical fields (removed):
  //   extractToolCallThreshold / maxBucketCount:
  //     The old SkillExtractTrigger pipeline was used to control the threshold for the proxy to auto-fire /v3/skill/extract.
  //     The old pipeline has been taken offline entirely; core now takes over archive timing (judging by itself on tool_call >= 10 or bytes >= 40KB).
  //   conversationAddEnabled:
  //     Used to be a mutually exclusive gray-release switch between old and new pipelines. Now always uses the new pipeline conversation/add; this switch is deprecated.
}

/**
 * Per-agent upstream override entry. When an agent (identified by URL path
 * prefix like "claude-code") needs a different upstream than the global
 * default, this struct provides the replacement `url` (and optional `apiKey`).
 *
 * Fallback semantics — three cases, matching the runtime `effectiveApiKey`
 * resolution in `handler.ts` / `anthropicHandler.ts`:
 *
 *   ┌──────────────────────────────┬────────────┬──────────────────────────┐
 *   │ agent config                 │ url used   │ apiKey used              │
 *   ├──────────────────────────────┼────────────┼──────────────────────────┤
 *   │ NOT in agents map            │ upstream.url│ upstream.apiKey (global)│
 *   │ in map, url only, no apiKey  │ agent.url  │ passthrough client key  │
 *   │ in map, url + apiKey         │ agent.url  │ agent.apiKey            │
 *   └──────────────────────────────┴────────────┴──────────────────────────┘
 *
 * The presence of an entry cuts the global `upstream.apiKey` fallback —
 * this is intentional so an operator can run some agents on a server-side
 * key and others on the client's own key from a single proxy config.
 *
 * Priority order (high → low):
 *   1. `costGuard`-provided `target.authHeaders` (the cheap-model fallback route brings its own credentials)
 *   2. `upstream.agents[agent].url` + `upstream.agents[agent].apiKey`
 *   3. `costGuard.anthropicUpstream.url` (Anthropic protocol only)
 *   4. `upstream.url` + `upstream.apiKey` (default when no agent matches)
 *
 * The same map serves both Anthropic and OpenAI protocols — the agent name
 * alone determines routing, matching how {@link ProxyConfig#upstream.url}
 * itself is protocol-agnostic.
 */
export interface AgentUpstreamEntry {
  /** Target upstream base URL. Required. */
  url: string;
  /**
   * Per-agent apiKey. When set (non-empty):
   *   - OpenAI: `Authorization: Bearer <apiKey>` is injected
   *   - Anthropic: `x-api-key: <apiKey>` is injected
   * When absent / empty: the client's own auth header is passed through
   * upstream untouched. This does NOT fall back to `upstream.apiKey` —
   * that fallback only applies when this agent has no entry at all.
   */
  apiKey?: string;
}

/** Top-level proxy configuration (merged from config file + CLI args). */
export interface ProxyConfig {
  server: {
    host: string; // default: "0.0.0.0"
    port: number; // default: 8096
    /** Upstream forward timeout in ms. 0 = no timeout. Default: 600_000 (10 min). */
    forwardTimeoutMs?: number;
  };
  upstream: {
    url: string; // OpenAI-compatible upstream URL
    apiKey: string; // if non-empty, replaces the API Key in the request
    /**
     * Per-agent overrides keyed by agent name (URL path prefix, e.g. "claude-code").
     * Empty / missing entry → agent falls back to `url` + `apiKey`.
     */
    agents: Record<string, AgentUpstreamEntry>;
  };
  log: {
    file: string;    // JSONL path; empty string disables file logging
    verbose: boolean;
    level: "info" | "debug"; // "debug" enables internal-debug.jsonl and requests-debug.jsonl
    /** Log backend type for structured logging (noop | console). Default: console. */
    backend: "noop" | "console";
    /** File rotation settings for structured log file (proxy.log). */
    rotate: {
      maxSizeBytes: number;
      backupLimit: number;
    };
  };
  opik: {
    enabled: boolean;
    url: string;    // Opik server base URL
    apiKey: string; // Opik server auth key (optional)
    /** When true, forked request_log traces/spans do not store message content. */
    stripRequestLogContent: boolean;
  };
  langfuse: LangfuseConfig;
  clickhouse: {
    enabled: boolean;
    url: string;         // ClickHouse HTTP endpoint
    database: string;    // Database name
    table: string;       // Table name for usage logs
    /** Raw usage traceability table (non-TokenHub / unrecognized format). */
    rawTable: string;
    user: string;        // Auth user
    password: string;    // Auth password
    flushIntervalMs: number; // Flush interval in ms
    flushThreshold: number;  // Buffer flush threshold in rows
    /** Data retention TTL in days. 0 = no TTL. Default: 0. */
    ttlDays: number;
  };
  redis: RedisConfig;
  rateLimit: RateLimitConfig;
  storage: StorageConfig;
  costGuard: CostGuardConfig;
  creditReport: CreditReportConfig;
  creditPricing: CreditPricingConfig;  // NEW: model pricing for credit calculation
  injection: InjectionConfig;
  extraction: ExtractionConfig;
  sessionInit: SessionInitConfig;
  tdai: TdaiConfig;
  coreSkill: CoreSkillConfig;
  instanceUpstream: InstanceUpstreamConfig;
  knowledge: KnowledgeConfig;
  skillRuntime: SkillRuntimeConfig;
  auth: AuthConfig;
  /**
   * Internal service accounts allowed to passthrough the proxy without any
   * injection / session logic. Match is by `userKey` on inbound Authorization.
   * Empty array (default) disables the feature — every request goes through
   * the standard verifyUserKey pipeline.
   */
  systemUsers: SystemUserEntry[];
  /**
   * Ops-port shared secret, only for control interfaces such as `/v3/instance/proxy-destroy`.
   *
   * Semantics match the core gateway's `server.apiKey`
   * (`tdai-memory-openclaw-plugin/src/gateway/server.ts:1078`):
   *   - Empty string (default) = auth off, routes publicly accessible; a WARN is logged at startup as a reminder
   *   - Non-empty = requests must carry `Authorization: Bearer <apiKey>`, compared in constant time
   *
   * Env override: `TDAI_PROXY_ADMIN_API_KEY`.
   *
   * Note: this key does **not** participate in the tenant `verifyUserKey` flow, and is unrelated to upstream.apiKey /
   * tdai.apiKey. It only gates the proxy-side ops port.
   */
  admin: {
    apiKey: string;
  };
  /**
   * `mem:` special command configuration.
   *
   * Command interception is always enabled (no config switch): after session init the handler checks whether the last user
   * message is a mem: command; if it hits a known command (sync/create-skill/help/create-task/
   * update-task/session-reset), it executes the corresponding action and directly returns a forged LLM response (no injection /
   * no forwarding / no billing); unknown commands fall back to the built-in hint in executeMemCommand.
   *
   * The structure only carries `taskDraft` (the LLM draft generator that create-task / update-task depend on);
   * when not configured, the task command family returns a "task_draft not configured" error; other commands are unaffected.
   */
  memCommand: MemCommandConfig;

  /**
   * Master switch for CC request routing.
   *
   * When enabled: based on `cache_control` marker position + tools/thinking fallback, requests are divided into
   *   main / fork / sidequery three categories, taking differentiated paths (fork/sidequery skip
   *   session-init / mem interception / injection / L0 / skill buffer, credit still reported).
   * When disabled: all requests are treated as main and take the original one-size-fits-all pipeline; behavior is 100% equivalent to the status quo.
   *
   * Off by default. Before enabling, it is recommended to run an observation period of "classify but do not change the path"; see plan §7.
   * See docs/design/2026-07-30-cc-request-routing-plan.md
   */
  ccRequestRouting: CcRequestRoutingConfig;

  /**
   * WorkBuddy request routing master switch (ops kill switch).
   *
   * When enabled (default): calls `classifyWorkbuddyRequest` to divide requests into main / auxiliary
   *   two categories; auxiliary requests are passed through directly (skipping session-init / injection / L0 /
   *   skill archive), credit still reported.
   * When disabled: all requests are treated as main and take the full business pipeline -- equivalent to the old pipeline with aux routing not enabled,
   *   used for quick rollback when aux classification rules go wrong.
   *
   * Enabled by default (unlike CC's `ccRequestRouting.enabled`, which defaults to false): WB's aux
   *   routing has run through in production with log verification; this switch is a "conservative rollback" safety rather than a "gray release" switch.
   */
  workbuddyRequestRouting: WorkbuddyRequestRoutingConfig;

  /**
   * Local JSONL trace archive configuration.
   *
   * When enabled, each trace + span is written as a JSONL line to a local file (one file per date),
   * which can be combined with crontab to periodically compress and upload to COS/S3 archive storage.
   *
   * Off by default. When enabled, it does not affect remote reporting paths such as Opik / Langfuse.
   */
  traceArchive: TraceArchiveConfig;
}

export interface TraceArchiveConfig {
  /** Whether to enable local JSONL trace archiving. Default false (off). */
  enabled: boolean;
  /** Archive directory (relative to the project root or an absolute path). Default "logs/traces". */
  dir: string;
}

export interface CcRequestRoutingConfig {
  /** Whether to enable CC request routing. Default false -- when off, uses the old pipeline fully equivalent to the original behavior. */
  enabled: boolean;
}

export interface WorkbuddyRequestRoutingConfig {
  /** Whether to enable WB request routing. Default true -- when off, all requests are treated as main and aux routing is skipped. */
  enabled: boolean;
}

export interface MemCommandConfig {
  /**
   * Configuration of the LLM draft generator used by mem:create-task / mem:update-task. Optional.
   * When not configured or enabled=false, the task command family returns a "task_draft not configured" error.
   */
  taskDraft?: {
    enabled: boolean;
    model: string;
    url: string;
    apiKey: string;
    timeoutMs: number;
  };
}

/** Context injection configuration. */
export interface InjectionConfig {
  enabled: boolean;
  injectors: string[];  // List of injector names to enable (e.g. ["skill", "knowledge", "tdai-memory"])
  /**
   * Unified external gateway address. The curl examples generated by the LLM (paths embedded in the <skill_tools> /
   * <tdai_memory_tools> sections) all use this URL as the base.
   *
   * ⚠️ Required for multi-node deployments: when unset, each pod falls back to its own `http://<hostIp>:<port>`,
   * pods overwrite the same hook cache in COS -> md5 oscillation -> upstream Anthropic
   * KV cache misses every time (costs money + slow first token).
   *
   * Just fill in the gateway's external domain, **without a port** (the port the gateway routes internally to the proxy
   * is a matter for gateway ops and unrelated here). Example:
   *   externalGatewayUrl: "https://gateway.example.com"
   *
   * The gateway side must pass the following two prefixes through to the proxy pod unchanged:
   *   `/skill-bridge/**`   → proxy /skill-bridge/**
   *   `/memory-bridge/**`  → proxy /memory-bridge/**
   *
   * When unset, falls back to `http://<local hostIp>:<config.server.port>` (only usable in
   * single-node / local development scenarios), warning once at startup.
   */
  externalGatewayUrl?: string;
  /**
   * Asset reflection mode (for internal effect evaluation). **Enabled by default** -- so that operators can observe asset injection effects
   * via URL marker with zero configuration. The marker itself is still opt-in: requests without the `/analyse/`
   * segment are completely unaffected.
   *
   * When enabled, if the request path carries the `/analyse` marker (same structure as `/cost-guard`: sandwiched
   * after `/{agent}/{spaceId}`, e.g. `/codebuddy/default/analyse/v1/messages`),
   * the proxy appends an `<asset_reflection>` block at the end of the system prompt, guiding the
   * agent to comment in its answer on "whether the cloud asset tools called this round were useful".
   *
   * The marker segment list is determined by the asset injectors actually registered on this node (skill /
   * tdai-memory / knowledge); when none is registered, the injector emits no block.
   *
   * Style aligned with `costGuard.markerOptIn`, but with the opposite default:
   *   - `true` (default): injector registers; emits the block only when the URL carries the `/analyse/` segment
   *   - `false`: injector does not register and the top gate rejects the `/analyse/` segment with 404
   */
  assetReflection?: {
    markerOptIn: boolean;
  };
}

/**
 * Extraction (write-side) configuration — dual of {@link InjectionConfig}.
 *
 * Governs whether the proxy is allowed to write back per-turn artifacts to
 * the kernel: skill conversation (fire /v3/skill/conversation/add per round
 * -- core-side buffer + archive threshold decide when to extract) and TDAI L0
 * conversation memory (`addConversation` after each turn).
 *
 * Legacy behavior (yaml missing this section entirely) is preserved by
 * `isExtractionAllowed`: it returns `true` when `config.extraction` is
 * absent. Default values `{enabled: true, extractors: ["skill","tdai-memory"]}`
 * also match the previous "always on" semantics.
 */
export interface ExtractionConfig {
  enabled: boolean;
  /** Asset whitelist. Assets NOT in this array are gated OFF, even if the
   *  underlying dependency (kernel token / tdai config) is present. */
  extractors: string[];
}

/** Auth service configuration — verify user_key and resolve user_id via auth/verify API. */
export interface AuthConfig {
  enabled: boolean;
  /** Auth service base URL (e.g. http://kernel.example.com:8420). */
  url: string;
  /** Request timeout in ms. Default: 5000. */
  timeoutMs: number;
}

/**
 * Internal / system user entry — a user id that identifies an internal
 * service (e.g. TDAI memory backend) rather than an end user.
 *
 * The request's Authorization / x-api-key is first resolved to a user_id
 * by the auth service (verifyUserKey). If that user_id equals this entry's
 * `userId`, the proxy short-circuits: session-init, injection, routing
 * decisions, and body rewriting are all skipped, and the request is forwarded
 * as-is to `config.upstream.url`. Usage / credit reporting still fires,
 * attributed to this entry's `userId` (memory instance / spaceId comes from
 * the request path).
 *
 * Auth must be enabled for the short-circuit to trigger — when it's off,
 * `verifyUserKey` returns an empty user_id and matching cannot happen.
 */
export interface SystemUserEntry {
  /** Short logical name — used for logging (e.g. "memory", "wiki", "skill"). */
  name: string;
  /**
   * User id attributed to this internal user. This is BOTH the match key
   * (against verifyUserKey's resolved user_id) and the attribution key for
   * usage/credit reporting. Required.
   */
  userId: string;
  /** Human-readable display name, for logs / dashboards only. */
  displayName: string;
  /**
   * Historical sk-mem key the internal service sends in Authorization /
   * x-api-key. Kept for log-only / operator-reference purposes; no longer
   * participates in matching (that's `userId`'s job now). Optional.
   */
  userKey?: string;
}

/** Credit usage reporting to external service (e.g. TDAI MemoryPlus). */
export interface CreditReportConfig {
  /** POST endpoint URL. */
  url: string;
  /** Request timeout in ms. */
  timeoutMs: number;
}

/** Credit pricing entry for a single model (Credit / 1K Token). */
/**
 * Tiered pricing entry. A tier is matched by total input tokens (nonCacheInput + cacheRead),
 * and all token types of that request are billed at that tier's unit price (whole-request tiering, not progressive).
 *
 * The `tiers` array must be sorted ascending by `maxInputTokens`; the last tier uses `null` as the fallback (no upper limit).
 */
export interface PricingTier {
  /** Upper limit (inclusive) of input tokens for this tier. null = fallback tier (no upper limit). */
  maxInputTokens: number | null;
  /** Standard input tokens (non-cache) — credit per 1K tokens. */
  input: number;
  /** Output tokens — credit per 1K tokens. */
  output: number;
  /** Cache read (cache hit) tokens — credit per 1K tokens. */
  cacheRead: number;
  /** Cache write with 5-minute TTL (ephemeral) — credit per 1K tokens. */
  cacheWrite5m: number;
  /** Cache write with 1-hour TTL (standard cache creation) — credit per 1K tokens. */
  cacheWrite1h: number;
}

/** A complete set of token prices, optionally split by total input length. */
export interface TieredPricing {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  tiers?: PricingTier[];
}

export type PricingWeekday = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

/** A half-open local-time interval: start is inclusive, end is exclusive. */
export interface PricingTimeRange {
  start: string;
  end: string;
}

/** Conditions for choosing a time-based price rule. Omitted fields match all requests. */
export interface PricingRuleWhen {
  weekdays?: PricingWeekday[];
  timeRanges?: PricingTimeRange[];
}

/** A time-based price override. Highest priority matching rule wins. */
export interface PricingRule {
  id: string;
  priority?: number;
  when?: PricingRuleWhen;
  pricing: TieredPricing;
}

export interface CreditPricingEntry extends TieredPricing {
  /**
   * Model ID for matching (case-insensitive full-word match against usage.model).
   * Semantics are a "unique ID", e.g. `ep-pksklwtb` / `deepseek-v4-pro`.
   */
  name: string;
  /**
   * Human-readable display name for UI/reports (e.g. "Claude Sonnet 4").
   * Optional. Falls back to `name` when absent or empty.
   * Written to usage_logs.model_name / usage_raw.model_name for frontend display.
   */
  modelName?: string;
  /**
   * Tiered pricing by total input tokens (nonCacheInput + cacheRead).
   * Sorted ascending; the last tier's maxInputTokens is null (fallback).
   * When not configured, use the top-level input/output/cacheRead/cacheWrite5m/cacheWrite1h unit prices.
   */
  rules?: PricingRule[];
}

/** Credit pricing configuration section. */
export interface CreditPricingConfig {
  models: CreditPricingEntry[];
  /**
   * IANA timezone name (e.g. "Asia/Shanghai") used as the timezone anchor when ClickHouse shards by day.
   * Optional; when omitted, the ClickHouse server's default timezone is used. Only set explicitly in tests.
   */
  timezone?: string;
}

/** Raw YAML config file shape (all fields optional). */
export interface RawYamlConfig {
  server?: {
    host?: string;
    port?: number;
    forwardTimeoutMs?: number;
  };
  upstream?: {
    url?: string;
    apiKey?: string;
    /** Per-agent override map. See `AgentUpstreamEntry`. */
    agents?: Record<string, { url?: string; apiKey?: string } | null | undefined>;
  };
  log?: {
    file?: string;
    verbose?: boolean;
    level?: "info" | "debug";
    backend?: "noop" | "console";
    rotate?: {
      maxSizeBytes?: number;
      backupLimit?: number;
    };
  };
  opik?: {
    enabled?: boolean;
    url?: string;
    apiKey?: string;
    stripRequestLogContent?: boolean;
  };
  redis?: {
    enabled?: boolean;
    url?: string;
    host?: string;
    port?: number;
    password?: string;
    db?: number;
    keyPrefix?: string;
    ttlSeconds?: number;
    injectionTtlSeconds?: number;
    turnSeqTtlDays?: number;
  };
  rateLimit?: {
    tpm?: number;
    qpm?: number;
  };
  storage?: {
    enabled?: boolean;
    backend?: "cos" | "sqlite" | "fs" | "memory";
    ttlDays?: number;
    cos?: {
      rootPrefix?: string;
      endpointDomain?: string;
      shark?: {
        baseUrl?: string;
        timeoutMs?: number;
        retryCount?: number;
        refreshBufferMs?: number;
        maxSpaces?: number;
        graceCloseDelayMs?: number;
      };
    };
    sqlite?: { dbPath?: string };
    fs?: { fsRoot?: string };
  };
  costGuard?: {
    enabled?: boolean;
    agentProfile?: string;
    anthropicUpstream?: { url?: string };
    /** Opaque private options, kept unparsed and forwarded to the extension. */
    [key: string]: unknown;
  };
  clickhouse?: {
    enabled?: boolean;
    url?: string;
    database?: string;
    table?: string;
    rawTable?: string;
    user?: string;
    password?: string;
    flushIntervalMs?: number;
    flushThreshold?: number;
    ttlDays?: number;
  };
  langfuse?: {
    enabled?: boolean;
    host?: string;
    publicKey?: string;
    secretKey?: string;
    debug?: boolean;
    maxQueueSize?: number;
    flushAt?: number;
    flushInterval?: number;
  };
  creditReport?: { url?: string; timeoutMs?: number };
  creditPricing?: {
    models?: (Partial<CreditPricingEntry> & {
      tiers?: Partial<PricingTier>[];
      rules?: (Partial<PricingRule> & {
        when?: PricingRuleWhen;
        pricing?: Partial<TieredPricing> & { tiers?: Partial<PricingTier>[] };
      })[];
    })[];
  };
  /** Opaque private review options, forwarded to the extension untouched. */
  badcaseCollector?: Record<string, unknown>;
  injection?: {
    enabled?: boolean;
    endpoint?: string;
    injectors?: string[];
    externalGatewayUrl?: string;
    assetReflection?: {
      markerOptIn?: boolean;
    };
  };
  extraction?: {
    enabled?: boolean;
    extractors?: string[];
  };
  sessionInit?: {
    enabled?: boolean;
    maxRetries?: number;
    injectAgentContext?: boolean;
    injectTaskContext?: boolean;
    defaultTaskId?: string;
    /** One step: when both preselected team/agent hit, skip asset_confirm and go straight to initialized. */
    skipAssetConfirm?: boolean;
    debugForceIdentity?: {
      team_id?: string;
      agent_id?: string;
      task_id?: string;
    };
    debugForceUserId?: string;
    debugVerboseLogging?: boolean;
    headerAutoSelect?: {
      enabled?: boolean;
      teamHeader?: string;
      agentHeader?: string;
      taskHeader?: string;
      onMismatch?: "form" | "bypass";
    };
  };
  tdai?: {
    enabled?: boolean;
    endpoint?: string;
    apiKey?: string;
    serviceId?: string;
    memory?: Partial<TdaiConfig["memory"]>;
  };
  /**
   * Skill/Kernel bridge config. Historically named `coreSkill`; accepted under
   * either `skill:` or `coreSkill:` in YAML (see `buildConfig`). Internally
   * still stored as `coreSkill` on ProxyConfig — no code churn beyond the
   * YAML alias.
   */
  skill?: Partial<CoreSkillConfig>;
  coreSkill?: Partial<CoreSkillConfig>;
  instanceUpstream?: Partial<InstanceUpstreamConfig>;
  knowledge?: Partial<KnowledgeConfig>;
  skillRuntime?: {
    allowLlmWrite?: boolean;
  };
  auth?: {
    enabled?: boolean;
    url?: string;
    timeoutMs?: number;
  };
  systemUsers?: Partial<SystemUserEntry>[];
  admin?: {
    apiKey?: string;
  };
  /**
   * mem: command family config (including the LLM draft generator for create-task / update-task).
   * Corresponds to ProxyConfig.memCommand; command interception is always enabled; if taskDraft is not configured, the task command family follows the existing fallback behavior.
   */
  memCommand?: {
    taskDraft?: {
      enabled?: unknown;
      model?: unknown;
      url?: unknown;
      apiKey?: unknown;
      timeoutMs?: unknown;
    };
  };
  traceArchive?: {
    enabled?: boolean;
    dir?: string;
  };
}

/** request event — written when a request is intercepted (metadata only, no messages). */
export interface RequestLogEntry {
  timestamp: string;
  event: "request";
  modelId: string;
  keyId: string; // SHA-256(apiKey).slice(0, 8)
  sessionKey?: string; // conversationId || keyId — per-conversation isolation key
  upstreamUrl: string;
  stream: boolean;
  temperature?: number;
  maxTokens?: number;
  routedFrom?: string;     // original model if routing was applied
  routingPercent?: number;  // routing rule percent that triggered
  /**
   * Upstream request id — read from the response header `x-request-id`
   * (typically set by tokenhub / OpenAI-compatible gateways). Empty when
   * upstream did not return one. Used for cross-system tracing/audit.
   */
  upstreamRequestId?: string;
  /**
   * pipeline-internal traceId (uuidv7, for log correlation);
   * the codex runner stuffs it into request events to ease cross-protocol joins.
   */
  traceId?: string;
}

/** usage event — written after LLM response is received. */
export interface UsageLogEntry {
  timestamp: string;
  event: "usage";
  modelId: string;
  keyId: string;
  sessionKey?: string; // conversationId || keyId — per-conversation isolation key
  /** Turn sequence number within the session (for per-turn aggregation). */
  turnSeq?: number;
  /** Denoised user input of the turn (non-empty only on the turn's first request). */
  userInput?: string;
  upstreamUrl: string;
  stream: boolean;
  usage: Record<string, unknown>; // raw LLM usage object, unmodified
  /** Request receipt time used for deterministic time-based credit pricing. */
  requestReceivedAt?: string;
  routedFrom?: string;     // original model if routing was applied
  /**
   * Scalar counters reported by the optional private request-preparation
   * stage, recorded verbatim. The host neither defines nor interprets the key
   * set — it varies with the extension version, and omitting the field means
   * the stage did not run. See `request-prepare-adapter.ts`.
   */
  extensionStats?: Record<string, unknown>;
  /** Space/tenant ID extracted from /proxy/<spaceId>/... path. */
  spaceId?: string;
  /**
   * Upstream request id — read from the response header `x-request-id`
   * (typically set by tokenhub / OpenAI-compatible gateways). Empty when
   * upstream did not return one. Used for cross-system tracing/audit.
   */
  upstreamRequestId?: string;
}

/**
 * Extension-emitted telemetry event.
 *
 * Emitted by the optional private extension (when loaded) via the injected
 * `writeLogEvent` callback. The host only forwards the payload to the log sink
 * — it does not interpret or generate this event on its own.
 *
 * The field set intentionally mirrors {@link UsageLogEntry} so downstream log
 * consumers can process both events with a single schema; `event` distinguishes
 * them at query time.
 */
export interface AnalyzerUsageLogEntry {
  timestamp: string;
  event: "analyzer_usage";
  modelId: string;
  keyId: string;
  sessionKey?: string;
  turnSeq?: number;
  upstreamUrl: string;
  stream: false;
  usage: Record<string, unknown>;
  /** Original model ID captured for correlation with the parent request. */
  routedFrom?: string;
  spaceId?: string;
  upstreamRequestId?: string;
}

export type LogEntry = RequestLogEntry | UsageLogEntry | AnalyzerUsageLogEntry;
