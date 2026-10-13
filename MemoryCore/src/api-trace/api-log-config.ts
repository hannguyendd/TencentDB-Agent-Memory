/**
 * API trace runtime config: the tier is inferred from the metadata store backend; writes stdout JSON by default.
 */
import type { MetadataBackend } from "../metadata/store/interface.js";
import { resolvePolicy, type ApiTracePolicy } from "./api-trace-policy.js";

export interface ApiTraceLogConfig {
  enabled: boolean;
}

export interface ApiTraceInitOptions {
  enabled?: boolean;
}

export interface ApiTraceRuntimeConfig {
  log: ApiTraceLogConfig;
  policy: ApiTracePolicy;
}

let runtimeConfig: ApiTraceRuntimeConfig | null = null;

function buildConfig(
  backend: MetadataBackend = "sqlite",
  opts?: ApiTraceInitOptions,
): ApiTraceRuntimeConfig {
  return {
    log: { enabled: opts?.enabled ?? true },
    policy: resolvePolicy(backend),
  };
}

/** Injected by the gateway at startup with the metadata store backend (determines full/lite). */
export function initApiTraceConfig(
  metadataBackend: MetadataBackend = "sqlite",
  opts?: ApiTraceInitOptions,
): void {
  runtimeConfig = buildConfig(metadataBackend, opts);
}

export function getApiTraceConfig(): ApiTraceRuntimeConfig {
  if (!runtimeConfig) {
    runtimeConfig = buildConfig("sqlite");
  }
  return runtimeConfig;
}

/** For tests: reset the cached config. */
export function resetApiTraceConfigForTests(): void {
  runtimeConfig = null;
}

export function isApiTraceActive(): boolean {
  return getApiTraceConfig().log.enabled;
}

export { resolvePolicy, resolveProfile, type ApiTracePolicy } from "./api-trace-policy.js";
