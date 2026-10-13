/**
 * LLM provider resolver -- combines the llm section in the yaml and the memory systemUser into
 * a {baseUrl, apiKey, model, ...} config that the kernel runner can use directly.
 *
 * Two modes:
 *   1. provider="openai" (default): returns the llm config as-is, backward compatible
 *   2. provider="proxy": assembles baseUrl into `${baseUrl}/proxy/<instanceId>/v1`,
 *      and apiKey uses metadata.systemUser.memory.userKey (the memory system role sk-mem-xxx).
 *      This way all kernel LLM calls carry the memory identity and go through context_proxy's unified authentication,
 *      cost guard, and observability chain.
 *
 * Single responsibility: this file only "computes the final baseUrl / apiKey" and does not create runners; the four integration points
 * (tdai-core.ts:636/987/1037/1082, server.ts buildOffloadLlmClient) call this function uniformly before constructing
 * the runner.
 */

import type { StandaloneLLMConfig } from "../adapters/standalone/llm-runner.js";
import type { GatewayMetadataConfig } from "./config.js";
import {
  isValidMemorySystemUserKey,
  resolveMemorySystemUserConfig,
  type MemorySystemUserConfig,
} from "../metadata/system-user.js";

export class LlmResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LlmResolveError";
  }
}

/**
 * Compute the final (baseUrl, apiKey, model, ...) for kernel LLM calls under the given instanceId.
 *
 * @param llm            the llm section in the gateway yaml (including provider)
 * @param instanceId     the instance id currently being handled (used to assemble the path when provider=proxy)
 * @param memorySystemUser the resolved memory system user config (optional, used only when provider=proxy and
 *                         useMemorySystemUserKey=true)
 *
 * @throws {LlmResolveError} when provider=proxy but required config is missing
 */
export function resolveEffectiveLlmConfig(
  llm: StandaloneLLMConfig,
  instanceId: string | undefined,
  memorySystemUser: MemorySystemUserConfig | undefined,
): StandaloneLLMConfig {
  const provider = llm.provider ?? "openai";
  if (provider !== "proxy") {
    // Default path: return as-is, behavior fully equivalent to before the change
    return llm;
  }

  // Validation for provider=proxy
  if (!llm.baseUrl) {
    throw new LlmResolveError(
      "llm.provider=proxy requires llm.baseUrl to point to the context_proxy root URL (e.g. http://127.0.0.1:8096)",
    );
  }
  if (!instanceId || !instanceId.trim()) {
    throw new LlmResolveError(
      "llm.provider=proxy requires an instanceId, but the core's current instanceId is empty -- " +
      "in service mode make sure requests carry x-tdai-service-id; in standalone mode make sure the yaml has an instanceId",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  let effectiveApiKey = llm.apiKey;
  if (useSystemUserKey) {
    if (!memorySystemUser) {
      throw new LlmResolveError(
        "llm.provider=proxy with llm.proxy.useMemorySystemUserKey=true requires " +
        "a complete metadata.systemUser.memory config (userId + userKey), which is currently missing",
      );
    }
    if (!isValidMemorySystemUserKey(memorySystemUser.userKey)) {
      throw new LlmResolveError(
        "metadata.systemUser.memory.userKey must match sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
    effectiveApiKey = memorySystemUser.userKey;
  }

  if (!effectiveApiKey) {
    throw new LlmResolveError(
      "llm.provider=proxy with useMemorySystemUserKey=false requires llm.apiKey to be configured explicitly",
    );
  }

  // baseUrl assembly rule: strip trailing slashes, append /proxy/<iid>/v1
  const cleanBase = llm.baseUrl.replace(/\/+$/, "");
  const proxyBaseUrl = `${cleanBase}/proxy/${encodeURIComponent(instanceId)}/v1`;

  return {
    ...llm,
    baseUrl: proxyBaseUrl,
    apiKey: effectiveApiKey,
  };
}

/**
 * Only validates and returns no config -- used for startup-time "fail-fast" checks.
 * In standalone mode the instanceId is generally "default" and can be validated directly;
 * in service mode the instanceId is only known per request, so at startup only whether the systemUser is valid is checked.
 */
export function validateLlmProviderConfig(
  llm: StandaloneLLMConfig,
  metadata: GatewayMetadataConfig,
): void {
  if (llm.provider !== "proxy") return;

  if (!llm.baseUrl) {
    throw new LlmResolveError(
      "llm.provider=proxy requires llm.baseUrl to point to the context_proxy root URL",
    );
  }

  const useSystemUserKey = llm.proxy?.useMemorySystemUserKey ?? true;
  if (useSystemUserKey) {
    const memoryUser = resolveMemorySystemUserConfig(metadata);
    if (!memoryUser) {
      throw new LlmResolveError(
        "llm.provider=proxy with useMemorySystemUserKey=true requires " +
        "a complete metadata.systemUser.memory config (userId + userKey)",
      );
    }
    if (!isValidMemorySystemUserKey(memoryUser.userKey)) {
      throw new LlmResolveError(
        "metadata.systemUser.memory.userKey must match sk-mem-[A-Za-z0-9_-]{32}",
      );
    }
  } else if (!llm.apiKey) {
    throw new LlmResolveError(
      "llm.provider=proxy with useMemorySystemUserKey=false requires llm.apiKey to be configured explicitly",
    );
  }
}
