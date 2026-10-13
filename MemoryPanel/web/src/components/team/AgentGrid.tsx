/**
 * AgentGrid - Agent management within a team: card/list views, search and Owner filter.
 * Permissions and data go through the real backend.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Justify, SearchBox, Segment, Select, Table } from 'tea-component';
import {
  AddIcon,
  ChevronRightIcon,
  DeleteIcon,
  ViewListIcon,
  ViewModuleIcon,
} from 'tea-icons-react';
import { canManageAsset, type Team, type Agent as StoreAgent } from '@/services';
import { useDisplayNameResolver, useUserDisplayName } from '@/services/user-profile-store';
import { emptyMountedCounts, type AgentMountedCounts } from './types';
import { Mounted } from './shared';

const { scrollable } = Table.addons;

/**
 * Agent owner label: visible text shows display_name (falls back to id on cache miss),
 * title keeps user_id for troubleshooting. Extracted as a subcomponent because Rules of Hooks forbids calling hooks in a loop inside .map.
 */
function AgentOwnerTag({ ownerId, isMe }: { ownerId: string; isMe: boolean }) {
  const { t } = useTranslation();
  const name = useUserDisplayName(ownerId);
  if (!ownerId) {
    return <span className="_memory-agents-owner-tag">{t('agentGrid.card.ownerUnset')}</span>;
  }
  return (
    <span
      className={`_memory-agents-owner-tag${isMe ? ' _memory-agents-owner-tag--me' : ''}`}
      title={ownerId}
    >
      {name || ownerId}
      {isMe && t('agentGrid.owner.you')}
    </span>
  );
}

type ViewMode = 'card' | 'list';

export default function AgentGrid({
  activeTeam,
  agents,
  agentsLoading,
  countsLoading,
  mountedCounts,
  currentUser,
  isAdmin: _isAdmin,
  canSeeAllAgents,
  onCreateAgent,
  onEditAgent,
  onDeleteAgent,
}: {
  activeTeam: Team;
  agents: StoreAgent[];
  agentsLoading: boolean;
  /** Whether agent-overview/bootstrap counts are still loading: keep the skeleton until they return, do not leave the loading state early */
  countsLoading: boolean;
  mountedCounts: Record<string, AgentMountedCounts>;
  currentUser: string;
  /** Kept for interface compatibility; admin no longer has special permissions. */
  isAdmin: boolean;
  /** Whether the user may see all agents in the team (admin / team admin). Regular users only see their own, so no Owner filter is needed. */
  canSeeAllAgents: boolean;
  onCreateAgent: () => void;
  onEditAgent: (agent: StoreAgent) => void;
  onDeleteAgent: (agent: StoreAgent) => void;
}) {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('agentGrid.viewMode') : null;
    return saved === 'list' ? 'list' : 'card';
  });
  const handleSetViewMode = useCallback((mode: ViewMode) => {
    setViewMode(mode);
    try {
      localStorage.setItem('agentGrid.viewMode', mode);
    } catch {
      /* ignore if localStorage is unavailable */
    }
  }, []);

  const ownerOptions = useMemo(() => {
    const memberIds = activeTeam.members.map((member) => member.user_id);
    const agentOwnerIds = agents.map((agent) => agent.owner_user_id).filter(Boolean);
    return Array.from(new Set([...memberIds, ...agentOwnerIds]));
  }, [activeTeam.members, agents]);

  // user_id → display_name resolution (batch scenarios such as filter dropdown / tooltip; shares the cache with the owner label)
  const resolveUserName = useDisplayNameResolver();

  const filteredAgents = useMemo(() => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return agents.filter((agent) => {
      if (ownerFilter && agent.owner_user_id !== ownerFilter) return false;
      if (!normalizedKeyword) return true;
      return (
        agent.name.toLowerCase().includes(normalizedKeyword)
        || agent.description.toLowerCase().includes(normalizedKeyword)
        || agent.agent_id.toLowerCase().includes(normalizedKeyword)
      );
    });
  }, [agents, keyword, ownerFilter]);

  function canEdit(agent: StoreAgent): boolean {
    // admin is the same as member: can only operate agents they own (no more global admin privilege).
    return canManageAsset(
      { owner_user_id: agent.owner_user_id, team_id: agent.team_id },
      activeTeam,
      currentUser,
      false,
    );
  }

  function renderName(agent: StoreAgent, compact = false) {
    const editable = canEdit(agent);
    return (
      <button
        type="button"
        className={`_memory-agents-name-trigger${editable ? ' _memory-agents-name-trigger--editable' : ''}`}
        data-guide={editable ? 'agent-name-editable' : undefined}
        onClick={() => editable && onEditAgent(agent)}
        disabled={!editable}
        title={editable
          ? t('agentGrid.card.edit.tooltip.can')
          : t('agentGrid.card.edit.tooltip.cannot', { owner: agent.owner_user_id ? resolveUserName(agent.owner_user_id) : t('agentGrid.card.ownerUnset') })}
      >
        <span className="_memory-agents-name" title={agent.name}>{agent.name}</span>
        {editable && <ChevronRightIcon size={compact ? 12 : 14} className="_memory-agents-chevron" />}
      </button>
    );
  }

  function renderOwner(agent: StoreAgent) {
    return <AgentOwnerTag ownerId={agent.owner_user_id} isMe={agent.owner_user_id === currentUser} />;
  }

  function renderAssets(agent: StoreAgent, countsLoading = false) {
    const counts = mountedCounts[agent.agent_id] ?? emptyMountedCounts();
    return (
      <div className="_memory-agents-stats">
        <Mounted label="skills" count={counts.skills} loading={countsLoading} />
        <Mounted label="code_graph" count={counts.code_graph} loading={countsLoading} />
        <Mounted label="llm_wiki" count={counts.llm_wiki} loading={countsLoading} />
        <Mounted label="chat_memory" count={counts.chat_memory} loading={countsLoading} />
      </div>
    );
  }

  return (
    <div className="_memory-agents-panel">
      <div className="_memory-agents-section-head">
        <div>
          <h2 className="_memory-agents-section-title">{t('agentGrid.title')}</h2>
          <div className="_memory-agents-section-subtitle">
            {t('agentGrid.subtitle', {
              name: activeTeam.name,
              id: activeTeam.team_id,
              loading: agentsLoading ? t('agentGrid.loading') : t('agentGrid.subtitle.count', { count: agents.length }),
            })}
          </div>
        </div>
      </div>

      <Table.ActionPanel>
        <Justify
          left={
            <Button
              type="primary"
              onClick={onCreateAgent}
              title={t('agentGrid.create.tooltip')}
              data-guide="create-agent"
            >
              <AddIcon size={12} /> {t('agentGrid.create')}
            </Button>
          }
          right={
            <div className="_memory-agents-toolbar">
              <SearchBox
                value={keyword}
                onChange={setKeyword}
                placeholder={t('agentGrid.search')}
              />
              {canSeeAllAgents && (
                <Select
                  value={ownerFilter}
                  onChange={setOwnerFilter}
                  appearance="button"
                  options={[
                    { value: '', text: t('agentGrid.allOwners') },
                    ...ownerOptions.map((ownerId) => ({ value: ownerId, text: resolveUserName(ownerId) })),
                  ]}
                  matchButtonWidth
                />
              )}
              <Segment
                value={viewMode}
                onChange={(value) => handleSetViewMode(value as ViewMode)}
                options={[
                  { value: 'card', text: <ViewModuleIcon /> },
                  { value: 'list', text: <ViewListIcon /> },
                ]}
              />
            </div>
          }
        />
      </Table.ActionPanel>

      {/* Two-stage loading orchestration:
          1) First screen, agents not back yet → 4 skeleton cards (actual count unknown, visually preset to 4)
          2) agents ready → render real cards immediately; while counts are still loading only the "asset count chip" shows a skeleton
            - no longer cover the whole grid with a skeleton, avoiding the abrupt "4 skeletons → 1 real card" transition */}
      {agentsLoading && agents.length === 0 ? (
        viewMode === 'card' ? (
          // Card view skeleton: 4 placeholder cards + shimmer animation, same style as AssetListPanel;
          // cards enter one by one, staggered (60ms step, orchestrated loading), skeleton cards don't flicker
          <div className="_memory-agents-skeleton-grid" aria-label="loading">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="_memory-agents-skeleton-card"
                style={{ animationDelay: `${i * 60}ms` }}
              >
                {/* 1. head: name + chevron, aligned with real _memory-agents-card-head */}
                <div className="_memory-agents-skeleton-head">
                  <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--name" />
                  <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--chevron" />
                </div>
                {/* 2. id: monospace small text, aligned with _memory-agents-card-id */}
                <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--id" />
                {/* 3. desc: two lines, aligned with _memory-agents-card-desc (min-height 40px) */}
                <div className="_memory-agents-skeleton-desc">
                  <div className="_memory-agents-skeleton-line" />
                  <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--desc-short" />
                </div>
                {/* 4. owner row: label + pill, aligned with _memory-agents-owner-row */}
                <div className="_memory-agents-skeleton-owner">
                  <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--owner-label" />
                  <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--owner-tag" />
                </div>
                {/* 5. stats: 2 columns, 4 mounted chips, aligned with _memory-agents-stats */}
                <div className="_memory-agents-skeleton-stats">
                  {[0, 1, 2, 3].map((j) => (
                    <div key={j} className="_memory-agents-skeleton-chip">
                      <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--chip-label" />
                      <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--chip-count" />
                    </div>
                  ))}
                </div>
                {/* 6. actions: right-aligned delete button, aligned with _memory-agents-card-actions */}
                <div className="_memory-agents-skeleton-actions">
                  <div className="_memory-agents-skeleton-line _memory-agents-skeleton-line--action" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="_memory-agents-empty">{t('agentGrid.loading')}</div>
        )
      ) : filteredAgents.length === 0 ? (
        <div className="_memory-agents-empty">
          {agents.length === 0
            ? t('agentGrid.empty.member')
            : canSeeAllAgents
              ? t('agentGrid.empty.filtered.all')
              : t('agentGrid.empty.filtered.partial')}
        </div>
      ) : viewMode === 'card' ? (
        <div className="_memory-agents-card-grid">
          {filteredAgents.map((agent) => {
            const editable = canEdit(agent);
            return (
              <div
                key={agent.agent_id}
                className={`_memory-agents-card${editable ? ' _memory-agents-card--editable' : ''}`}
                data-guide={editable ? 'agent-card-editable' : undefined}
              >
                <div className="_memory-agents-card-head">{renderName(agent)}</div>
                <div className="_memory-agents-card-id">{t('agentGrid.card.id', { id: agent.agent_id })}</div>
                <div className="_memory-agents-card-desc">{agent.description || t('common.noDescription')}</div>
                <div className="_memory-agents-owner-row">
                  <span>{t('agentGrid.card.owner')}</span>
                  {renderOwner(agent)}
                  {!editable && <span className="_memory-agents-readonly">{t('agentGrid.card.readonly')}</span>}
                </div>
                {/* Asset count area: while counts are loading only the 4 numbers become small skeleton placeholders; the body is visible immediately */}
                {renderAssets(agent, countsLoading)}
                <div className="_memory-agents-card-actions">
                  <Button
                    type="text"
                    disabled={!editable}
                    onClick={() => onDeleteAgent(agent)}
                    title={editable ? t('agentGrid.card.delete.tooltip.can') : t('agentGrid.card.delete.tooltip.cannot')}
                  >
                    <DeleteIcon size={12} /> {t('agentGrid.card.delete')}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <Table
          records={filteredAgents}
          recordKey="agent_id"
          addons={[scrollable({ minWidth: 960, maxHeight: 560 })]}
          columns={[
            {
              key: 'name',
              header: t('agentGrid.table.name'),
              width: 240,
              render: (agent: StoreAgent) => renderName(agent, true),
            },
            {
              key: 'owner',
              header: t('agentGrid.table.owner'),
              width: 160,
              render: (agent: StoreAgent) => renderOwner(agent),
            },
            {
              key: 'assets',
              header: t('agentGrid.table.assets'),
              render: (agent: StoreAgent) => {
                const counts = mountedCounts[agent.agent_id] ?? emptyMountedCounts();
                // List view likewise: while counts load, use "-" as placeholder instead of the whole row disappearing
                if (countsLoading) {
                  return <span className="_memory-agents-list-assets _memory-agents-list-assets--loading">—</span>;
                }
                return (
                  <span className="_memory-agents-list-assets">
                    skills×{counts.skills} · code_graph×{counts.code_graph} · llm_wiki×{counts.llm_wiki} · chat_memory×{counts.chat_memory}
                  </span>
                );
              },
            },
            {
              key: 'description',
              header: t('agentGrid.table.desc'),
              render: (agent: StoreAgent) => <span className="_memory-agents-list-description">{agent.description || t('common.noDescription')}</span>,
            },
            {
              key: 'actions',
              header: t('agentGrid.table.actions'),
              width: 90,
              fixed: 'right',
              render: (agent: StoreAgent) => {
                const editable = canEdit(agent);
                return (
                  <Button type="link" disabled={!editable} onClick={() => onDeleteAgent(agent)}>
                    {t('agentGrid.table.delete')}
                  </Button>
                );
              },
            },
          ]}
        />
      )}
    </div>
  );
}
