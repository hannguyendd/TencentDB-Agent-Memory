/**
 * Kernel-side LLM provider resolver — does not depend on the gateway layer; computes from pure config + env
 * the final (baseUrl, apiKey).
 *
 * The gateway side has another llm-resolver.ts that does startup validation; both share the same field semantics:
 *   - provider="openai": pass through
 *   - provider="proxy": baseUrl = `${baseUrl}/proxy/<iid>/v1`,
 *                       apiKey  = env.TDAI_MEMORY_SYSTEM_USER_KEY (sk-mem-xxx)
 *
 * The reason for writing it again instead of importing gateway/llm-resolver directly: the core/ layer should not depend backwards on
 * gateway/; also, the gateway side cares about GatewayMetadataConfig, while the core side can only get
 * process.env (backfilled by applyMetadataEnvFromGatewayConfig when the gateway starts).
 */

import type { StandaloneLLMConfig } from "./llm-runner.js";

const MEMORY_USER_KEY_RE = /^sk-mem-[A-Za-z0-9_-]{32}$/;

export class LlmProviderResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmProviderResolveError";
  }
}

/**
 * Given the core-side llm config + the current instanceId, compute the (baseUrl, apiKey)
 * actually used when issuing the LLM request.
 *
 * The input llm section should carry the provider / proxy fields (the gateway loader has already filled them;
 * the OpenClaw embedded scenario is equivalent to provider="openai" and takes the pass-through path).
 */
export function resolveStandaloneLlmForRuntime(
  llm: StandaloneLLMConfig,
  instanceId: string | undefined,
): StandaloneLLMConfig {
  const provider = llm.provider ?? "openai";
  if (provider !== "proxy") return llm;

  if (!llm.baseUrl) {
    throw new LlmProviderResolveError(
      "llm.provider=proxy requires llm.baseUrl to point at the context_proxy root URL",
    );
  }
  if (!instanceId || !instanceId.trim()) {
    throw new LlmProviderResolveError(
      "llm.provider=proxy requires a non-empty instanceId; cannot build the /proxy/<iid>/v1 path",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  let effectiveApiKey = llm.apiKey;
  if (useSystemUserKey) {
    const envKey = process.env.TDAI_MEMORY_SYSTEM_USER_KEY?.trim();
    if (!envKey) {
      throw new LlmProviderResolveError(
        "llm.provider=proxy requires the memory system user key — " +
        "configure it in yaml metadata.systemUser.memory or env TDAI_MEMORY_SYSTEM_USER_KEY",
      );
    }
    if (!MEMORY_USER_KEY_RE.test(envKey)) {
      throw new LlmProviderResolveError(
        "memory system user key must match sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
    effectiveApiKey = envKey;
  }

  if (!effectiveApiKey) {
    throw new LlmProviderResolveError(
      "llm.provider=proxy with useMemorySystemUserKey=false requires an explicit llm.apiKey",
    );
  }

  const cleanBase = llm.baseUrl.replace(/\/+$/, "");
  return {
    ...llm,
    baseUrl: `${cleanBase}/proxy/${encodeURIComponent(instanceId)}/v1`,
    apiKey: effectiveApiKey,
  };
}
