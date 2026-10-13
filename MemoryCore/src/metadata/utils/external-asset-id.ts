/**
 * External asset ID generation (design §4.1.1 / API reference AssetEntity).
 * The metadata module does not generate asset_id; this utility is for callers and tests.
 */
import type { AssetType } from "../types.js";
import { generateRelationId } from "./id-generator.js";

/** `asset_type` → `asset_id` prefix (the part before the following `-`). */
export const EXTERNAL_ASSET_ID_PREFIX: Record<AssetType, string> = {
  skill: "skl",
  llm_wiki: "wiki",
  code_graph: "cg",
  chat_memory: "mem",
};

/** Generate a compliant external asset ID, e.g. `skl-a3b9c1f2`. */
export function newExternalAssetId(assetType: AssetType): string {
  return `${EXTERNAL_ASSET_ID_PREFIX[assetType]}-${generateRelationId()}`;
}
