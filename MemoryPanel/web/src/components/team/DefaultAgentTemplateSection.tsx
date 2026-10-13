/**
 * DefaultAgentTemplateSection - "Default Agent template" management area (visible to global admin only).
 *
 * Placed above AgentGrid on the Agents page:
 *   - Not configured: shows the "Create default Agent" entry;
 *   - Configured: shows the current template summary + the "Edit configuration" entry.
 *
 * Data source: agent/get-default-template (no permission check); the write op agent/set-default-template
 * can only be called by system_admin, so this component renders only when isAdmin=true.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from 'tea-component';
import { AddIcon, EditIcon } from 'tea-icons-react';
import { agentsApi, type AgentTemplateConfig } from '@/lib/teamApi';
import { tea } from '@/lib/tea-bridge';
import { getErrorMessage } from '@/lib/error-message';
import DefaultAgentTemplateDialog from './DefaultAgentTemplateDialog';

export default function DefaultAgentTemplateSection({
  teamId,
  teamName,
}: {
  teamId: string;
  teamName: string;
}) {
  const { t } = useTranslation();
  const [template, setTemplate] = useState<AgentTemplateConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [showDialog, setShowDialog] = useState(false);

  const load = useCallback(async () => {
    if (!teamId) return;
    setLoading(true);
    try {
      const data = await agentsApi.getDefaultTemplate(teamId);
      // When not configured the backend returns {}; configured is determined by whether name exists
      setTemplate(data && data.name ? data : null);
    } catch (err) {
      tea.notify.error(getErrorMessage(err));
      setTemplate(null);
    } finally {
      setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    load();
  }, [load]);

  function handleSaved(saved: AgentTemplateConfig) {
    setTemplate(saved);
    setShowDialog(false);
    tea.notify.success(t('defaultAgent.notify.saved'));
  }

  const hasTemplate = !!template;
  const actionButton = hasTemplate ? (
    <Button onClick={() => setShowDialog(true)} title={t('defaultAgent.edit.tooltip')}>
      <EditIcon size={14} /> {t('defaultAgent.edit')}
    </Button>
  ) : (
    <Button
      type="primary"
      onClick={() => setShowDialog(true)}
      title={t('defaultAgent.create.tooltip')}
    >
      <AddIcon size={14} /> {t('defaultAgent.create')}
    </Button>
  );

  return (
    <div className="_memory-panel-card _memory-default-agent-section">
      <div className="_memory-default-agent-head">
        <div className="_memory-default-agent-info">
          <div className="_memory-default-agent-title">{t('defaultAgent.title')}</div>
          <div className="_memory-default-agent-desc">{t('defaultAgent.desc')}</div>
        </div>
        <div className="_memory-default-agent-actions">{actionButton}</div>
      </div>

      {loading ? (
        <div className="_memory-default-agent-body">
          <span className="_memory-default-agent-placeholder">{t('team.loading')}</span>
        </div>
      ) : hasTemplate ? (
        <div className="_memory-default-agent-body">
          <div className="_memory-default-agent-name" title={template!.name}>
            {template!.name}
          </div>
          <div className="_memory-default-agent-detail">
            {template!.description || t('common.noDescription')}
          </div>
        </div>
      ) : (
        <div className="_memory-default-agent-body">
          <span className="_memory-default-agent-placeholder">
            {t('defaultAgent.empty')}
          </span>
        </div>
      )}

      {showDialog && (
        <DefaultAgentTemplateDialog
          team={{ team_id: teamId, name: teamName }}
          initial={template}
          onClose={() => setShowDialog(false)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}
