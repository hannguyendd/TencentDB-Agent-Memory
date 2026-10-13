/**
 * UserName -- unified display and fallback for "user_id -> username".
 *
 * Batch resolution via user/list (useUserNames) may fail to resolve some ids (internal accounts
 * filtered by the proxy layer / deleted users, etc.); the old logic rendered the bare user_id as text, which looked like
 * a "missing name". This handles it uniformly:
 *   - resolved -> render the username (tooltip carries the full user_id, to distinguish ids with the same short prefix)
 *   - unresolved -> render a muted "Unrecognized user" placeholder + tooltip with the full user_id,
 *     so callers/users can still get the id without showing the id as a name.
 *
 * Usage: place it inside the caller's existing container (plain text cell / link button both work);
 * this component has its own ellipsis and tooltip and no longer depends on the outer container.
 */
import { useTranslation } from 'react-i18next';
import { Text } from 'tea-component';

export function UserName({
  userId,
  displayName,
}: {
  /** Raw user_id (used for tooltip display / fallback logic). */
  userId: string;
  /** Display name resolved by useUserNames; internally falls back to user_id when resolution fails. */
  displayName: string;
}) {
  const { t } = useTranslation();
  const resolved = displayName !== userId;
  return (
    <Text overflow tooltip={userId} theme={resolved ? undefined : 'weak'}>
      {resolved ? displayName : t('analytics.member.unrecognized')}
    </Text>
  );
}
