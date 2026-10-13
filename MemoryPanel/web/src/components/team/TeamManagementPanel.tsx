/**
 * TeamManagementPanel - team management.
 *
 * Handles "Team + members + Agent" management:
 *   - The top is the current team overview + team-level operation entries (only creating a new Team);
 *     Team-level "Edit / Delete" has been moved to the TeamSwitcher dropdown in the top-left (right of the active team row),
 *     so this panel no longer repeats those entries.
 *   - The middle is member management of the current team: add / remove members by user_id
 *   - The bottom is the Agent card grid of the current team: create / edit / delete
 *
 * Data storage (backend persistence):
 *   - team/members/agent all go through @/lib/teamApi;
 *   - After a successful write, invalidateBackendCache() is called uniformly to make useTeams/useAgents refetch;
 *   - Display fields the backend schema does not have yet are serialized into the "ui" namespace of agent.metadata_json.
 *
 * Known limitations (honestly reflecting current backend capabilities, no fake UI):
 *   - Agent owner is fixed by the backend to the current logged-in user at creation; transfer is not supported yet;
 *   - Team deletion is cascading (also deletes members/agents/tasks/assets), only owner / admin can delete
 *     (entry is in the TeamSwitcher dropdown).
 *
 * File split (this file keeps only composition/orchestration logic; see the same directory for implementations):
 *   - types.ts / useAgentAssets.ts / shared.tsx / AgentGrid.tsx / MemberSection.tsx /
 *     CreateTeamDialog.tsx / CreateAgentDialog.tsx / AgentEditDialog.tsx
 *   - EditTeamDialog has been moved to be shared with TeamSwitcher (@/layouts/GlobalHeader/TeamSwitcher)
 */

import { useState, useMemo } from 'react';
import { Button } from 'tea-component';
import { useTranslation } from 'react-i18next';
import { UsergroupIcon, AddIcon } from 'tea-icons-react';
import {
  useTeams,
  useAgents,
  isTeamAdmin,
  canManageAsset,
  invalidateBackendCache,
  writeAgentUiMeta,
  type Agent as StoreAgent,
} from '@/services';
import { teamsApi, agentsApi, skillApi } from '@/lib/teamApi';
import { knowledgeApi } from '@/lib/api/knowledge-api';
import { useDisplayNameResolver } from '@/services/user-profile-store';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import './team-management-panel.css';

import { MAX_IMPORTED_CHAT_MEMORIES, importedChatMemoryIds, type AgentCard } from './types';
import { useAgentMountedCounts, syncChatMemoryBindings } from './useAgentAssets';
import AgentGrid from './AgentGrid';
import { TeamHeaderCard } from './TeamHeaderCard';
import { MemberSection, AddMemberDialog, CreatedUserKeyModal } from './MemberSection';
import CreateTeamDialog from './CreateTeamDialog';
import CreateAgentDialog from './CreateAgentDialog';
import AgentEditDialog from './AgentEditDialog';
import DefaultAgentTemplateSection from './DefaultAgentTemplateSection';

function errMsg(e: unknown): string {
  return getErrorMessage(e);
}

// =================== Component ===================

export default function TeamManagementPanel({
  currentUser,
  instanceId: _instanceId,
  isAdmin: _isAdmin,
  section = 'all',
}: {
  currentUser: string;
  instanceId: string;
  isAdmin: boolean;
  /**
   * Controls which part this panel renders (for tab splitting, functionality unchanged):
   *   - 'members': member management only
   *   - 'agents' : Agent management only
   *   - 'all'    : render both (backward compatible with the old single-page usage)
   */
  section?: 'members' | 'agents' | 'all';
}) {
  const showMembers = section === 'members' || section === 'all';
  const showAgents = section === 'agents' || section === 'all';
  const { activeTeamId, activeTeam, loading: teamsLoading } = useTeams();
  // Only take agents of the current team - an agent strictly belongs to a team and is never shown across teams
  const { agents: allAgents, loading: agentsLoading } = useAgents(activeTeamId);
  const { t } = useTranslation();
  // Agent visibility:
  //   - Global admin / admin (owner) of the current team: can see all agents in the team
  //   - Regular members: can only see agents they own (created)
  const canSeeAllAgents = !!activeTeam && (_isAdmin || isTeamAdmin(activeTeam, currentUser));
  const agents = useMemo(() => {
    if (!activeTeam || canSeeAllAgents) return allAgents;
    return allAgents.filter((a) => a.owner_user_id === currentUser);
  }, [allAgents, activeTeam, canSeeAllAgents, currentUser]);
  const { counts: mountedCounts, countsLoading } = useAgentMountedCounts(activeTeamId, agents);
  // Show display_name instead of user_id in notification text (reuses the global cache, idempotent, no extra requests)
  const resolveUserName = useDisplayNameResolver();

  const [showCreateAgent, setShowCreateAgent] = useState(false);
  const [showCreateTeam, setShowCreateTeam] = useState(false);
  const [showAddMember, setShowAddMember] = useState(false);
  const [editingAgent, setEditingAgent] = useState<StoreAgent | null>(null);
  const [busy, setBusy] = useState(false);
  const [createdUserKeyInfo, setCreatedUserKeyInfo] = useState<{
    username: string;
    userId: string;
    keyValue: string;
  } | null>(null);

  async function handleCreateAgent(card: Omit<AgentCard, 'id' | 'icon' | 'accent'>) {
    if (!activeTeamId || !activeTeam) return;
    if (
      importedChatMemoryIds(activeTeamId, '__new_agent__', card.chatMemories).length >
      MAX_IMPORTED_CHAT_MEMORIES
    ) {
      tea.notify.error('IMPORT_LIMIT_EXCEEDED');
      return;
    }
    const accents: AgentCard['accent'][] = ['blue', 'purple', 'orange', 'emerald', 'rose', 'slate'];
    const icons = ['🤖', '✨', '⚡', '🎯', '🚀', '🧩'];
    const accent = accents[agents.length % accents.length];
    const icon = icons[agents.length % icons.length];
    setBusy(true);
    try {
      const created = await agentsApi.create(activeTeamId, {
        name: card.name,
        description: card.description,
        prompt: [card.rolePrompt, card.rulesPrompt].filter(Boolean).join('\n\n'),
        visibility: 'team',
      });
      const metadataJson = writeAgentUiMeta(created.metadata_json, {
        role_prompt: card.rolePrompt,
        rules_prompt: card.rulesPrompt,
        icon,
        accent,
      });
      await agentsApi.update(created.agent_id, { metadata_json: metadataJson });

      // Asset binding uniformly uses the real mount API (does not write metadata_json.ui). Run serially; any failure throws,
      // and the outer catch reports it uniformly - avoids allSettled silently causing "shown as bound but actually not bound".
      //   - skill → forkToAgent (copies an independent copy owned by the new agent)
      //   - code_graph / wiki → allocate (reference binding)
      //   - chat_memory → syncChatMemoryBindings
      await syncChatMemoryBindings(activeTeamId, created.agent_id, card.chatMemories);
      for (const skillId of card.skills) {
        await skillApi.forkToAgent(activeTeamId, skillId, created.agent_id);
      }
      for (const id of card.codeGraphs) {
        await knowledgeApi.code.allocate(activeTeamId, id, created.agent_id);
      }
      for (const id of card.llmWikis) {
        await knowledgeApi.wiki.allocate(activeTeamId, id, created.agent_id);
      }

      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateAgent(false);
  }

  async function handleDeleteAgent(agent: StoreAgent) {
    if (!activeTeamId || !activeTeam) return;
    if (
      !canManageAsset(
        { owner_user_id: agent.owner_user_id, team_id: agent.team_id },
        activeTeam,
        currentUser,
        false,
      )
    ) {
      tea.notify.error(
        t('team.deleteAgent.noPermission', { name: agent.name, id: agent.agent_id, teamName: activeTeam.name, owner: agent.owner_user_id ? resolveUserName(agent.owner_user_id) : t('team.deleteAgent.ownerUnset') }),
      );
      return;
    }
    const ok = await tea.confirm({
      message: t('team.deleteAgent.confirm', { name: agent.name }),
      description: t('team.deleteAgent.desc', { id: agent.agent_id }),
      okText: t('common.delete'),
    });
    if (!ok) return;
    try {
      await agentsApi.delete(agent.agent_id);
      invalidateBackendCache();
    } catch (err) {
      // SKILL_DELETE_FAILED: the console layer already deleted some skills but was interrupted, the agent was not archived
      // - explicitly tell the user to handle it in the skill panel and retry, rather than just a technical error code
      const raw = err instanceof Error ? err.message : String(err);
      if (raw.includes('SKILL_DELETE_FAILED')) {
        tea.notify.error(
          t('team.deleteAgent.skillFailed', { name: agent.name, raw }),
        );
      } else {
        tea.notify.error(errMsg(err));
      }
    }
  }

  async function handleCreateTeam(input: { name: string; description: string }) {
    setBusy(true);
    try {
      await teamsApi.create(input);
      invalidateBackendCache();
    } catch (err) {
      tea.notify.error(errMsg(err));
      setBusy(false);
      return;
    }
    setBusy(false);
    setShowCreateTeam(false);
  }

  return (
    <div className="_memory-team-mgmt">
      {/* === Header: current team overview + ops ===
        The only entry for switching team is the global TeamSwitcher in the top-left (App.tsx); no
        flat chips switching entry is provided here, to avoid two overlapping controls
        with the global switcher. This card only does three things:
          1. Tell the user "which team I am operating in" (name + team_id + member count + description)
          2. Provide team-level operations (+ New Team / + New Agent)
          3. Provide guidance when no team is selected yet */}
      {teamsLoading ? (
        <div className="_memory-panel-card">
          <div className="_memory-team-header-row">
            <div className="_memory-team-header-info">
              <div className="_memory-team-header-avatar" style={{ opacity: 0.3 }}>
                …
              </div>
              <div className="_memory-team-header-meta">
                <div className="_memory-team-header-meta-row">
                  <span
                    className="_memory-team-header-name"
                    style={{ color: 'var(--muted-foreground)' }}
                  >
                    {t('team.loading')}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : activeTeam ? (
        <TeamHeaderCard
          team={activeTeam}
          ops={
            <>
              {_isAdmin && (
                <Button onClick={() => setShowCreateTeam(true)} title={t('team.createTeam')}>
                  <AddIcon size={14} /> {t('team.createTeam')}
                </Button>
              )}
            </>
          }
        />
      ) : (
        <div className="_memory-panel-card">
          <div className="_memory-team-header-row">
            <div className="_memory-team-header-empty-hint">
              {t('team.empty.hint')}
            </div>
          </div>
        </div>
      )}

      {teamsLoading ? (
        <div
          className="_memory-panel-card"
          style={{ padding: '2rem', textAlign: 'center', color: 'var(--muted-foreground)' }}
        >
          {t('team.loading')}
        </div>
      ) : !activeTeam ? (
        <EmptyTeamState
          onCreateTeam={_isAdmin ? () => setShowCreateTeam(true) : undefined}
        />
      ) : (
        <>
          {/* === Members === */}
          {showMembers && (
            <MemberSection
              team={activeTeam}
              currentUser={currentUser}
              onAdd={() => setShowAddMember(true)}
              isAdmin={_isAdmin}
            />
          )}

          {/* === Default Agent template (visible to global admin only) === */}
          {showAgents && _isAdmin && (
            <DefaultAgentTemplateSection
              teamId={activeTeam.team_id}
              teamName={activeTeam.name}
            />
          )}

          {/* === Agent grid === */}
          {showAgents && (
            <AgentGrid
              activeTeam={activeTeam}
              agents={agents}
              agentsLoading={agentsLoading}
              countsLoading={countsLoading}
              mountedCounts={mountedCounts}
              currentUser={currentUser}
              isAdmin={_isAdmin}
              canSeeAllAgents={canSeeAllAgents}
              onCreateAgent={() => setShowCreateAgent(true)}
              onEditAgent={setEditingAgent}
              onDeleteAgent={handleDeleteAgent}
            />
          )}
        </>
      )}

      {/* Modals */}
      {showCreateTeam && (
        <CreateTeamDialog
          onClose={() => setShowCreateTeam(false)}
          onCreate={handleCreateTeam}
          busy={busy}
        />
      )}
      {showCreateAgent && activeTeam && (
        <CreateAgentDialog
          team={{ team_id: activeTeam.team_id, name: activeTeam.name }}
          currentUser={currentUser}
          onClose={() => setShowCreateAgent(false)}
          onCreated={handleCreateAgent}
          busy={busy}
        />
      )}
      {showAddMember && activeTeam && (
        <AddMemberDialog
          team={activeTeam}
          onClose={() => setShowAddMember(false)}
          onCreatedUser={setCreatedUserKeyInfo}
          currentUser={currentUser}
          isAdmin={_isAdmin}
        />
      )}
      {createdUserKeyInfo && (
        <CreatedUserKeyModal
          info={createdUserKeyInfo}
          onClose={() => setCreatedUserKeyInfo(null)}
        />
      )}
      {editingAgent && activeTeam && (
        <AgentEditDialog
          agent={editingAgent}
          onClose={() => setEditingAgent(null)}
        />
      )}
    </div>
  );
}

// =================== Empty state ===================

/**
 * Empty-state guidance.
 *
 * Historical behavior: any logged-in user could create their own first team (team/create has no admin restriction,
 * the creator automatically becomes owner), so this used to not distinguish admin / non-admin.
 *
 * Current behavior: the frontend temporarily hides the entry for regular users to create a team,
 * only admin sees the create CTA; regular users only see the "contact administrator" hint.
 * The backend team/create itself still has no role restriction; this hiding is implemented only in the frontend.
 */
function EmptyTeamState({ onCreateTeam }: { onCreateTeam?: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="_memory-empty-team">
      <UsergroupIcon size={32} className="_memory-empty-team-icon" />
      <div className="_memory-empty-team-title">{t('team.emptyTeam.title')}</div>
      <div className="_memory-empty-team-desc">
        {onCreateTeam ? t('team.emptyTeam.desc') : t('team.emptyTeam.contactAdmin')}
      </div>
      {onCreateTeam && (
        <Button type="primary" onClick={onCreateTeam} className="_memory-empty-team-cta">
          <AddIcon size={14} /> {t('team.emptyTeam.cta')}
        </Button>
      )}
    </div>
  );
}
