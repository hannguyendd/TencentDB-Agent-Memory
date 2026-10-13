/**
 * memory-utils -- constants, pure utility functions and types of the Chat Memory page.
 * Split out of ChatMemoryPanel.tsx.
 */
import { ApiError, type ChatMemoryLayerItem } from '@/lib/teamApi';
import type { MemoryBlock, MemoryLayer } from '../constants/types';

export const LAYER_PAGE_SIZE: Record<MemoryLayer, number> = { L0: 20, L1: 20, L2: 50, L3: 50 };
export function layerPageSize(layer: MemoryLayer): number {
  return LAYER_PAGE_SIZE[layer];
}

/** Detail page time filter range; start / end are ISO8601 strings */
export interface TimeRange {
  start: string;
  end: string;
}

/** Default detail page time filter range: now ~ previous day */
export function defaultTimeRange(): TimeRange {
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Business error returned when the backend detects "filter range too large, VDB cannot support it" */
export function isRangeTooLargeError(e: unknown): boolean {
  return e instanceof ApiError && e.message === 'RANGE_TOO_LARGE';
}

export function mapLayerItem(i: ChatMemoryLayerItem) {
  return {
    id: i.id,
    title: i.title,
    body: i.body,
    refs: i.refs,
    tags: i.tags,
    created_at: i.created_at,
  };
}

/**
 * Strip the META header from scenario (L2) markdown.
 * The body returned by scenario/read carries a `-----META-START-----...-----META-END-----`
 * system field header; the edit box shows only the plain body, and on write-back the backend rebuilds it automatically with the existing META.
 */
export function stripScenarioMeta(content: string): string {
  return content
    .replace(/^-----META-START-----\n[\s\S]*?\n-----META-END-----\n?/, '')
    .replace(/^\n+/, '');
}

// Build the initial layerCounts from the list endpoint's layer_counts: keep only real counts >0,
// leaving the rest undefined = "unknown". Badges show a placeholder accordingly, avoiding showing "not loaded" as "0",
// and no longer prefetching just to get counts. Once the backend layer_counts carries real values, they are adopted here automatically.
export function buildInitialLayerCounts(lc: {
  L0_messages: number;
  L1: number;
  L2: number;
  L3: number;
}): MemoryBlock['layerCounts'] {
  const out: MemoryBlock['layerCounts'] = {};
  if (lc.L0_messages > 0) out.L0 = lc.L0_messages;
  if (lc.L1 > 0) out.L1 = lc.L1;
  if (lc.L2 > 0) out.L2 = lc.L2;
  if (lc.L3 > 0) out.L3 = lc.L3;
  return out;
}

/**
 * Copy text to the clipboard; returns whether it succeeded.
 *
 * navigator.clipboard is available only in secure contexts (HTTPS / localhost); if the panel is accessed via
 * http:// + an intranet IP, navigator.clipboard is undefined and copying fails.
 * So the Clipboard API is preferred, and when unavailable it degrades to the document.execCommand('copy')
 * temporary textarea approach, compatible with non-secure contexts.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Preferred: Clipboard API in a secure context
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the execCommand fallback below
    }
  }
  // Fallback: in a non-secure context (http + IP) use execCommand
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    // Move off-screen to avoid scrolling and focus jumping
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}
