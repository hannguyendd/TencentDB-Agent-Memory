/**
 * SkillsPanel — single tab in the App-level top-nav. Shows the team's
 * skill library across two lenses and offers three write actions:
 * import / allocate / fork.
 *
 * Tab semantics:
 *   - team   = union of the fixed assets of all agents in the current team (deduplicated by name);
 *              from the user's view it is "all skills owned by the team"; the data side drops the standalone "floating pool" concept.
 *   - fixed  = the fixed assets of a single agent (isolated by agent_id).
 *
 * Write operations:
 *   - Import  -> available only under the fixed tab, landing on the currently selected agent.
 *   - Allocate -> available after selecting a skill under the team tab. The backend uses a team_to_agent reference,
 *            and the allocated agent gets a "read-only" copy (shared SKILL.md; editing would affect the team version).
 *   - Fork -> available after selecting a skill under the team tab. The frontend assembles `fetchSkillFull -> importSkill`,
 *            creating a new copy named `<original-name>-fork-<agentId>`, and the agent gets an independent writable copy.
 *
 * Permission model:
 *   - admin users: everything visible + everything operable
 *   - skill owner: can edit their own skill; can choose whether to make it visible to others
 *   - everyone else: can only see skills the owner set as visible (visible = copyable + read-only use)
 *
 * Refresh strategy: poll on tab change + after every write action. No
 * setInterval — skill mutations are user-driven, the auto-refresh cost
 * is not worth it.
 *
 */
import { useTranslation } from 'react-i18next';
import { Button, Select, Segment, Tag, Tooltip } from 'tea-component';
import { DeleteIcon } from 'tea-icons-react';
import { tea } from '@/lib/tea-bridge';
import { AssetPageHeader } from '@/components/asset/AssetPageHeader';
import { AssetSplitLayout } from '@/components/asset/AssetSplitLayout';
import {
  AssetListPanel,
  AssetItemHeader,
  AssetItemName,
  AssetItemId,
  AssetItemBadges,
  AssetItemTime,
} from '@/components/asset/AssetListPanel';
import { UserBadge } from '@/components/asset/UserBadge';
import SkillDetailPane from './SkillDetailPane';
import ImportSkillDialog from './ImportSkillDialog';
import ForkSkillDialog from './ForkSkillDialog';
import { TAB_I18N_KEY, useSkillsPanel, type Tab } from '../hooks/useSkillsPanel';
import '../styles/skills-list.css';

export default function SkillsPanel({
  currentUser: _currentUser,
  isAdmin: _isAdmin,
}: {
  currentUser: string;
  isAdmin: boolean;
}) {
  const { t } = useTranslation();
  const store = useSkillsPanel();

  const {
    // context
    activeTeam,
    activeTeamId,
    myUserId,
    teamAgents,
    agentNameMap,
    // state
    tab,
    setTab,
    selectedAgent,
    setSelectedAgent,
    loading,
    selectedSkillId,
    setSelectedSkillId,
    showImport,
    setShowImport,
    showFork,
    setShowFork,
    deleteLoading,
    exportLoading,
    visibilityMap,
    skills,
    // cache
    skillsWithCache,
    // handlers
    refresh,
    handleDelete,
    handleExport,
    handleToggleVisibility,
    selectedSkill,
  } = store;

  return (
    <div className="_memory-skills-body">
      {/* The Agent selector for fixed assets is presented the same as the "Agent assets" option bar on the Code page. */}
      <AssetPageHeader
        title={t('skills.title')}
        subtitle={
          activeTeam
            ? t('skills.subtitle.team', { name: activeTeam.name, count: skills.length })
            : t('skills.subtitle.global', { count: skills.length })
        }
        scope={
          <Segment
            value={tab}
            onChange={(v) => setTab(v as Tab)}
            options={(['team', 'fixed'] as Tab[]).map((t2) => ({
              value: t2,
              text: t(TAB_I18N_KEY[t2]),
            }))}
          />
        }
        agent={
          tab === 'fixed' ? (
            <Select
              appearance="button"
              matchButtonWidth
              value={selectedAgent}
              onChange={(value) => {
                setSelectedAgent(value);
                setSelectedSkillId(null);
              }}
              disabled={teamAgents.length === 0}
              placeholder={t('skills.noAgent')}
              options={teamAgents.map((agent) => ({
                value: agent.id,
                text: `${agent.name}（${agent.id}）`,
              }))}
            />
          ) : undefined
        }
        actions={
          <>
            {(() => {
              const canFork = tab === 'team' && !!selectedSkillId;
              const tooltip =
                tab === 'fixed'
                  ? t('skills.fork.tooltip.fixed')
                  : !selectedSkillId
                    ? t('skills.fork.tooltip.team.empty')
                    : undefined;
              return tab === 'fixed' ? null : (
                <Button onClick={() => setShowFork(true)} disabled={!canFork} tooltip={tooltip}>
                  {t('skills.fork')}
                </Button>
              );
            })()}
            {(() => {
              const canExport = !!selectedSkillId;
              const exportTooltip = !selectedSkillId ? t('skills.export.tooltip.empty') : undefined;
              return (
                <Button
                  onClick={handleExport}
                  disabled={!canExport}
                  tooltip={exportTooltip}
                  loading={exportLoading}
                >
                  {t('skills.export')}
                </Button>
              );
            })()}
            <Button
              type="primary"
              onClick={() => setShowImport(true)}
              disabled={teamAgents.length === 0}
              tooltip={teamAgents.length === 0 ? t('skills.import.tooltip.noAgent') : undefined}
              data-guide="import-skill"
            >
              {t('skills.import')}
            </Button>
          </>
        }
      />

      {/* === Team assets / Fixed assets Tab === */}
      <AssetSplitLayout
        storageKey="skills:assetSplitWidth"
        sidebar={
          <AssetListPanel
            title={
              <>
                {t(TAB_I18N_KEY[tab])}
                {tab === 'fixed' && selectedAgent && (
                  <span className="_alp-title-suffix">
                    {' '}
                    · {agentNameMap[selectedAgent] ?? selectedAgent}
                  </span>
                )}
              </>
            }
            count={t('skills.count', { count: skillsWithCache.length })}
            loading={loading}
            items={skillsWithCache}
            selectedId={selectedSkillId}
            getItemId={(s) => s.skill_id}
            onSelect={(s) => setSelectedSkillId(s.skill_id)}
            emptyText={
              tab === 'fixed' && !selectedAgent
                ? t('skills.empty.fixed.noAgent')
                : tab === 'fixed'
                  ? t('skills.empty.fixed.hasAgent', { agent: selectedAgent })
                  : t('skills.empty.team')
            }
            renderItem={(s) => {
              const ownerIsMe = !!myUserId && s.owner_user_id === myUserId;
              const canManage = ownerIsMe;
              const vis = visibilityMap[s.skill_id];
              return (
                <>
                  <AssetItemHeader>
                    {/* The version Tag is placed before the name and shown only in the fixed (Agent assets) tab:
                        that tab's data source is listSkills (the skill data plane), whose version is real and trustworthy;
                        the team tab goes through assetsApi.listAccessible, whose asset table has no version field
                        (always the fallback value 1, backfilled by useSkillDetailCache only after opening),
                        so showing it would mislead and jump, hence it is not shown. */}
                    {tab === 'fixed' && (
                      <Tooltip title={t('skills.versionTag.title', { version: s.version })}>
                        <Tag theme="primary" className="_memory-skill-item-version">
                          v{s.version}
                        </Tag>
                      </Tooltip>
                    )}
                    <AssetItemName title={s.name}>{s.name}</AssetItemName>
                    {canManage && (
                      <Button
                        type="text"
                        tooltip={ownerIsMe ? t('skills.delete.own') : t('skills.delete.admin')}
                        className="_memory-skill-item-delete"
                        onClick={async (e: any) => {
                          e?.stopPropagation();
                          const ok = await tea.confirm({
                            message: t('skills.delete.confirm', { name: s.name }),
                            description: t('skills.delete.confirm.desc'),
                            okText: t('skills.delete.okText'),
                            cancelText: t('skills.delete.cancelText'),
                          });
                          if (ok) {
                            void handleDelete(s);
                          }
                        }}
                        disabled={deleteLoading}
                      >
                        <DeleteIcon size={14} />
                      </Button>
                    )}
                  </AssetItemHeader>

                  {/* Row 2: the asset's real id, monospace gray (same structure as the ChatMemory page) */}
                  <AssetItemId>{s.skill_id}</AssetItemId>

                  <AssetItemBadges>
                    {s.owner_user_id && (
                      <UserBadge
                        userId={s.owner_user_id}
                        isCurrentUser={ownerIsMe}
                        youText={t('skills.ownerTag.you')}
                        getTitle={(name) =>
                          t('skills.ownerTag.title', { name, id: s.owner_user_id })
                        }
                      />
                    )}
                    <AssetItemTime>{new Date(s.updated_at_ms).toLocaleString()}</AssetItemTime>
                  </AssetItemBadges>

                  {/* Shared/private toggle: the capability of the former "Personal assets" tab, moved to the "Agent assets" tab,
                      switchable by the owner only; from the owner's view getAssets has turned off visibility filtering,
                      so private skills also return vis. Even if vis is occasionally missing it is rendered as private as a fallback,
                      to avoid the toggle button vanishing after a skill is switched to private so it can never be switched back to team. */}
                  {tab === 'fixed' && ownerIsMe && (
                    <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                      <Segment
                        value={vis === 'team' ? 'team' : 'private'}
                        onChange={(v) => handleToggleVisibility(s, v as 'team' | 'private')}
                        options={[
                          { value: 'team', text: t('skills.personal.scope.shared') },
                          { value: 'private', text: t('skills.personal.scope.private') },
                        ]}
                      />
                    </div>
                  )}
                </>
              );
            }}
          />
        }
        detail={
          <SkillDetailPane
            skillName={selectedSkill?.name ?? null}
            // Pass the raw selectedSkillId (an independent state) rather than selectedSkill?.skill_id (derived from the list):
            // it has a value as soon as selected, unaffected by agent/skill list loading or refresh timing, avoiding the detail panel flashing the empty state before the loading state.
            skillId={selectedSkillId ?? undefined}
            teamId={activeTeamId ?? undefined}
            userId={myUserId}
            // Edit permission matches delete: only the skill's owner (owner_user_id === current user) can edit
            canEdit={!!myUserId && selectedSkill?.owner_user_id === myUserId}
            onChanged={() => void refresh()}
          />
        }
      />

      {/* Modals (only for team/fixed tabs) */}
      {showImport && (
        // The import dialog can be opened in both the team and fixed tabs.
        // target is always fixed -- every skill belongs to a specific agent.
        // agentId is brought in as the default owner only under the fixed tab; under the team tab undefined is passed,
        // and the "Owner Agent (required)" dropdown in the dialog falls back to selecting the first one itself.
        <ImportSkillDialog
          target="fixed"
          teamId={activeTeamId ?? ''}
          userId={myUserId}
          agents={teamAgents}
          agentId={tab === 'fixed' ? selectedAgent : undefined}
          onClose={() => setShowImport(false)}
          onImported={() => {
            // After a skill is created successfully, the kernel data plane's onSkillCreated hook automatically registers the asset
            // + binds it as the owner agent's fixed-asset (visibility defaults to private).
            // The frontend no longer needs to additionally call localStorage to store "my assets" -- the data source is already the real backend.
            setShowImport(false);
            void refresh();
          }}
        />
      )}
      {showFork &&
        (() => {
          // Source of the Fork dialog's skillId/skillName: selectedSkill (the list comes from asset/list-accessible)
          const source = selectedSkill
            ? { skillId: selectedSkill.skill_id, skillName: selectedSkill.name }
            : null;
          if (!source) return null;
          return (
            <ForkSkillDialog
              teamId={activeTeamId ?? ''}
              userId={myUserId}
              skillId={source.skillId}
              skillName={source.skillName}
              agents={teamAgents}
              onClose={() => setShowFork(false)}
              onForked={() => {
                setShowFork(false);
                // The new copy produced by fork is stored as `<original-name>-fork-<agentId>` and appears as a new entry
                void refresh();
              }}
            />
          );
        })()}
    </div>
  );
}
