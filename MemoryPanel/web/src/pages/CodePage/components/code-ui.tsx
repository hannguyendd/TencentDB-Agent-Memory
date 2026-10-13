/**
 * code-ui -- small display components of the Code asset page.
 * Split out of CodeSourcesPanel.tsx: Owner label / status label.
 */
import { useTranslation } from 'react-i18next';
import { StatusTag, type StatusTheme } from '@/components/StatusTag';
import { OwnerLabel } from '@/components/OwnerLabel';

/**
 * Owner display -- reuses the generic OwnerLabel (uses the user-profile-store global cache, shared by multiple rows with the same owner).
 * Extracting a sub-component is required by the Rules of Hooks (hooks cannot be called in a loop inside .map).
 */
export function CodeOwnerLabel({ userId, currentUserId }: { userId: string; currentUserId: string }) {
  const { t } = useTranslation();
  return (
    <OwnerLabel
      userId={userId}
      currentUserId={currentUserId}
      title={t('code.detail.owner', { userId })}
      youText={t('code.detail.you')}
      youClassName="_codelist-card-meta-you"
    />
  );
}

// Status -> Tea Tag semantic theme mapping (soft variant), aligned with Memory's statusTheme.
export function statusLabel(t: (key: string, options?: Record<string, unknown>) => string, s: string) {
  const map: Record<string, [string, StatusTheme]> = {
    ready: [t('code.status.ready'), 'success'],
    pending: [t('code.status.pending'), 'warning'],
    processing: [t('code.status.processing'), 'warning'],
    failed: [t('code.status.failed'), 'error'],
    cloning: [t('code.status.cloning'), 'warning'],
    indexing: [t('code.status.indexing'), 'warning'],
    syncing: [t('code.status.syncing'), 'warning'],
    error: [t('code.status.error'), 'error'],
    missing: [t('code.status.missing'), 'error'],
  };
  const [label, theme] = map[s] ?? [s, 'default'];
  const hint = s === 'pending' || s === 'processing' ? t('code.statusHint.processing') : '';
  return <StatusTag label={label} theme={theme} hint={hint} />;
}
