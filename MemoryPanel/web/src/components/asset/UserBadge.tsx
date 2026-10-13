/**
 * UserBadge —— Generic "user badge" component.
 *
 * Previously Skills (SkillOwnerTag) and Memory (UploaderBadge) each implemented the same
 * "AssetBadge + UserIcon + displayName display + append a "You" marker for the current user" structure.
 * This consolidates them; displayName comes from the useUserDisplayName global cache, and title /title /
 * youText / getTitle are injected by the caller to stay compatible with each page's i18n.
 */
import { UserIcon } from 'tea-icons-react';
import { useUserDisplayName } from '@/services/user-profile-store';
import { AssetBadge, AssetBadgeYou } from './AssetListPanel';

export function UserBadge({
  userId,
  isCurrentUser,
  title,
  youText,
  getTitle,
}: {
  userId: string;
  /** Whether this is the current user (decides whether to append the "You" marker) */
  isCurrentUser: boolean;
  /** hover tooltip text; defaults to userId. If it must be built from displayName (e.g. skills), use getTitle getTitle */
  title?: string;
  /** "You" marker text */
  youText: string;
  /** Callback that generates the hover tooltip from displayName (takes precedence over title) */
  getTitle?: (displayName: string) => string;
}) {
  const displayName = useUserDisplayName(userId);
  const resolvedTitle = getTitle
    ? getTitle(displayName || userId)
    : (title ?? userId);
  return (
    <AssetBadge icon={<UserIcon size={10} />} title={resolvedTitle}>
      {displayName || userId}
      {isCurrentUser && <AssetBadgeYou>{youText}</AssetBadgeYou>}
    </AssetBadge>
  );
}
