/**
 * Asset Reflection Injector -- for internal effect evaluation; appends an
 * `<asset_reflection>` block at the end of the system prompt, guiding the agent to comment in its final answer on "which cloud
 * asset tools were called this round and whether each was useful".
 *
 * ## Gating
 * Fully aligned with the dual-gate pattern of `costGuard.markerOptIn`:
 *   1. `injection.assetReflection.markerOptIn=true` -> the factory registers this hook
 *      (otherwise the hook is not in getAll() on online pods at all, zero performance overhead);
 *   2. the request URL carries the `/analyse` marker -> execute actually emits the block (otherwise returns [],
 *      leaving the prompt of requests without the marker completely unchanged).
 *
 * ## Tag set
 * Determined by `activeAssetTags` passed to the constructor -- the factory computes a static list based on which asset injectors
 * are actually registered on this node:
 *   - skill-*         → `<skill_tools>` + `<available_skills>`
 *   - tdai-*          → `<tdai_memory_tools>`
 *   - knowledge-*     → `<knowledge_tools>`
 *
 * If none is registered (activeAssetTags empty) -> the hook never emits.
 */

import type {
  AgentContext,
  CacheStrategy,
  ContextBlock,
  HookPriority,
  InjectionHook,
} from "../types.js";
import { HOOK_PRIORITY } from "../types.js";
import { hasAnalyseMarker } from "../../routes/whitelist.js";

export interface AssetReflectionInjectorConfig {
  /** List of asset tag names actually enabled on this node (without angle brackets), e.g. `["skill_tools", "tdai_memory_tools"]`. */
  activeAssetTags: string[];
}

const TAG = "[asset-reflection-injector]";

/** Pure function: renders the `<asset_reflection>` section. An empty tag list returns an empty string, so callers can exit early. */
export function renderAssetReflectionBlock(tags: string[]): string {
  if (tags.length === 0) return "";
  const tagList = tags.map((t) => `<${t}>`).join(" / ");
  return [
    "<asset_reflection>",
    "**Internal effect evaluation mode** -- this system prompt contains the following cloud asset tool blocks:",
    `  ${tagList}`,
    "",
    "If in this round of conversation you **actually called** any of these tools (whether via Bash curl or an MCP call),",
    "append a short retrospective at the **end** of your final answer, in the following fixed format:",
    "",
    "[Asset Reflection]",
    "- <tag>::<tool_name>: one sentence on **whether this call was useful** (what key information it got / what detours it saved you / or why it missed)",
    "- ... (one line per tool called; multiple calls to the same tool can be merged into one line summarizing the overall effect)",
    "",
    "Rules:",
    "- **Only review tools actually called this round**; do not list those that were not called, and do not guess or fill in on your own.",
    "- If this round called none of the above asset tools, still output:",
    "  [Asset Reflection] No cloud asset tools were used this round.",
    "- Keep the retrospective short and honest -- if a tool did not help, say so directly; this is for integration-effect evaluation, not for positive reviews.",
    "- This section is for internal evaluation only and is not a formal conclusion; separate it clearly from the main answer (e.g. a blank line + \"---\").",
    "</asset_reflection>",
  ].join("\n");
}

/**
 * AssetReflectionInjector -- see the file header.
 *
 * point: `system.suffix` (attached at the very end of the system prompt, matching the internal evaluation semantics: read the body first, then the reflection requirement)
 * priority: `HOOK_PRIORITY.CUSTOM` (1000, runs last, so as not to affect any asset injector)
 * cacheStrategy: `none` (depends on the runtime URL marker, cannot be prewarmed)
 */
export class AssetReflectionInjector implements InjectionHook {
  id = "asset-reflection-injector";
  point = "system.suffix" as const;
  priority: HookPriority = HOOK_PRIORITY.CUSTOM;
  description = "Inject <asset_reflection> block into system prompt when URL has /analyse marker.";
  cacheStrategy: CacheStrategy = "none";

  constructor(private config: AssetReflectionInjectorConfig) {}

  execute(ctx: AgentContext): ContextBlock[] {
    if (this.config.activeAssetTags.length === 0) {
      // The factory guarantees it will not register an injector with empty tags; this is a defensive early exit.
      return [];
    }
    const requestPath = ctx.metadata.requestPath ?? "";
    if (!hasAnalyseMarker(requestPath)) {
      // No marker -- zero change to the prompt of ordinary requests, ensuring the KV cache prefix is unaffected.
      return [];
    }
    const content = renderAssetReflectionBlock(this.config.activeAssetTags);
    if (!content) return [];
    if (process.env.PROXY_DEBUG_ASSET_REFLECTION) {
      console.log(`${TAG} emit for path=${requestPath} tags=[${this.config.activeAssetTags.join(",")}]`);
    }
    return [{
      type: "text",
      content,
      metadata: {
        source: this.id,
        // cache-strategy=none, but still give a stable cacheKey for the observer to dedupe.
        cacheKey: `asset-reflection-injector:${this.config.activeAssetTags.join(",")}`,
      },
    }];
  }
}
