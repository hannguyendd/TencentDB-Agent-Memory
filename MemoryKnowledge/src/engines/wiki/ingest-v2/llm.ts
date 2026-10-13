/**
 * llm.ts — OpenAI-compatible chat call wrapper (dedicated to wiki ingest).
 *
 * Reuses the repo's existing Vercel AI SDK (`ai` + `@ai-sdk/openai`) and goes through the standard
 * `/chat/completions` (compatibility: "compatible"), supporting all kinds of OpenAI-compatible backends.
 *
 * The actual shape of llmConfig is passed in by the upper-level module.ts, with these field names:
 *   { provider, apiKey, model, customEndpoint, maxContextSize }
 * Here we normalize it to stay compatible with the { baseUrl, maxTokens, timeoutMs } aliases in the INTERFACE doc.
 */

import { generateText, streamText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createLogger } from "../../../logger.js";

const log = createLogger("wiki-ingest-llm");

/** Raw llmConfig passed in by the caller (loose; fields may use different names). */
export interface RawLlmConfig {
  protocol?: "openai" | "anthropic";
  provider?: string;
  apiKey?: string;
  model?: string;
  // Actual names (module.ts)
  customEndpoint?: string;
  maxContextSize?: number;
  // INTERFACE doc aliases
  baseUrl?: string;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Whether to call the upstream with a streaming request (streamText). Defaults to false (non-streaming).
   * Set to true for compatible upstreams that only accept streaming requests. Applies to both openai/anthropic protocols.
   *
   * WARNING: only takes effect on the wiki-ingest direct AI SDK path; does not affect the MemoryCore/OpenClaw host
   * runner. It also does not forward incremental tokens to the caller; it is just a compatibility layer that
   * "requests the upstream via the streaming protocol and waits for the full text".
   */
  stream?: boolean;
}

/** Normalized config. */
export interface NormalizedLlmConfig {
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  stream: boolean;
}

const DEFAULT_MODEL = "Memory-Model";
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 1_200_000; // 20min — reasoning models need more time

/**
 * Normalize a config that may use several different naming schemes from the caller.
 *
 * Note: this **no longer** falls back to reading process.env (historically it read TDAI_LLM_*, which bypassed resolveLlmConfig's
 * binding/mode logic and caused "silently falling back to a direct connection"). baseUrl/apiKey must be supplied by the upper layer
 * (module.ts → resolveLlmConfig); if missing, createLlmClient throws directly.
 */
export function normalizeLlmConfig(raw: RawLlmConfig | undefined): NormalizedLlmConfig {
  const cfg = raw ?? {};
  const protocol = cfg.protocol ?? "openai";
  const baseUrl = cfg.baseUrl || cfg.customEndpoint || "";
  const apiKey = cfg.apiKey || "";
  const model = cfg.model || DEFAULT_MODEL;
  const maxTokens = cfg.maxTokens ?? cfg.maxContextSize ?? DEFAULT_MAX_TOKENS;
  const timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const stream = cfg.stream ?? false;
  return { protocol, baseUrl, apiKey, model, maxTokens, timeoutMs, stream };
}

export interface ChatParams {
  system: string;
  prompt: string;
  /** Override the default max output tokens. */
  maxOutputTokens?: number;
  /** Sampling temperature (optional; the SDK default is used if omitted). */
  temperature?: number;
  /** External abort signal (merged with the internal timeout). */
  abortSignal?: AbortSignal;
  /** Call label (e.g. "analysis"/"generate"/"merge"), used to distinguish steps in logs. */
  label?: string;
}

/** Minimal abstract LLM client interface, easy to stub in tests. */
export interface LlmClient {
  chat(params: ChatParams): Promise<string>;
  readonly config: NormalizedLlmConfig;
}

/**
 * Real client based on the AI SDK. Plain-text output (no tools attached, to avoid weak models hallucinating tool calls).
 */
export function createLlmClient(raw: RawLlmConfig | undefined): LlmClient {
  const config = normalizeLlmConfig(raw);
  if (!config.apiKey) {
    throw new Error(
      "LLM apiKey is not configured: in proxy mode TMC must push an llm_binding for this service_id; " +
      "or set LLM_MODE=custom + LLM_API_KEY to use your own endpoint",
    );
  }
  if (!config.baseUrl) {
    throw new Error(
      "LLM baseUrl is not configured: in proxy mode TMC must push an llm_binding for this service_id; " +
      "or set LLM_MODE=custom + LLM_BASE_URL to use your own endpoint",
    );
  }

  // Pick the AI SDK provider factory by protocol (both implement the LanguageModelV3 interface).
  const provider = config.protocol === "anthropic"
    ? createAnthropic({ baseURL: config.baseUrl, apiKey: config.apiKey })
    : createOpenAI({ baseURL: config.baseUrl, apiKey: config.apiKey });

  return {
    config,
    async chat(params: ChatParams): Promise<string> {
      const timeoutSignal = AbortSignal.timeout(config.timeoutMs);
      const signal = params.abortSignal
        ? AbortSignal.any([timeoutSignal, params.abortSignal])
        : timeoutSignal;

      const label = params.label ?? "chat";
      const promptChars = params.system.length + params.prompt.length;
      const startMs = Date.now();
      log.info(`LLM call started [${label}]`, {
        model: config.model,
        protocol: config.protocol,
        promptChars,
        maxOutputTokens: params.maxOutputTokens ?? config.maxTokens,
        timeoutMs: config.timeoutMs,
      });
      log.debug(`LLM system prompt [${label}] (model=${config.model})`, { text: params.system.slice(0, 200) });
      log.debug(`LLM user prompt [${label}] (model=${config.model})`, { text: params.prompt.slice(0, 500) });

      try {
        const callParams = {
          model: provider.chat(config.model),
          system: params.system,
          prompt: params.prompt,
          maxOutputTokens: params.maxOutputTokens ?? config.maxTokens,
          ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
          abortSignal: signal,
          experimental_telemetry: {
            isEnabled: true,
            functionId: params.label ?? "chat",
          },
        };

        // stream=true → streamText (for upstreams that only accept streaming); otherwise generateText.
        // streamText's text/usage/finishReason are Promises; after await their shape matches generateText.
        const { text, usage, finishReason } = config.stream
          ? await (async () => {
              const r = streamText(callParams);
              return {
                text: ((await r.text) ?? "").trim(),
                usage: await r.usage,
                finishReason: await r.finishReason,
              };
            })()
          : await (async () => {
              const r = await generateText(callParams);
              return {
                text: (r.text ?? "").trim(),
                usage: r.usage,
                finishReason: r.finishReason,
              };
            })();

        const u = usage ?? ({} as Record<string, number>);
        log.info(`LLM call completed [${label}]`, {
          ms: Date.now() - startMs,
          promptTokens: u.inputTokens ?? null,
          completionTokens: u.outputTokens ?? null,
          totalTokens: u.totalTokens ?? null,
          finishReason: finishReason ?? null,
          outputChars: text.length,
        });
        if (!text) {
          log.warn(`LLM returned empty text [${label}]`, { finishReason: finishReason ?? null });
        }
        return text;
      } catch (err) {
        log.error(`LLM call failed [${label}]`, {
          ms: Date.now() - startMs,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    },
  };
}
