/**
 * Observability page number formatting -- shared by the page and display components.
 *
 * '—' uniformly means "no data", consistent with other Panel pages;
 * non-finite numbers (NaN / Infinity) are also treated as no data, so abnormal CH values are not shown directly to users.
 */

const PLACEHOLDER = '—';

function isBlank(v: number | null | undefined): boolean {
  return v === null || v === undefined || !Number.isFinite(v);
}

/** Integer (thousands separators). */
export function fmtInt(v: number | null | undefined): string {
  return isBlank(v) ? PLACEHOLDER : Math.round(v as number).toLocaleString();
}

/** Percentage value (without the % sign; MetricsBoard's unit carries the unit). */
export function fmtPctValue(v: number | null | undefined): string {
  return isBlank(v) ? PLACEHOLDER : (v as number).toFixed(2);
}

/** Percentage (with the % sign), for inline display in tables / bar charts, etc. */
export function fmtPct(v: number | null | undefined): string {
  return isBlank(v) ? PLACEHOLDER : `${(v as number).toFixed(2)}%`;
}

/** Decimal (2 places by default). */
export function fmtNum(v: number | null | undefined, digits = 2): string {
  return isBlank(v) ? PLACEHOLDER : (v as number).toFixed(digits);
}

/** `YYYY-MM-DD` -> `MM-DD` (for trend chart axis labels, saving horizontal space). */
export function fmtShortDay(day: string): string {
  const m = /^\d{4}-(\d{2}-\d{2})$/.exec(day);
  return m ? m[1] : day;
}

/**
 * Compact display of large numbers (token counts often reach tens of millions; full thousands separators would overflow the card).
 * 1234 → 1.2K；48000000 → 48.0M；1.2e9 → 1.2B
 */
export function fmtCompact(v: number | null | undefined): string {
  if (isBlank(v)) return PLACEHOLDER;
  const n = v as number;
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return Math.round(n).toLocaleString();
}

/** credit amount: keep 2 decimal places and add thousands separators. */
export function fmtCredit(v: number | null | undefined): string {
  if (isBlank(v)) return PLACEHOLDER;
  return (v as number).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export { PLACEHOLDER };
