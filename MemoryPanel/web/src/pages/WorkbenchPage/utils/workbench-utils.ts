/**
 * workbench-utils -- shared types, constants and pure utility functions of the workbench.
 * Split out of TaskWorkbench.tsx.
 */
import { useTranslation } from 'react-i18next';

export type WorkbenchTab = 'board' | 'logs';

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Read the **specific source** id from the task's metadata_json.
 *
 * Corresponds to the backend `readExternalRef`: source_type only denotes the category (manual / external),
 * and which specific system it is is stored in `metadata_json.external.provider`.
 * Returns null if it cannot be read -- the caller falls back to "do not show the source row" accordingly.
 */
export function readExternalProvider(task: { metadata_json?: string }): string | null {
  if (!task.metadata_json) return null;
  try {
    const meta = JSON.parse(task.metadata_json) as {
      external?: { provider?: unknown };
    };
    const provider = meta.external?.provider;
    return typeof provider === 'string' && provider ? provider : null;
  } catch {
    // metadata_json is not JSON (dirty data / old format): treat as having no source, don't throw.
    return null;
  }
}

/**
 * External source id -> display name.
 *
 * By convention takes `task.source.<id>`, without enumerating sources in code -- adding a source only needs one entry in i18n,
 * with no need to change this function (if `if (id === 'tapd')` were written here, code would need changing for every source connected).
 *
 * An unregistered source falls back to the id itself, never showing blank.
 */
export function useSourceLabel() {
  const { t } = useTranslation();
  return (sourceId: string): string =>
    t(`task.source.${sourceId}`, { defaultValue: sourceId });
}

// Task status is simplified to two states in the demo phase: in progress / completed.
// The historical pending / blocked / archived have been taken offline (see normalizeTaskStatus in backendStore.ts).
export function useStatusLabels() {
  const { t } = useTranslation();
  return {
    running: t('task.status.running'),
    completed: t('task.status.completed'),
  };
}

export interface AgentOption {
  id: string;
  name: string;
}

/**
 * Task-level aggregated view: bucketed by task_id, then each deduped separately.
 *
 * Kernel append-only semantics: for the same (user, agent, task) every session init appends a record,
 * so the database table accumulates redundancy; the frontend dedupes client-side with a Set, so "running 10 sessions" and
 * "running 1 session" display the same.
 */
export interface TaskParticipationView {
  /** The user_id list after dedupe */
  users: string[];
  /** The agent_id list after dedupe */
  agentIds: string[];
}

export const EMPTY_VIEW: TaskParticipationView = { users: [], agentIds: [] };

/**
 * Sentinel id of the "non-real agent" that needs to be hidden.
 *
 * Participation records produced by import use the sentinel `external-import` as agent_id (corresponding to the fake agent in meta_agents
 * named "External task import") -- because participation_log's agent_id is required,
 * while the import scenario has no real agent working.
 *
 * This sentinel is a **bookkeeping placeholder**, not a real agent participation, so the display layer uniformly filters it out:
 *   - "Agents actually participating" -> the list is empty -> falls to the existing "—", consistent with non-imported tasks;
 *   - Board card -> likewise does not render the chip.
 *
 * Note this only affects the **agentIds** bucket; the `user_id` of the same record (the source system's assignee) still
 * goes into the `users` bucket and displays normally under "Participating Users" -- the two buckets don't interfere.
 *
 * `tapd-import` is an **old value from before the rename**, already written to the database historically, and is filtered together so legacy data
 * doesn't expose "External task import" (display filtering only, **no data deleted**: participation records are observation data).
 */
const HIDDEN_AGENT_IDS = new Set(['external-import', 'tapd-import']);

export function isHiddenAgentId(agentId: string): boolean {
  return HIDDEN_AGENT_IDS.has(agentId);
}

/** The list of real agent_ids after filtering out sentinels. */
export function visibleAgentIds(agentIds: readonly string[]): string[] {
  return agentIds.filter((id) => !isHiddenAgentId(id));
}

export function participationOf(
  byTask: Map<string, TaskParticipationView>,
  taskId: string,
): TaskParticipationView {
  return byTask.get(taskId) ?? EMPTY_VIEW;
}
