/**
 * stages/asset-capabilities.ts — wrapper that fetches AssetCapabilityFlags after session-init.
 *
 * Extracted from the same-shaped code in the 4 runners (openai-chat / anthropic / codex / workbuddy):
 *   if (!bypassed && sessionInfo) {
 *     try { fetchAssetCapabilities(...); [log success] }
 *     catch { console.warn(...) }
 *   }
 *
 * Differences preserved (parameterized):
 *   - callerUserKey source: openai-chat uses apiKey, the other 3 use callerUserKey
 *   - logSuccess: openai-chat / anthropic emit the [asset-capability] success log,
 *     codex/wb legacy code did not -> now unified to always emit (better observability, no regression risk)
 *   - warnPrefix: independent per runner (passed explicitly)
 */

import type { ProxyConfig } from "../../types.js";
import type { AssetCapabilityFlags } from "../../injection/types.js";

export interface AssetCapabilitiesInput {
  bypassed: boolean;
  sessionInfo: unknown;
  config: ProxyConfig;
  spaceId?: string;
  /** TDAI ACL x-tdai-user-key; openai-chat passes apiKey||null, the others pass callerUserKey */
  userKey: string | null | undefined;
  /** warn prefix (including the colon, before the space, consistent with the old log format) */
  warnPrefix: string;
}

export async function stageAssetCapabilities(
  input: AssetCapabilitiesInput,
): Promise<AssetCapabilityFlags | undefined> {
  if (input.bypassed || !input.sessionInfo) return undefined;

  const userId = (input.sessionInfo as { user_id?: string }).user_id;
  try {
    const { fetchAssetCapabilities } = await import("../../tdai/capabilities.js");
    const flags = await fetchAssetCapabilities({
      endpoint: input.config.tdai.endpoint,
      apiKey: input.config.tdai.apiKey,
      serviceId: input.config.tdai.serviceId,
      serviceIdOverride: input.spaceId,
      userId,
      userKey: input.userKey ?? null,
      timeoutMs: input.config.tdai.memory.timeoutMs,
    });
    // Round 17b: unified success logging (openai-chat/anthropic legacy code logged, codex/wb legacy code did not)
    console.log(`[asset-capability] user=${userId ?? "-"} flags=${JSON.stringify(flags)}`);
    return flags;
  } catch (err) {
    console.warn(input.warnPrefix, err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
