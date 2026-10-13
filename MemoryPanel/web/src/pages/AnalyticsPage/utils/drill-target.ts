/**
 * Drill-down target definitions -- unifies "where you click, what you see".
 *
 * The three kinds of drill-down have different data sources, and drillTabs() decides the views available in the drawer:
 *   - member  : has both behavior (tool-calls by user_id) and cost (usage by user_id) -> two views
 *   - category: behavior only (tool-calls by bridge_source); usage_logs has no asset-category dimension
 *   - model   : cost only (usage by model_id); the tool_call table does not record model_id
 */
import type { AssetCategory } from '../utils/asset-category';

export type DrillTarget =
  | { type: 'member'; userId: string }
  | { type: 'category'; category: AssetCategory }
  | { type: 'model'; modelId: string; modelName: string };

export type DrillView = 'trace' | 'usage';

/** Views supported by this drill-down target (order is the Tab order, the first is the default). */
export function drillViews(target: DrillTarget): DrillView[] {
  switch (target.type) {
    case 'member':
      return ['trace', 'usage'];
    case 'category':
      return ['trace'];
    case 'model':
      return ['usage'];
  }
}
