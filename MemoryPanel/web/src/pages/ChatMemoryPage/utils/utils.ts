import type { MemoryBlock, MemoryLayer } from '../constants/types';
import i18n from '@/i18n';

/**
 * ISO time string -> panel display format (local time zone, 'YYYY-MM-DD HH:MM').
 * Invalid or empty input -> returns an empty string; the caller short-circuits (`t && <span>...</span>`) to skip display.
 */
export function formatDisplayTime(iso: string | undefined | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Compact time: today HH:MM, yesterday "Yesterday", earlier MM-DD. */
export function formatShortTime(ms: number): string {
  const now = new Date();
  const d = new Date(ms);
  const sameDay =
    now.getFullYear() === d.getFullYear() && now.getMonth() === d.getMonth() && now.getDate() === d.getDate();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (
    yesterday.getFullYear() === d.getFullYear() &&
    yesterday.getMonth() === d.getMonth() &&
    yesterday.getDate() === d.getDate()
  ) return i18n.t('common.yesterday');
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Extract the L0 role from the backend's explicit role field; only for legacy data fall back to parsing the title's @ prefix. */
export function extractRole(roleOrTitle: string): string {
  const raw = roleOrTitle.split('@')[0]?.trim().toLowerCase() || '';
  if (raw === 'user') return 'user';
  if (raw === 'assistant') return 'assistant';
  if (raw === 'system') return 'system';
  if (raw === 'tool') return 'tool';
  return raw || 'message';
}

/** Display count of a layer: prefer layerCounts, fall back to a local estimate. */
export function getLayerCount(block: MemoryBlock, l: MemoryLayer): number {
  const real = block.layerCounts[l];
  if (real !== undefined) return real;
  return l === 'L0' ? block.layers.L0.length : block.layers[l].length;
}
