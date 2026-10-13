/**
 * AssetListPanel — Generic left-side list panel for asset management pages.
 *
 * Unifies the left-side navigation list container of asset pages such as Skills / Memory, providing:
 *   - Panel title + item count
 *   - Loading skeleton
 *   - Empty-state hint
 *   - Selection state management (light brand background, no border)
 *   - Unified 4-row list item structure (title / description / badge / meta)
 *
 * List item content is filled in by each asset page via a render prop,
 * keeping the container decoupled from business logic.
 */

import type { ReactNode } from 'react';
import './asset-list-panel.css';

/* ── Panel ── */

interface AssetListPanelProps<T> {
  /** Panel title */
  title: ReactNode;
  /** Item count text */
  count?: ReactNode;
  /** Whether loading */
  loading?: boolean;
  /** Data items */
  items: T[];
  /** Currently selected item id id */
  selectedId?: string | null;
  /** Extract a unique id from a data item id */
  getItemId: (item: T) => string;
  /** Selection callback */
  onSelect: (item: T) => void;
  /** Render a single list item's content (excluding the outer selection-state container) */
  renderItem: (item: T, isSelected: boolean) => ReactNode;
  /** Determine whether an item is disabled (not clickable) */
  isItemDisabled?: (item: T) => boolean;
  /** Empty-state text */
  emptyText?: ReactNode;
}

export function AssetListPanel<T>({
  title,
  count,
  loading,
  items,
  selectedId,
  getItemId,
  onSelect,
  renderItem,
  isItemDisabled,
  emptyText,
}: AssetListPanelProps<T>) {
  return (
    <div className="_alp">
      <div className="_alp-header">
        <span className="_alp-title">{title}</span>
        {!loading && count != null && <span className="_alp-count">{count}</span>}
      </div>

      {loading ? (
        <div className="_alp-items">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="_alp-item _alp-skeleton">
              <div className="_alp-skeleton-line _alp-skeleton-primary" />
              <div className="_alp-skeleton-line _alp-skeleton-secondary" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="_alp-empty">{emptyText}</div>
      ) : (
        <ul className="_alp-items">
          {items.map((item) => {
            const id = getItemId(item);
            const isSelected = selectedId === id;
            const disabled = isItemDisabled?.(item) ?? false;
            return (
              <li
                key={id}
                className={[
                  '_alp-item',
                  isSelected ? '_alp-item--selected' : '',
                  disabled ? '_alp-item--disabled' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <button
                  type="button"
                  className="_alp-item-btn"
                  onClick={() => !disabled && onSelect(item)}
                  disabled={disabled}
                >
                  {renderItem(item, isSelected)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── List item content area — standardized 4-row structure ── */

/** Title row: primary identifier + optional action button */
export function AssetItemHeader({ children }: { children: ReactNode }) {
  return <div className="_alp-item-header">{children}</div>;
}

/** Name / title text */
export function AssetItemName({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="_alp-item-name" title={title}>
      {children}
    </span>
  );
}

/** Real asset id — shown de-emphasized next to the name, to help identify assets with ID-based naming (name + id combination) */
export function AssetItemId({ children }: { children: ReactNode }) {
  return (
    <span className="_alp-item-id" title={typeof children === 'string' ? children : undefined}>
      {children}
    </span>
  );
}

/** Description text (truncated to 2 lines) */
export function AssetItemDesc({ children }: { children: ReactNode }) {
  return <p className="_alp-item-desc">{children}</p>;
}

/** Badge row container */
export function AssetItemBadges({ children }: { children: ReactNode }) {
  return <div className="_alp-item-badges">{children}</div>;
}

/** Plain-text badge — replaces the bright Tag Tag */
export function AssetBadge({
  icon,
  children,
  title,
}: {
  icon?: ReactNode;
  children: ReactNode;
  title?: string;
}) {
  return (
    <span className="_alp-badge" title={title}>
      {icon}
      {children}
    </span>
  );
}

/** "Includes you"/"You" marker — brand-color plain text */
export function AssetBadgeYou({ children }: { children: ReactNode }) {
  return <span className="_alp-badge-you">{children}</span>;
}

/** Meta row container */
export function AssetItemMeta({ children }: { children: ReactNode }) {
  return <div className="_alp-item-meta">{children}</div>;
}

/** Meta right-side time */
export function AssetItemTime({ children }: { children: ReactNode }) {
  return <span className="_alp-item-time">{children}</span>;
}
