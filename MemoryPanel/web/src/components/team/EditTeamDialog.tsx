import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Form, Input, Modal } from 'tea-component';
import type { Team } from '@/services';

/**
 * EditTeamDialog - edit the current team's name / description.
 *
 * Same form style as CreateTeamDialog, prefilled with the team's current values on entry;
 * submits via teamsApi.update (team/update, only owner / admin can modify,
 * the backend silently ignores immutable fields such as owner_user_id).
 */
export default function EditTeamDialog({
  team,
  onClose,
  onSave,
  busy,
}: {
  team: Team;
  onClose: () => void;
  onSave: (input: { name: string; description: string }) => void;
  busy: boolean;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(team.name);
  const [description, setDescription] = useState(team.description ?? '');
  const canSubmit = name.trim().length > 0 && !busy;
  return (
    <Modal
      visible
      caption={t('editTeam.caption', { name: team.name })}
      size="s"
      onClose={onClose}
      disableEscape={busy}
    >
      <Modal.Body>
        <Form>
          <Form.Item label={t('editTeam.name')} required>
            <Input
              size="full"
              value={name}
              onChange={setName}
              placeholder={t('editTeam.name.placeholder')}
            />
          </Form.Item>
          <Form.Item label={t('editTeam.desc')}>
            <Input.TextArea
              size="full"
              value={description}
              onChange={setDescription}
              rows={3}
              placeholder={t('editTeam.desc.placeholder')}
            />
          </Form.Item>
        </Form>
      </Modal.Body>
      <Modal.Footer>
        <Button
          type="primary"
          disabled={!canSubmit}
          loading={busy}
          onClick={() => onSave({ name: name.trim(), description: description.trim() })}
        >
          {t('editTeam.submit')}
        </Button>
        <Button onClick={onClose} disabled={busy}>{t('editTeam.cancel')}</Button>
      </Modal.Footer>
    </Modal>
  );
}
