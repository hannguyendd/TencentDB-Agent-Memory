/**
 * TAPD field mapping: the differences among story / task / bug are consolidated here, so no type branching appears in upper layers.
 *
 * Empirical differences (2026-09-15):
 *   |            | story        | task              | bug               |
 *   | title field | name         | name              | **title** (no name) |
 *   | detail_link | ✅ in list    | ❌ not even in detail | ✅ in list       |
 *   | description | detail only  | detail only       | detail only        |
 *   | search param| name         | name              | **title**          |
 */

import { TaskSourceError, type RemoteTaskDetail, type RemoteTaskRef } from "../../types.js";

export const ITEM_TYPES = [
  { id: "story", label: "Story" },
  { id: "task", label: "Task" },
  { id: "bug", label: "Bug" },
] as const;

export type ItemType = (typeof ITEM_TYPES)[number]["id"];

/** Work item type -> list/detail tool name. */
const TOOLS: Record<ItemType, string> = {
  story: "stories_get",
  task: "tasks_get",
  bug: "bugs_get",
};

/**
 * Work item type -> todo list tool name.
 *
 * Empirically (2026-09-16): the three todo tools take **only workspace_id** as input;
 * limit / page / owner / name / with_v_status are all rejected
 * ("参数X不存在于工具user_todo_stories_get的参数定义中", i.e. "parameter X does not exist in tool user_todo_stories_get's parameter definition").
 * So todo mode can only pull everything and paginate locally, and the status is already Chinese.
 */
const TOOLS_TODO: Record<ItemType, string> = {
  story: "user_todo_stories_get",
  task: "user_todo_tasks_get",
  bug: "user_todo_bugs_get",
};

export function isItemType(v: string): v is ItemType {
  return ITEM_TYPES.some((t) => t.id === v);
}

/**
 * Get the list tool name.
 *
 * @param onlyTodo true -> todo API; false -> regular API.
 * Detail (fetchTask) always uses the regular API: the todo API does not return description or detail_link.
 */
export function toolFor(itemType: string, onlyTodo = false): string {
  if (!isItemType(itemType)) {
    throw new TaskSourceError("invalid_item_type", `unsupported TAPD item type: ${itemType}`);
  }
  return onlyTodo ? TOOLS_TODO[itemType] : TOOLS[itemType];
}

/** Title field: bug uses title, the others use name. */
export function pickTitle(row: Record<string, unknown>, itemType: string): string {
  const key = itemType === "bug" ? "title" : "name";
  const v = row[key];
  return typeof v === "string" ? v : "";
}

/** Keyword search parameter name: bug uses title, the others use name. */
export function keywordField(itemType: string): string {
  return itemType === "bug" ? "title" : "name";
}

/**
 * Handler field name.
 *
 * Empirically: `owner` does **not exist** in the bugs_get parameter definition; passing it reports
 * "参数owner不存在于工具bugs_get的参数定义中" (parameter owner does not exist in tool bugs_get's parameter definition) and returns error text (HTTP still 200).
 * The bug handler field is `current_owner` (label=handler).
 */
export function ownerField(itemType: string): string {
  return itemType === "bug" ? "current_owner" : "owner";
}

/**
 * Get the handler account name.
 *
 * The field likewise differs by type (bug uses current_owner) and is often empty (unassigned).
 * Empty values return undefined -- callers use this to skip participant backfill.
 */
export function pickOwner(row: Record<string, unknown>, itemType: string): string | undefined {
  const raw = row[ownerField(itemType)];
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  // TAPD multi-person fields look like `wlleiiwang;zarekzhang;` (semicolon-separated).
  // Participant backfill only accepts a single account name; take the first non-empty segment.
  const first = raw
    .split(";")
    .map((s) => s.trim())
    .find(Boolean);
  return first;
}

/**
 * Whether to send with_v_status (returns Chinese status).
 *
 * Empirically: only stories_get supports it. bugs_get / tasks_get reject it outright on the server,
 * returning the text "参数不存在于工具X的参数定义中" (parameter does not exist in tool X's parameter definition) instead of data -- sending it would disguise a config error
 * as "0 results", so it is strictly distinguished by type.
 */
export function supportsVStatus(itemType: string): boolean {
  return itemType === "story";
}

/**
 * Detail page URL.
 *
 * Prefer the API's own `detail_link` (returned by story / bug in both list and detail).
 * When missing, build it from the site root, with the fixed path `/tapd_fe/{workspace_id}/{type}/detail/{id}`:
 *
 *   - the task API **never returns** detail_link (neither in list nor in detail), so it must be built;
 *   - the todo APIs (user_todo_*_get) return it for none of the three types, so it must also be built.
 *
 * **Do not build the path from the workspace short name (pretty_name)**: empirically, the URL built with pretty_name
 * `/{pretty_name}/{workspace_id}/{type}/detail/{id}` returns a 302 redirect to the login page,
 * while `/tapd_fe/{workspace_id}/{type}/detail/{id}` returns 200. `tapd_fe` is a fixed route segment,
 * independent of pretty_name and the same for all workspaces.
 */
export function buildUrl(
  row: Record<string, unknown>,
  itemType: string,
  siteBaseUrl: string,
  scope: string,
  _prettyName?: string,
): string | undefined {
  const link = row["detail_link"];
  if (typeof link === "string" && link) return link;
  if (!isItemType(itemType)) return undefined;
  const id = typeof row["id"] === "string" ? (row["id"] as string) : String(row["id"] ?? "");
  if (!id) return undefined;
  return `${stripSlash(siteBaseUrl)}/tapd_fe/${scope}/${itemType}/detail/${id}`;
}

/**
 * Resolve the status for display: prefer the Chinese one, fall back to the raw code when missing.
 *
 * Empirically the capabilities of the three APIs are inconsistent:
 *   - story: supports `with_v_status="1"`, and the response directly carries `v_status` (Chinese, e.g. "未开始", i.e. "Not started")
 *   - task / bug: **do not support** with_v_status (sending it is rejected), only the English-code `status`
 *     (e.g. `status_3` / `new`)
 * So task / bug need a separate status mapping table:
 *   `tapd_field_detail_get(object_type, field_names="status")` returns
 *   `options: { "new": "新", "in_progress": "接受/处理", ... }` (Chinese labels).
 */
export function resolveStatus(
  row: Record<string, unknown>,
  statusLabelMap?: Readonly<Record<string, string>>,
): string | undefined {
  const vStatus = str(row["v_status"]);
  if (vStatus) return vStatus;
  const code = str(row["status"]);
  if (!code) return undefined;
  return statusLabelMap?.[code] ?? code;
}

/**
 * Get the workspace_id from the row.
 *
 * For cross-project todos (user_todo_*_get without workspace_id) each row carries its own workspace_id,
 * but empirically it is a **number** (e.g. 12345678), while the request-level scope is a string.
 * Accepting only strings would fail to get it -> the detail page URL gets an empty segment such as `tapd_fe//story/...`.
 */
export function rowScope(row: Record<string, unknown>, fallback: string): string {
  const v = row["workspace_id"];
  if (typeof v === "string" && v) return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return fallback;
}

export function toRef(
  row: Record<string, unknown>,
  itemType: string,
  siteBaseUrl: string,
  scope: string,
  prettyName?: string,
  statusLabelMap?: Readonly<Record<string, string>>,
): RemoteTaskRef {
  const id = row["id"];
  return {
    externalId: typeof id === "string" ? id : String(id ?? ""),
    itemType,
    title: pickTitle(row, itemType),
    url: buildUrl(row, itemType, siteBaseUrl, scope, prettyName),
    status: resolveStatus(row, statusLabelMap),
    updatedAt: str(row["modified"]) ?? str(row["created"]),
    owner: pickOwner(row, itemType),
    scope,
  };
}

export function toDetail(
  row: Record<string, unknown>,
  itemType: string,
  siteBaseUrl: string,
  scope: string,
  prettyName: string,
  statusLabelMap?: Readonly<Record<string, string>>,
): RemoteTaskDetail {
  const ref = toRef(row, itemType, siteBaseUrl, scope, prettyName, statusLabelMap);
  const body = typeof row["description"] === "string" ? row["description"] : "";
  const warnings: string[] = [];
  if (!body) warnings.push("Remote body is empty");
  if (!ref.url) warnings.push("Could not resolve the detail page URL");
  return { ...ref, body, fidelity: "lossless", warnings };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function stripSlash(s: string): string {
  return s.replace(/\/+$/, "");
}
