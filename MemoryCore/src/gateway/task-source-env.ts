/**
 * Backfill the Gateway yaml `taskSource` section into process.env (**only when env is not set**).
 *
 * Resolution priority: process.env > yaml -- consistent with the global convention in metadata-env.ts / config.ts.
 * The task-source registry / provider still only read env, so no call signature changes are needed.
 *
 * Why "backfill env" rather than "pass config into the registry":
 *   the env name of a provider is dynamically assembled as `TASK_SOURCE_<ID>_<SUFFIX>`, and the suffix is declared by the provider
 *   itself, with no presets in the generic layer. Passing structured config down would copy the "env name assembly rule"
 *   into the registry, and two copies of the rule can easily drift; backfilling env keeps a single rule in the registry.
 *
 * The yaml uses camelCase (consistent with sections such as metadata / skill); this file converts camelCase -> env names:
 *
 *   taskSource:
 *     enabled: tapd                      → TASK_SOURCE_ENABLED
 *     taiPatUrl: https://…               → TAI_PAT_URL
 *     sources:
 *       tapd:
 *         mcpUrl: https://…              → TASK_SOURCE_TAPD_MCP_URL
 *         siteBaseUrl: https://…         → TASK_SOURCE_TAPD_SITE_BASE_URL
 */

import type { GatewayTaskSourceConfig } from "./config.js";

function setEnvIfEmpty(key: string, value: string | undefined): void {
  if (value && !process.env[key]?.trim()) {
    process.env[key] = value;
  }
}

/** camelCase key -> env suffix. `mcpUrl` -> `MCP_URL`; `siteBaseUrl` -> `SITE_BASE_URL`. */
function toEnvSuffix(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

/**
 * Called early in TdaiGateway.start() (before any task-source route / provider call).
 *
 * A no-op when `taskSource` is not configured -- pure-env deployments are unaffected.
 */
export function applyTaskSourceEnvFromGatewayConfig(taskSource: GatewayTaskSourceConfig): void {
  setEnvIfEmpty("TASK_SOURCE_ENABLED", taskSource.enabled);
  setEnvIfEmpty("TAI_PAT_URL", taskSource.taiPatUrl);

  const sources = taskSource.sources;
  if (!sources) return;
  for (const [sourceId, entries] of Object.entries(sources)) {
    const upper = sourceId.toUpperCase();
    for (const [key, value] of Object.entries(entries)) {
      setEnvIfEmpty(`TASK_SOURCE_${upper}_${toEnvSuffix(key)}`, value);
    }
  }
}
