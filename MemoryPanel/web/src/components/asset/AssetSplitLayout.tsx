/**
 * AssetSplitLayout — Generic split-pane layout for asset management pages.
 *
 * Unifies the "left list + right detail" split structure of asset pages such as Skills / Memory:
 * - Left/right widths are drag-adjustable; the ratio is remembered in localStorage (kept next time in the same browser)
 * - The right detail pane has a max height; overflowing content scrolls inside the detail area without stretching the outer page height
 *   (the outer container shows no scrollbar)
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import './asset-split-layout.css';

interface AssetSplitLayoutProps {
  sidebar: ReactNode;
  detail: ReactNode;
  /** Persistence key for the dragged width (pages do not interfere with each other); not persisted if omitted */
  storageKey?: string;
}

const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 480;
const DEFAULT_SIDEBAR = 280;

function clampWidth(w: number): number {
  return Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w));
}

function readStoredWidth(storageKey?: string): number {
  if (!storageKey) return DEFAULT_SIDEBAR;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_SIDEBAR;
  } catch {
    return DEFAULT_SIDEBAR;
  }
}

export function AssetSplitLayout({ sidebar, detail, storageKey }: AssetSplitLayoutProps) {
  const { t } = useTranslation();
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredWidth(storageKey));
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // While dragging: compute the left column width relative to the container's left edge, clamped within [MIN, MAX]
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setSidebarWidth(clampWidth(e.clientX - rect.left));
    };
    const onUp = () => setDragging(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    // Disable text selection while dragging to avoid selecting list content
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging]);

  // Persist the final width after dragging ends
  useEffect(() => {
    if (dragging || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(sidebarWidth));
    } catch {
      /* localStorage unavailable: silently ignore; only affects the remembering ability */
    }
  }, [dragging, sidebarWidth, storageKey]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  return (
    <div
      ref={containerRef}
      className={`_asset-split${dragging ? ' _asset-split--dragging' : ''}`}
      style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}
    >
      <section className="_asset-split-sidebar">{sidebar}</section>
      <button
        type="button"
        className="_asset-split-resizer"
        aria-label={t('assetSplit.resizer.label')}
        onMouseDown={onHandleMouseDown}
        onKeyDown={(e) => {
          // Keyboard accessible: left/right arrows adjust the left column width in 16px steps
          if (e.key === 'ArrowLeft') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w - 16));
          } else if (e.key === 'ArrowRight') {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w + 16));
          }
        }}
      >
        <span className="_asset-split-resizer-bar" />
      </button>
      <section className="_asset-split-detail">{detail}</section>
    </div>
  );
}
