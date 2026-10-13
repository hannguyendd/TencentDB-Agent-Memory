/** Hono app factory — registers all routes. */

import { Hono } from "hono";
import { runOpenaiChatPipeline as handleChatCompletions } from "./pipeline/runners/openai-chat.js";
import { runAnthropicPipeline as handleAnthropicMessages } from "./pipeline/runners/anthropic.js";
import { runUtilityPipeline as handleAuxiliaryEndpoint } from "./pipeline/runners/utility.js";
import { runDirectPipeline as handleDirectPassthrough } from "./pipeline/runners/direct.js";
import { runCodexPipeline as handleCodexEndpoint } from "./pipeline/runners/codex.js";
import { runWorkbuddyPipeline as handleWorkbuddyEndpoint } from "./pipeline/runners/workbuddy.js";
import { handleModels } from "./modelsHandler.js";
import { apiKeyToKeyId, extractBearerToken } from "./opik.js";
import { createSkillBridgeHandler } from "./skill/skill-bridge.js";
import { createMemoryBridgeHandler } from "./memory/memory-bridge.js";
import { createInstanceDestroyHandler } from "./routes/instance-destroy.js";
import { createRateLimitHandlers } from "./routes/rate-limits.js";
import { createModelAliasHandler } from "./routes/model-aliases.js";
import { hasAnalyseMarker, hasCostGuardMarker } from "./routes/whitelist.js";
import { tryActivateStorage, tryActivateRedis } from "./injection/index.js";
import { getEffectiveBackend } from "./storage/factory.js";
import type { ProxyConfig } from "./types.js";

export function createApp(config: ProxyConfig): Hono {
  const app = new Hono();

  // Eagerly activate storage/bindingRepo so bridge-only requests (no main
  // /v1/messages hits yet) can still recover session state via L2 fallthrough
  // (memory-bridge.ts / skill-bridge.ts §6.1 fix). Idempotent; the injection
  // pipeline will still call these later when the first main request lands.
  if (!tryActivateStorage(config)) {
    tryActivateRedis(config);
  }

  // `/cost-guard` marker gate (P0 prerequisite):
  // When markerOptIn=false the marker is fully void -- any request whose path carries a `/cost-guard/` segment
  // gets a 404 directly, so the catch-all `POST /*` does not swallow it and route it as the default (which would be confusing:
  // the client thinks it has "enabled the marker", yet the proxy handles it as default_passthrough).
  // Placed first, ahead of all business routes.
  if (!config.costGuard.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasCostGuardMarker(c.req.path)) {
        return c.json(
          {
            error: "cost_guard_marker_disabled",
            message:
              "The /cost-guard URL marker is disabled on this deployment. " +
              "Remove the /cost-guard segment from the path, or set costGuard.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // `/analyse` marker gate (structure fully aligned with cost-guard):
  // When assetReflection.markerOptIn=false any request with an `/analyse/` segment gets a 404,
  // preventing the catch-all from silently swallowing marker requests and treating them as the default path. Previously only the primary
  // route had a registration switch and lacked this top-level rejection -- `/analyse` marker requests on the CC/CB side
  // would fall through to the catch-all `POST /*` when markerOptIn=false, so upstream
  // received a bare body (the marker client thinks it is "enabled" but never went through the injector); the codex side
  // showed the same symptom (the `/analyse` variants other than `/cost-guard` in the P1-6 report). Fixed
  // together, keeping the two marker gates symmetric.
  if (!config.injection?.assetReflection?.markerOptIn) {
    app.use("*", async (c, next) => {
      if (hasAnalyseMarker(c.req.path)) {
        return c.json(
          {
            error: "analyse_marker_disabled",
            message:
              "The /analyse URL marker is disabled on this deployment. " +
              "Remove the /analyse segment from the path, or set " +
              "injection.assetReflection.markerOptIn=true.",
          },
          404,
        );
      }
      await next();
    });
  }

  // Health check
  //
  // Multi-node scenario: when a storage request asks for cos but degrades to in-process (fs / memory / sqlite),
  // return 503 + degraded=true so the k8s LB removes that pod, avoiding data-consistency incidents like "two nodes each writing to their
  // own memory". sqlite also counts as process-local -- local files on multiple nodes are
  // not shared either. See docs/design/2026-07-13-proxy-multinode-state-audit.md P0-2.
  app.get("/health", (c) => {
    const eff = getEffectiveBackend();
    const wantsShared = config.storage?.enabled && eff.requested === "cos";
    const degraded = wantsShared && eff.effective !== eff.requested;
    const body = {
      status: degraded ? "degraded" : "ok",
      version: "0.2.0",
      upstream: config.upstream.url,
      opik: config.opik.enabled ? config.opik.url : "disabled",
      costGuard: config.costGuard.enabled ? "enabled" : "disabled",
      rateLimit: config.rateLimit.tpm > 0 || config.rateLimit.qpm > 0 ? "enabled" : "disabled",
      storage: {
        enabled: !!config.storage?.enabled,
        requested: eff.requested,
        effective: eff.effective,
        degraded,
        ...(eff.error ? { lastError: eff.error } : {}),
      },
    };
    return c.json(body, degraded ? 503 : 200);
  });

  // Whoami: resolve API key → key ID (plain text, easy to use with curl)
  app.get("/whoami", (c) => {
    // Support: Authorization header (Bearer), x-api-key header, or ?key= query param
    const authHeader = c.req.header("authorization") ?? c.req.header("Authorization") ?? "";
    const bearerToken = extractBearerToken(authHeader);
    const xApiKey = c.req.header("x-api-key") ?? "";
    const queryKey = c.req.query("key") ?? "";

    const apiKey = bearerToken || xApiKey || queryKey;

    if (!apiKey) {
      return c.text("Error: No API key provided. Use ?key=YOUR_KEY\n", 400);
    }

    const keyId = apiKeyToKeyId(apiKey);
    return c.text(keyId + "\n");
  });

  // ── /direct/* — pure route passthrough channel (must be placed before all business routes) ────────────────
  // Completely bypasses cost-guard / auth / model alias / thinking sanitize;
  // but retains opik trace/span reporting and jsonl usage persistence (only effective for Anthropic messages
  // and OpenAI chat/completions). See the header comment of directHandler.ts for details.
  app.all("/direct/*", (c) => handleDirectPassthrough(c, config));

// Skill bridge: LLM curls land here, proxy injects auth + identity, forwards to core.
  // MUST be registered before the agent-prefixed `/:agent/v1/*` routes below.
  const bridgeHandler = createSkillBridgeHandler(config);
  app.post("/skill-bridge/*", (c) => bridgeHandler(c));

  // Memory bridge: same pattern but reverse-proxies the tdai L0/L1/L2/L3 read-only interfaces.
  // Lets the LLM call <proxy>/memory-bridge/v3/atomic/search etc. via Bash, with the proxy injecting identity.
  const memoryBridgeHandler = createMemoryBridgeHandler(config);
  app.post("/memory-bridge/*", (c) => memoryBridgeHandler(c));

  // ── Ops endpoint (registered before the catch-all `POST /*`) ───────────────────────
  // /v3/instance/proxy-destroy — when shark destroys an instance, cleans up the proxy-side COS cache +
  // kernel-sts pool. Contract fields are aligned with core `/v3/instance/destroy`, and the path uses the
  // `proxy-destroy` action to distinguish it from core. Auth uses config.admin.apiKey (public if empty).
  const instanceDestroyHandler = createInstanceDestroyHandler(config);
  app.post("/v3/instance/proxy-destroy", (c) => instanceDestroyHandler(c));

  const rateLimitHandlers = createRateLimitHandlers(config);
  app.get("/v3/admin/rate-limits", rateLimitHandlers.get);
  app.put("/v3/admin/rate-limits", rateLimitHandlers.put);
  app.delete("/v3/admin/rate-limits", rateLimitHandlers.delete);

  app.get("/v3/admin/model-aliases", createModelAliasHandler(config));

  // ── Session management endpoints (underlying interface of the mem: command, reusable by the panel frontend) ──
  app.post("/v3/session/refresh-cache", (c) => {
    return import("./routes/session-refresh.js").then(({ createSessionRefreshHandler }) =>
      createSessionRefreshHandler(config)(c),
    );
  });
  app.post("/v3/session/force-archive-skill", (c) => {
    return import("./routes/session-force-archive.js").then(({ createSessionForceArchiveHandler }) =>
      createSessionForceArchiveHandler(config)(c),
    );
  });

  // ── Whitelisted primary endpoints ────────────────────────────────────────
  app.post("/v1/messages", (c) => handleAnthropicMessages(c, config));

  // ── Whitelisted auxiliary endpoints (must precede catch-all) ─────────────
  // These endpoints use a lightweight passthrough handler (they do not enter the routing module and do not constitute a conversation turn).
  // See docs/design/2026-07-02-arbitrary-path-passthrough-design.md
  app.post("/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // Agent-prefixed routes with spaceId — standard client configuration format:
  //   CC:  ANTHROPIC_BASE_URL=http://<proxy>:8096/claude-code/<spaceId>
  //   CB:  OPENAI_BASE_URL=http://<proxy>:8096/codebuddy/<spaceId>
  // Path example: /claude-code/mem-example001/v1/messages
  //          /codebuddy/mem-example001/v1/chat/completions
  // `/cost-guard` marker: after the primary handler detects this segment it enables cost-guard routing;
  // the default path (without the marker) skips the router and passes through to upstream directly.
  //
  // The marker mechanism is gated by `config.costGuard.markerOptIn`:
  //   - false (default/production): these two routes are not registered -- all requests go through `/:agent/:spaceId/v1/...`,
  //     useGuard is always true inside the handler, behavior equals the historical "default through router". Then any
  //     `/cost-guard/...` request hits no route and reaches the final catch-all or returns 404
  //     (the catch-all `/*` exists and falls through to handleChatCompletions; a marker->404 rejection
  //     was added at the top below, see handler / anthropicHandler).
  //   - true (test environment): the two marker routes below are registered; inside the handler the marker decides
  //     whether to go through the router.
  // See `hasCostGuardMarker`.
  // Hono matches the more specific path first, so these must be registered before the generic `/:agent/:spaceId/v1/...`.
  if (config.costGuard.markerOptIn) {
    app.post("/:agent/:spaceId/cost-guard/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    // Sub-mode markers: `/cost-guard/pre` (compress only) and `/cost-guard/cheap` (route only).
    // Handler internally resolves mode via resolveCostGuardMode — these routes just ensure Hono
    // catches the 6-segment paths instead of falling through to catch-all.
    app.post("/:agent/:spaceId/cost-guard/pre/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/cost-guard/pre/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/:agent/:spaceId/cost-guard/cheap/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/cost-guard/cheap/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // `/analyse` marker (asset-reflection internal effect evaluation) -- fully symmetric with cost-guard:
  // gated by `injection.assetReflection.markerOptIn`. The marker is just a transparent flag;
  // once the handler (AssetReflectionInjector) detects it, it appends <asset_reflection> at the end of the system prompt;
  // requests without the marker take the original normal routes.
  //
  // ⚠️ Key: if these two routes are not registered, `/{agent}/{spaceId}/analyse/v1/messages`
  // (5 segments) falls through to the bottom catch-all `POST /*` → handleChatCompletions
  // (OpenAI handler), sending an Anthropic body to an OpenAI endpoint → upstream 400. So whenever
  // markerOptIn=true these two anthropic/openai 5-segment routes must be registered explicitly.
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/:agent/:spaceId/analyse/v1/messages", (c) => handleAnthropicMessages(c, config));
    app.post("/:agent/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // ── Codex endpoints (must precede generic /:agent/:spaceId routes) ────────
  // The Codex CLI client uses the OpenAI Responses API, a third independent protocol path.
  //
  // Client behavior difference: in codex-rs core/src/client.rs the endpoint constant is `/responses`
  // (without /v1), while the CC/CB clients' constants are `/v1/messages` `/v1/chat/completions`
  // (with /v1). User base_url conventions:
  //   - CC/CB: base has no /v1, the client appends /v1/messages etc. automatically
  //   - Codex: base must include /v1, the client appends /responses
  //
  // To make the onboarding for the three agents uniform for users (base is always `/<agent>/<spaceId>`
  // without /v1), the proxy accepts both paths **with v1** and **without v1**:
  //   /codex/<spaceId>/v1/responses  ← hit when the codex client base includes v1
  //   /codex/<spaceId>/responses     ← hit when the codex client base has no v1 (aligned with CC/CB usage)
  // Both paths map to handleCodexEndpoint with identical behavior.
  app.post("/codex/:spaceId/v1/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/v1/responses", (c) => handleCodexEndpoint(c, config));
  // Compatible with the base_url-without-/v1 form (aligned with CC/CB user experience)
  app.post("/codex/:spaceId/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/codex/:spaceId/responses", (c) => handleCodexEndpoint(c, config));

  // ── Workbuddy endpoints (must precede generic /:agent/:spaceId routes) ────
  // The WorkBuddy CLI/Desktop client uses the OpenAI Responses API (same protocol as Codex),
  // but client behavior differs from codex-cli (more sub-paths: compact / trace_summarize
  // / realtime / memories are aux; the main endpoint is /v1/responses).
  //
  // Like CC/CB/Codex, supports both base_url with and without /v1.
  app.post("/workbuddy/:spaceId/v1/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/v1/responses", (c) => handleWorkbuddyEndpoint(c, config));
  // Compatible with the base_url-without-/v1 form
  app.post("/workbuddy/:spaceId/responses/compact", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/memories/trace_summarize", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/realtime/calls", (c) => handleWorkbuddyEndpoint(c, config));
  app.post("/workbuddy/:spaceId/responses", (c) => handleWorkbuddyEndpoint(c, config));

  // Codex-side `/cost-guard` / `/analyse` marker routes -- fully aligned with CC/CB:
  // the marker is an independent segment in the URL (after `/{agent}/{spaceId}`), with the same gate switch.
  // Without registering these routes, the 5-segment path `/codex/{spaceId}/cost-guard/responses` neither
  // matches the 8 exact codex routes above nor any agent-prefixed route, and falls
  // through to the catch-all `POST /*` → handleChatCompletions, which sends the Responses API
  // body to the OpenAI /chat/completions upstream that returns a 200 chatcmpl-*, crashing the client.
  //
  // `/cost-guard` semantics: after the primary handler detects this segment it enables cost-guard routing;
  //   the codex-side handler needs to read hasCostGuardMarker in forwardToUpstream
  //   to decide whether to go through the router. (Currently codexHandler.ts has not yet wired up resolveForwardTarget,
  //   see the P1-6 report; this commit only fixes route registration and the silent 200 from fall-through,
  //   so requests first reach codexHandler. Actual support for cost-guard router
  //   splitting is handled in a separate commit.)
  //
  // `/analyse` semantics: after AssetReflectionInjector detects this segment it appends the `<asset_reflection>`
  //   reflection block at the end of the system prompt; codexHandler.ts already passes requestPath
  //   to the injection pipeline (see `requestPath:
  //   c.req.path` in the injection section of codexHandler.ts), so once the route registers the `/analyse` marker it takes effect for codex immediately.
  if (config.costGuard.markerOptIn) {
    app.post("/codex/:spaceId/cost-guard/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/pre/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/pre/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/cheap/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/cost-guard/cheap/responses", (c) => handleCodexEndpoint(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/codex/:spaceId/analyse/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/codex/:spaceId/analyse/responses", (c) => handleCodexEndpoint(c, config));
  }

  // ── deepseek-harness (dsh) endpoints ──────────────────────────────────────
  // dsh is DeepSeek's official agent harness; protocol = standard OpenAI Chat Completions
  // (POST /chat/completions + SSE), body/messages shape 100% compatible with the existing CB handler.
  //
  // Client behavior differences (verified from captured fixtures/*.req.json,
  // see docs/dsh-recon/2026-08-14-dsh-capture-analysis.md):
  //   - dsh source endpoint constant: `${baseURL}/chat/completions` (**no /v1**,
  //     see packages/llm/llm-deepseek/src/adapter.ts:301)
  //   - Recommended user config: OPENAI_BASE_URL=http://<proxy>:8096/dsh/<spaceId>
  //   - Aligned with CC/CB/Codex/Workbuddy convention, accepts both paths **with v1** and **without v1**,
  //     the user may set baseURL to `.../dsh/<spaceId>` or `.../dsh/<spaceId>/v1`
  //
  // Recognition of the main / title / compaction request types is not done at the routing layer; it is decided by classifyRequest in agent-adapters/dsh.ts
  // from header + body characteristics (see its doc).
  app.post("/dsh/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));
  app.post("/dsh/:spaceId/chat/completions", (c) => handleChatCompletions(c, config));
  // dsh v0.2+ switches to the anthropic protocol -- the llm-deepseek-api-key adapter hard-sends
  // `${baseURL}/v1/messages` + `anthropic-version: 2023-06-01` (source
  // packages/llm/llm-deepseek/src/adapter.ts:120-131, verified by capture on 2026-09-29).
  // Mount it explicitly rather than relying on the wildcard /:agent/:spaceId/v1/messages fallback (mounting is harmless, but it is clearer
  // to align with the CC/CB approach).
  app.post("/dsh/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/dsh/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  // dsh captures have not shown embeddings/moderations/completions so far; aux endpoints are reserved (symmetric with CC/CB)
  app.post("/dsh/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/dsh/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));

  // dsh cost-guard / analyse marker routes -- fully symmetric with CC/CB/Codex.
  // Per the codex comment: these four 5-segment paths must be registered explicitly, otherwise they fall through to the catch-all
  // POST /* (default path) and the marker silently stops working.
  if (config.costGuard.markerOptIn) {
    app.post("/dsh/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/pre/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/pre/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/cheap/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/cost-guard/cheap/chat/completions", (c) => handleChatCompletions(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/dsh/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/dsh/:spaceId/analyse/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // opencode cost-guard / analyse marker routes -- fully symmetric with CC/CB/Codex/dsh.
  // The opencode client uses standard OpenAI Chat Completions (POST /v1/chat/completions),
  // whose path shape is in the same family as CB/dsh; so the marker-segment route shape matches dsh:
  //   /opencode/{spaceId}/cost-guard/v1/chat/completions
  //   /opencode/{spaceId}/cost-guard/chat/completions (when the client base has no /v1)
  // If these 5-segment paths are not registered explicitly they fall through to the catch-all POST /*, and the marker silently stops working.
  // Router splitting is already passed to resolveForwardTarget in handler.ts via agentName=agentFromPath("opencode"),
  // so as long as the route hits, the Router can decide per the agentSource=opencode branch.
  if (config.costGuard.markerOptIn) {
    app.post("/opencode/:spaceId/cost-guard/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/cost-guard/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/cost-guard/pre/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/cost-guard/pre/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/cost-guard/cheap/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/cost-guard/cheap/chat/completions", (c) => handleChatCompletions(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/opencode/:spaceId/analyse/v1/chat/completions", (c) => handleChatCompletions(c, config));
    app.post("/opencode/:spaceId/analyse/chat/completions", (c) => handleChatCompletions(c, config));
  }

  // OpenAI Models API — tenant-scoped and generated locally from the public pricing catalog.
  app.get("/:agent/:spaceId/v1/models", (c) => handleModels(c, config));
  app.post("/:agent/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/:agent/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  // Chat completions catch — the runner internally dispatches codebuddy/dsh/opencode/pi by the URL agent segment
  app.post("/:agent/:spaceId/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Agent-prefixed routes without spaceId (deprecated: no credit reporting)
  app.post("/:agent/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/:agent/v1/chat/completions", (c) => handleChatCompletions(c, config));

  // Legacy /proxy/<spaceId>/ prefix — no agent segment, dispatches the protocol by path suffix.
  // This entry only does routing / compression / billing; inside the handler isLegacyProxyPath is checked, and memory-type
  // features (session-init / mem commands / injection / L0 / skill) are all turned off.
  app.post("/proxy/:spaceId/v1/messages", (c) => handleAnthropicMessages(c, config));
  app.post("/proxy/:spaceId/v1/messages/count_tokens", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/embeddings", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/completions", (c) => handleAuxiliaryEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/moderations", (c) => handleAuxiliaryEndpoint(c, config));
  // The Responses protocol must be dispatched explicitly: the catch-all would land in handleChatCompletions, which parses by
  // `body.messages`, whereas Responses content lives in `body.input` -- forwarding and billing
  // are still correct (the whitelist builds the upstream endpoint by suffix), but compression and CFQ would silently stop working.
  // Auxiliary endpoints likewise must not fall into the chat catch-all, otherwise compact / memories / realtime
  // would be treated as chat/completions and sent upstream.
  app.post("/proxy/:spaceId/v1/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/proxy/:spaceId/v1/responses", (c) => handleCodexEndpoint(c, config));
  app.post("/proxy/:spaceId/responses/compact", (c) => handleCodexEndpoint(c, config));
  app.post("/proxy/:spaceId/memories/trace_summarize", (c) => handleCodexEndpoint(c, config));
  app.post("/proxy/:spaceId/realtime/calls", (c) => handleCodexEndpoint(c, config));
  app.post("/proxy/:spaceId/responses", (c) => handleCodexEndpoint(c, config));
  // Responses variants of `/cost-guard` / `/analyse`: the generic `/:agent/:spaceId/...`
  // marker routes only mount messages / chat/completions and do not cover /responses. If not registered
  // they fall through to the `/proxy/:spaceId/*` → handleChatCompletions below.
  if (config.costGuard.markerOptIn) {
    app.post("/proxy/:spaceId/cost-guard/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/proxy/:spaceId/cost-guard/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/proxy/:spaceId/cost-guard/pre/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/proxy/:spaceId/cost-guard/pre/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/proxy/:spaceId/cost-guard/cheap/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/proxy/:spaceId/cost-guard/cheap/responses", (c) => handleCodexEndpoint(c, config));
  }
  if (config.injection?.assetReflection?.markerOptIn) {
    app.post("/proxy/:spaceId/analyse/v1/responses", (c) => handleCodexEndpoint(c, config));
    app.post("/proxy/:spaceId/analyse/responses", (c) => handleCodexEndpoint(c, config));
  }
  app.post("/proxy/:spaceId/*", (c) => handleChatCompletions(c, config));

  // OpenAI-compatible chat completions (catch-all for any remaining POST paths)
  app.post("/*", (c) => handleChatCompletions(c, config));

  return app;
}

