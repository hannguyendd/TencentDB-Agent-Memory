/**
 * TaskWorkbench -- user workbench.
 *
 * Converged into two things:
 *   1. List/create/manage tasks under this team;
 *   2. View task history via the log tab.
 *
 * Layout: entering the page shows a full-width card grid; clicking a card pulls out a Drawer, where details and settings are viewed
 * (change status, edit title/description, delete).
 *
 * Data goes through backend path A (services/backendStore.ts, which internally calls the meta endpoints of @/lib/teamApi).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, Text } from 'tea-component';
import {
  useTasks,
  useTeams,
  createTask,
  deleteTask,
  updateTask,
  updateTaskStatus,
  canDeleteTask,
  canEditTask,
} from '@/services';
import { tea } from '@/lib/tea-bridge';
import { TeamHeaderCard } from '@/components/team/TeamHeaderCard';
import TaskCreateDialog, { type TaskDraft } from './TaskCreateDialog';
import TaskImportDialog from './TaskImportDialog';
import { taskSourceApi, type TaskSourceProvider } from '../../../lib/api/taskSource';
import { invalidateBackendCache } from '@/stores/backend';
import BoardView from './BoardView';
import { useTeamParticipation } from '../hooks/useTeamParticipation';
import { errMsg, type AgentOption, type WorkbenchTab } from '../utils/workbench-utils';
import '../styles/task-workbench.css';

function EmptyTeam() {
  const { t } = useTranslation();
  return (
    <Card>
      <Card.Body className="_memory-workbench-empty-card">
        <Text theme="strong" className="_memory-workbench-empty-title">{t('task.emptyTeam.title')}</Text>
        <Text theme="weak" className="_memory-workbench-empty-desc">
          {t('task.emptyTeam.desc')}
        </Text>
      </Card.Body>
    </Card>
  );
}

export default function TaskWorkbench(props: {
  tab?: WorkbenchTab;
  onTabChange?: (tab: WorkbenchTab) => void;
  /** The currently active team id (may be empty: when none is selected only the empty state is shown) */
  activeTeamId: string | null;
  /** The current username (the task's creator_user_id) */
  currentUser: string;
  /** The list of Agents that can be associated under the current team (from the same data as TeamManagementPanel) */
  agents: AgentOption[];
  /** Whether the user is a global admin (kept for interface compatibility; admins no longer have task privileges) */
  isAdmin?: boolean;
}) {
  const { t } = useTranslation();
  const { activeTeamId, currentUser, agents } = props;
  // Backend pagination: useTasks calls the Panel aggregation endpoint by page + pageSize, and the kernel returns only the current page
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);
  const { tasks, total: tasksTotal, loading: tasksLoading } = useTasks(activeTeamId, currentPage, pageSize);
  const { teams, activeTeam } = useTeams();
  const participationByTask = useTeamParticipation(activeTeamId);
  const [showCreate, setShowCreate] = useState(false);
  /** The source id currently being imported (non-empty means the dialog is open). Determined by the item selected in the "Import Task" dropdown. */
  const [importProviderId, setImportProviderId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /** Enabled external sources. Empty array -> BoardView hides the "Import Task" entry. */
  const [providers, setProviders] = useState<TaskSourceProvider[]>([]);

  // Reset to page 1 when switching team
  useEffect(() => { setCurrentPage(1); }, [activeTeamId]);

  // Pull back an out-of-range page number: when the total shrinks (deleting the last few items of the last page / the page count drops after enlarging the page size),
  // if currentPage stays on the invalid page, fetch gets an empty array with an out-of-range offset,
  // and the board would wrongly show the "No tasks" empty state -- here the page number is pulled back to the valid last page.
  const totalPages = Math.max(1, Math.ceil(tasksTotal / pageSize));
  useEffect(() => {
    if (!tasksLoading && tasksTotal > 0 && currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [tasksLoading, tasksTotal, currentPage, totalPages]);

  // Fetch the enabled external sources. Fail silently (when no source is configured the entry isn't shown anyway, so don't disturb the user).
  useEffect(() => {
    if (!activeTeamId) return;
    let alive = true;
    taskSourceApi
      .providers(activeTeamId)
      .then((res) => { if (alive) setProviders(res.providers ?? []); })
      .catch(() => { if (alive) setProviders([]); });
    return () => { alive = false; };
  }, [activeTeamId]);

  const sortedTasks = useMemo(() => {
    return [...tasks].sort((a, b) => b.updated_at_ms - a.updated_at_ms);
  }, [tasks]);

  const selected = useMemo(
    () => (selectedId ? tasks.find((t) => t.task_id === selectedId) ?? null : null),
    [selectedId, tasks]
  );

  /**
   * Create task: team_id is fully determined by the currently active team, and the dialog no longer lets the user choose a team
   * (the only entry to switch team is the global TeamSwitcher at the top right).
   */
  async function handleCreate(draft: TaskDraft) {
    // Whoever clicks "Create Task" is the creator_user_id.
    const team = teams.find((t) => t.team_id === draft.team_id);
    if (!team) {
      tea.notify.error(`team "${draft.team_id}" ${t('task.emptyTeam.title')}`);
      return;
    }
    try {
      const task = await createTask({
        team_id: draft.team_id,
        creator_user_id: currentUser,
        title: draft.title,
        description: draft.description,
        source_type: draft.source_type,
        source_url: draft.source_url,
        linked_agents: draft.linked_agents
      });
      setSelectedId(task.task_id);
      setShowCreate(false);
    } catch (err) {
      tea.notify.error(errMsg(err));
    }
  }

  return (
    <div className="_memory-workbench-body">
      {!activeTeamId ? (
        <EmptyTeam />
      ) : (
        <>
          {/* Current team overview (same component as the team management page) */}
          {activeTeam && <TeamHeaderCard team={activeTeam} />}
          <BoardView
          tasks={sortedTasks}
          tasksLoading={tasksLoading}
          tasksTotal={tasksTotal}
          currentPage={currentPage}
          setCurrentPage={setCurrentPage}
          pageSize={pageSize}
          setPageSize={setPageSize}
          selected={selected}
          onSelect={(id) => setSelectedId(id)}
          onCreate={() => setShowCreate(true)}
          // Dropdown source selection: pass the chosen provider_id up, and open the import dialog of the corresponding source accordingly.
          // When no external source is enabled, pass undefined -> the entry is hidden.
          onImport={providers.length ? (providerId) => setImportProviderId(providerId) : undefined}
          importSources={providers.map((p) => ({ id: p.id }))}
          onDelete={async (task) => {
            // Permission: deleting a task is limited to the creator / team admin / global admin
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canDeleteTask(task, team, currentUser)) {
              tea.notify.warning(
                t('task.delete.noPermission', { title: task.title, creator: task.creator_user_id })
              );
              return;
            }
            const ok = await tea.confirm({
              message: t('task.delete.confirm', { title: task.title }),
              description: t('task.delete.description', { id: task.task_id }),
              okText: t('task.delete.okText'),
              cancelText: t('task.delete.cancelText'),
            });
            if (ok) {
              try {
                await deleteTask(task.task_id);
                if (selectedId === task.task_id) setSelectedId(null);
              } catch (err) {
                tea.notify.error(errMsg(err));
              }
            }
          }}
          onUpdateStatus={async (task, status) => {
            // Permission: editing a task (including switching status) is allowed for any member / admin within the team
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser)) {
              tea.notify.warning(t('task.noPermissionEdit'));
              return;
            }
            try {
              await updateTaskStatus(task.task_id, status, currentUser);
            } catch (err) {
              tea.notify.error(errMsg(err));
            }
          }}
          onUpdateTask={async (task, patch) => {
            const team = teams.find((t) => t.team_id === task.team_id) ?? null;
            if (!canEditTask(task, team, currentUser)) {
              tea.notify.warning(t('task.noPermissionEdit'));
              return;
            }
            try {
              await updateTask(task.task_id, patch, currentUser);
            } catch (err) {
              tea.notify.error(errMsg(err));
            }
          }}
          agents={agents}
          teams={teams}
          currentUser={currentUser}
          participationByTask={participationByTask}
          />
        </>
      )}

      {showCreate && activeTeam && (
        // The team is determined by the global TeamSwitcher at the top right, and the dialog no longer lets the user choose;
        // activeTeam here must be non-null, because the !activeTeamId branch above has already gone to EmptyTeam
        <TaskCreateDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          onClose={() => setShowCreate(false)}
          onCreate={handleCreate}
        />
      )}
      {importProviderId && activeTeamId && (
        <TaskImportDialog
          teamId={activeTeamId}
          providers={providers}
          providerId={importProviderId}
          onClose={() => setImportProviderId(null)}
          // After import, clear the cache + broadcast, triggering useTasks to re-fetch (the same mechanism as other write operations)
          onImported={() => invalidateBackendCache()}
        />
      )}
    </div>
  );
}
