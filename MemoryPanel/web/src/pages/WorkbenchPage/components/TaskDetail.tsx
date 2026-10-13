/**
 * TaskDetail -- workbench task detail (edit title/description, switch status, view participants, delete).
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Input, Segment, Text } from 'tea-component';
import { ChevronRightIcon, DeleteIcon, EditIcon, UserIcon, UsergroupIcon } from 'tea-icons-react';
import { canEditTask, type Task, type Team } from '@/services';
import { useUserDisplayName } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import {
  readExternalProvider,
  useSourceLabel,
  useStatusLabels,
  visibleAgentIds,
  type AgentOption,
  type TaskParticipationView,
} from '../utils/workbench-utils';

/**
 * Normalize source_url into an absolute address that is safe to navigate to.
 *
 * **A protocol allowlist is required**: source_url is external data pulled back from a third-party system (TAPD),
 * and putting it directly into `<a href>` would make pseudo-protocols such as `javascript:` / `data:` an XSS entry point.
 * Only http / https are allowed; parse failure or anything off the allowlist returns null (no link rendered).
 */
function safeExternalUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    // Relative path or invalid string: don't guess the protocol, just don't navigate.
    return null;
  }
}

/**
 * Participant chip: the visible text shows display_name (falling back to id on a cache miss),
 * and title keeps a semantic tooltip + user_id for troubleshooting.
 * Extracting a sub-component is required by the Rules of Hooks (useUserDisplayName cannot be called in a loop inside .map).
 */
function UserChip({
  userId,
  currentUser,
  tooltip,
}: {
  userId: string;
  currentUser: string;
  tooltip: string;
}) {
  const { t } = useTranslation();
  const name = useUserDisplayName(userId);
  return (
    <span className="_memory-workbench-chip" title={`${tooltip} · ${userId}`}>
      <UserIcon size={12} />
      <Text theme="text">{name || userId}</Text>
      {userId === currentUser && <span className="_memory-workbench-chip-you">{t('common.you.short')}</span>}
    </span>
  );
}

export default function TaskDetail({
  task,
  onUpdateStatus,
  onUpdateTask,
  onDelete,
  canDelete,
  agents,
  team,
  currentUser,
  participation,
}: {
  task: Task;
  onUpdateStatus: (s: Task['status']) => void;
  onUpdateTask: (patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>>) => void;
  /** Delete the current task (permission check and second confirmation are handled uniformly by the outer layer) */
  onDelete: () => void;
  canDelete: boolean;
  agents: AgentOption[];
  /** The team the current task belongs to -- may be null (in theory not, but the case of a deleted team needs a fallback) */
  team: Team | null;
  currentUser: string;
  /** Observation data of the current task passed down after bucketing by useTeamParticipation */
  participation: TaskParticipationView;
}) {
  const { t } = useTranslation();
  const statusLabels = useStatusLabels();
  const sourceLabelOf = useSourceLabel();
  // Edit permission: any member within the team can modify a task (including switching status).
  const canEdit = canEditTask(task, team, currentUser);

  /** Detail page address of the source system (already passed through the protocol allowlist); null if invalid/missing, and no jump button is rendered. */
  const externalUrl = safeExternalUrl(task.source_url);
  /**
   * Source display name: the specific source is read from metadata_json.external.provider (source_type only denotes the category).
   * An unregistered source falls back to the raw provider string, avoiding a blank source row.
   */
  const sourceProvider = readExternalProvider(task);
  const sourceLabel = sourceProvider ? sourceLabelOf(sourceProvider) : task.source_type;

  // -- Edit state: entered only after the user clicks "Edit"; the draft is maintained independently, and cancel discards it -- //
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [draftDesc, setDraftDesc] = useState(task.description);

  // Sync the draft on switching task / leaving edit mode (avoiding the draft staying on A after editing A then switching to B)
  useEffect(() => {
    setEditing(false);
    setDraftTitle(task.title);
    setDraftDesc(task.description);
  }, [task.task_id]);


  function startEdit() {
    setDraftTitle(task.title);
    setDraftDesc(task.description);
    setEditing(true);
  }
  function cancelEdit() {
    setEditing(false);
  }
  function saveEdit() {
    const patch: Partial<Pick<Task, 'title' | 'description' | 'source_type' | 'source_url' | 'linked_agents'>> = {};
    const title = draftTitle.trim();
    if (title.length === 0) {
      tea.notify.warning(t('task.titleRequired'));
      return;
    }
    if (title !== task.title) patch.title = title;
    if (draftDesc !== task.description) patch.description = draftDesc;

    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    onUpdateTask(patch);
    setEditing(false);
  }

  // Participant display: the creator gets its own separate entry; the rest go into "Participating Users".
  // The data source uniformly uses participation-log observation -- the "users who actually started a session"
  // appended when the proxy's session init completes. A creator working with their own agent also counts as real participation,
  // so the creator is no longer filtered out (it appears in both "Creator" and "Participating Users" with different semantics).
  const participantUsers = participation.users;

  // "Agents actually participating": the agents observed in sessions, mapped to the team's agent names;
  // those not in the team agents list (e.g. already deleted) keep agent_id as a fallback display.
  // First filter out the import sentinel (historical participation records) -- if empty after filtering, show "—", the same as non-imported tasks.
  const sessionAgents = useMemo(() => {
    const nameById = new Map(agents.map((a) => [a.id, a.name]));
    return visibleAgentIds(participation.agentIds).map((id) => ({
      id,
      name: nameById.get(id) ?? id,
    }));
  }, [participation.agentIds, agents]);

  return (
    <div className="_memory-workbench-detail-content">
      {/* === Tool row: edit + status switch (title / task_id / team are already shown in the drawer header) === */}
      <div className="_memory-workbench-detail-toolbar">
        {editing ? (
          <>
            <Input
              value={draftTitle}
              onChange={setDraftTitle}
              placeholder={t('task.titlePlaceholder')}
              size="full"
              className="_memory-workbench-title-input"
            />
            <Button onClick={cancelEdit}>{t('common.cancel')}</Button>
            <Button type="primary" onClick={saveEdit}>{t('task.save')}</Button>
          </>
        ) : (
          <>
            {canEdit && (
              <Button type="text" onClick={startEdit} tooltip={t('task.edit.tooltip')}>
                <EditIcon size={14} />
                {t('task.edit')}
              </Button>
            )}
            {/*
              The jump entry is **kept only** in the "Source" row of the participants area below -- that one carries the source name and full URL
              tooltip, with more information; putting another button here would be a duplicate entry to the same target and easy to misclick.
            */}
            <Segment
              value={task.status}
              onChange={(v) => onUpdateStatus(v as Task['status'])}
              disabled={!canEdit}
              options={(Object.keys(statusLabels) as Task['status'][]).map((s) => ({
                value: s,
                text: statusLabels[s],
              }))}
            />
          </>
        )}
      </div>

      {/* === Participants === */}
      <div className="_memory-workbench-people">
        {/* Source: only tasks produced by import have it (source_type !== 'manual'); manual tasks don't show the row at all */}
        {task.source_type !== 'manual' && (
          <div className="_memory-workbench-people-row">
            <Text theme="weak" className="_memory-workbench-people-label">{t('task.source')}</Text>
            {externalUrl ? (
              <a
                href={externalUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={externalUrl}
                className="_memory-workbench-source-link"
              >
                {t('task.sourceLink', { source: sourceLabel })}
                <ChevronRightIcon size={12} />
              </a>
            ) : (
              <Text theme="weak">{sourceLabel}</Text>
            )}
          </div>
        )}
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.creator')}</Text>
          <UserChip
            userId={task.creator_user_id}
            currentUser={currentUser}
            tooltip={t('task.creator.tooltip')}
          />
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.participantUsers')}</Text>
          {participantUsers.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            participantUsers.map((u) => (
              <UserChip
                key={u}
                userId={u}
                currentUser={currentUser}
                tooltip={t('task.participantUsers.tooltip')}
              />
            ))
          )}
        </div>
        <div className="_memory-workbench-people-row">
          <Text theme="weak" className="_memory-workbench-people-label">{t('task.sessionAgents')}</Text>
          {sessionAgents.length === 0 ? (
            <Text theme="weak">—</Text>
          ) : (
            sessionAgents.map((a) => (
              <span
                key={a.id}
                className="_memory-workbench-chip"
                title={t('task.sessionAgents.tooltip', { id: a.id })}
              >
                <UsergroupIcon size={12} />
                <Text theme="text">{a.name}</Text>
              </span>
            ))
          )}
        </div>
      </div>

      {/* === Description === */}
      <div className="_memory-workbench-block">
        <Text theme="label" className="_memory-workbench-block-label">{t('task.description')}</Text>
        {editing ? (
          <Input.TextArea
            value={draftDesc}
            onChange={setDraftDesc}
            rows={6}
            size="full"
            placeholder={t('task.descriptionPlaceholder')}
          />
        ) : (
          <div className="_memory-workbench-desc-view">{task.description}</div>
        )}
      </div>

      <Text theme="weak" className="_memory-workbench-footer">
        {t('task.footer', { created: new Date(task.created_at_ms).toLocaleString(), updated: new Date(task.updated_at_ms).toLocaleString() })}
      </Text>

      {/* === Dangerous actions === */}
      {canDelete && (
        <div className="_memory-workbench-danger">
          <Button type="error" onClick={onDelete}>
            <DeleteIcon size={12} /> {t('task.delete.okText')}
          </Button>
        </div>
      )}
    </div>
  );
}
