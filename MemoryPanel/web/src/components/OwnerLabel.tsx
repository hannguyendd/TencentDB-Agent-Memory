/**
 * OwnerLabel —— Generic "asset owner display" component.
 *
 * Previously Wiki (WikiOwnerLabel) and Code (CodeOwnerLabel) each implemented the exact same
 * "@displayName + append a "You" marker for the current user" logic (both depend on the useUserDisplayName global
 * cache, plus a child-component structure forced by the Rules of Hooks, which forbid calling hooks in a loop inside .map).
 * This consolidates them in one place; title / youText / youClassName are injected by the caller to stay compatible with each page's i18n and styling.
 */
import { useUserDisplayName } from '@/services/user-profile-store';

export function OwnerLabel({
  userId,
  currentUserId,
  title,
  youText,
  youClassName,
}: {
  userId: string;
  currentUserId: string;
  /** hover tooltip text (the caller handles i18n; usually includes userId interpolation) */
  title: string;
  /** "You" marker text (shown for the current user) */
  youText: string;
  /** Class for the "You" marker (each page can inject its own style class) */
  youClassName?: string;
}) {
  const name = useUserDisplayName(userId);
  return (
    <span title={title}>
      @{name || userId}
      {userId === currentUserId && (
        <span className={youClassName ?? '_owner-label-you'}>{youText}</span>
      )}
    </span>
  );
}
