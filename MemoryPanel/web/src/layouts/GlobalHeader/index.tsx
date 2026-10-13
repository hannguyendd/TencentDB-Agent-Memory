/**
 * GlobalHeader - global top bar (spans the sidebar + content area, outermost full-width bar)
 *
 *   Left: brand Logo "Memory Hub" + divider + team switcher (TeamSwitcher)
 *   Right: sync status indicator + language switch + user avatar menu
 */
import { useState } from 'react';
import {
  Avatar,
  Button,
  Copy,
  Dropdown,
  Input,
  InputAdornment,
  Justify,
  List,
  Modal,
  Tag,
  Text,
} from 'tea-component';
import { SettingIcon } from 'tea-icons-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { SettingsDialog } from '@/components/SettingsDialog';
import { type TeamRole } from '@/services/useCurrentRole';
import { TeamSwitcher } from './TeamSwitcher';
import { LanguageSwitcher } from './LanguageSwitcher';
import './style.css';

export function GlobalHeader({
  userRole,
  currentUser,
  currentUserId,
  instanceName,
  onLogout,
}: {
  userRole: TeamRole | null;
  currentUser: string;
  currentUserId?: string;
  /** Name of the memory instance the current login belongs to (from auth.instance_name), shown in "My Profile" */
  instanceName?: string;
  onLogout: () => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);

  return (
    <header className="_memory-global-header">
      {/* Left: brand + team switcher */}
      <div className="_memory-global-header-left">
        <div className="_memory-global-header-brand">
          <img src="/logo.png" alt="Memory Hub" className="_memory-global-header-logo" />
          <span className="_memory-global-header-brand-text">{t('header.brand')}</span>
        </div>
        <TeamSwitcher userRole={userRole} />
      </div>

      {/* Right: sync status + language switch + user menu */}
      <div className="_memory-global-header-right">
        {/* <span className="_memory-global-header-sync" title={t('header.sync.title')}>
        <span className="_memory-global-header-sync-dot" />
        {t('header.sync')}
      </span> */}

        {/* Guide: enters the standalone guide page; shows active state while on that page */}
        <button
          type="button"
          className={`_memory-global-header-guide-btn${location.pathname === '/guide' ? ' is-active' : ''}`}
          onClick={() => navigate('/guide')}
        >
          {t('header.guide')}
        </button>

        <LanguageSwitcher />

        <button
          type="button"
          className="_memory-global-header-icon-btn"
          title={t('header.settings')}
          onClick={() => setSettingsOpen(true)}
        >
          <SettingIcon size={16} />
        </button>

        <Dropdown
          appearance="pure"
          button={
            <button type="button" className="_memory-global-header-user-btn">
              <span className="_memory-global-header-avatar">
                {currentUser.slice(0, 1).toUpperCase()}
              </span>
              <span className="_memory-global-header-username">{currentUser}</span>
            </button>
          }
        >
          {(close) => (
            <List type="option">
              <List.Item
                onClick={() => {
                  close();
                  setProfileOpen(true);
                }}
              >
                {t('header.profile')}
              </List.Item>
              <List.Item
                onClick={() => {
                  close();
                  onLogout();
                }}
              >
                {t('header.logout')}
              </List.Item>
            </List>
          )}
        </Dropdown>
      </div>

      {profileOpen && currentUserId && (
        <ProfileModal
          currentUser={currentUser}
          currentUserId={currentUserId}
          userRole={userRole}
          instanceName={instanceName}
          onClose={() => setProfileOpen(false)}
        />
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </header>
  );
}

// =================== Profile Modal ===================

/** TeamRole → display text + Tag theme color */
function roleDisplay(role: TeamRole | null): { label: string; theme: 'primary' | 'default' | 'warning' } {
  if (role === 'admin') return { label: 'admin', theme: 'primary' };
  if (role === 'reviewer') return { label: 'reviewer', theme: 'warning' };
  return { label: 'member', theme: 'default' };
}

/**
 * "My Profile" dialog: tea Avatar + Justify + Text/Tag descriptive display.
 *
 * Key design:
 *   - Header Avatar + username + role Tag on one line (Justify left/right aligned)
 *   - User ID uses InputAdornment + Copy on one line, copyable, avoiding a separate block
 *   - Owning instance (if any) is grouped separately with Card.Body, distinguishing its semantics from User ID
 */
function ProfileModal({
  currentUser,
  currentUserId,
  userRole,
  instanceName,
  onClose,
}: {
  currentUser: string;
  currentUserId: string;
  userRole: TeamRole | null;
  instanceName?: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const initial = currentUser.slice(0, 1).toUpperCase();
  const role = roleDisplay(userRole);

  return (
    <Modal visible size="s" onClose={onClose} caption={t('header.profile.caption')}>
      <Modal.Body>
        {/* Header: Avatar + username + role Tag */}
        <Justify
          left={
            <div className="_memory-profile-identity">
              <Avatar
                color={currentUserId}
                text={initial}
                width={48}
                height={48}
              />
              <div className="_memory-profile-identity-meta">
                <Text theme="strong" parent="div" className="_memory-profile-identity-name">
                  {currentUser}
                </Text>
                <Text theme="weak" parent="div" className="_memory-profile-identity-id">
                  {currentUserId}
                </Text>
              </div>
            </div>
          }
          right={<Tag theme={role.theme} variant="soft">{t(`header.profile.role.${role.label}`)}</Tag>}
        />

        <div className="_memory-profile-divider" />

        {/* User ID: its own block + Copy, for admin to use when inviting members */}
        <div className="_memory-profile-section">
          <Text theme="label" parent="div" className="_memory-profile-section-label">
            {t('header.profile.userId')}
          </Text>
          <InputAdornment after={<Copy text={currentUserId} />} className="_memory-profile-input-adornment">
            <Input value={currentUserId} readonly size="full" />
          </InputAdornment>
          <Text theme="weak" parent="div" className="_memory-profile-section-hint">
            {t('header.profile.userIdHint')}
          </Text>
        </div>

        {/* Username: plain-text hint, so users can verify their registered name */}
        <div className="_memory-profile-section">
          <Text theme="label" parent="div" className="_memory-profile-section-label">
            {t('header.profile.username')}
          </Text>
          <Input value={currentUser} readonly size="full" />
          <Text theme="weak" parent="div" className="_memory-profile-section-hint">
            {t('header.profile.usernameHint')}
          </Text>
        </div>

        {/* Owning instance (optional) - lets multi-instance users know which one they are connected to now */}
        {instanceName && (
          <div className="_memory-profile-section">
            <Text theme="label" parent="div" className="_memory-profile-section-label">
              {t('header.profile.instance')}
            </Text>
            <InputAdornment
              after={<Tag size="sm" variant="outlined">{currentUserId.split('-')[0]}</Tag>}
              className="_memory-profile-input-adornment"
            >
              <Input value={instanceName} readonly size="full" />
            </InputAdornment>
          </div>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button onClick={onClose}>{t('header.profile.close')}</Button>
      </Modal.Footer>
    </Modal>
  );
}