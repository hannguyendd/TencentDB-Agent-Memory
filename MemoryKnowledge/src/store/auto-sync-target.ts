/**
 * SyncTarget — discriminated union of auto-sync targets.
 *
 * Wiki and codegraph share the same AutoSyncScheduler. A discriminated union is used rather than inheritance/generics:
 * adding a new target adds one member, and the compiler forces every switch branch to handle it.
 *
 * The key carries a kind prefix (`code-graph:<id>` / `wiki:<id>`), so collisions are naturally avoided —
 * even if two kinds of resources happen to have the same id they will not dedupe each other.
 */

import type { CodeGraphRow, WikiRow } from "./types.js";

export type SyncTargetKind = "code-graph" | "wiki";

export type SyncTarget =
  | { kind: "code-graph"; key: string; serviceId: string; teamId: string; id: string; row: CodeGraphRow }
  | { kind: "wiki"; key: string; serviceId: string; teamId: string; id: string; row: WikiRow };

/** Unique sync target key (with kind prefix, no collisions across types). */
export function targetKey(kind: SyncTargetKind, id: string): string {
  return `${kind}:${id}`;
}

export function toCodeGraphTarget(row: CodeGraphRow): SyncTarget {
  return {
    kind: "code-graph",
    key: targetKey("code-graph", row.code_graph_id),
    serviceId: row.service_id,
    teamId: row.team_id,
    id: row.code_graph_id,
    row,
  };
}

export function toWikiTarget(row: WikiRow): SyncTarget {
  return {
    kind: "wiki",
    key: targetKey("wiki", row.wiki_id),
    serviceId: row.service_id,
    teamId: row.team_id,
    id: row.wiki_id,
    row,
  };
}
