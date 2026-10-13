/**
 * ShareBar -- horizontal share bar (zero chart dependencies).
 *
 * Generic + accessor functions: the caller explicitly provides how to read label / value, so a wrong field name is a
 * compile-time error (previously a `valueKey: string` magic string was used, where a wrong field name silently showed 0).
 */
import { StatusTip } from 'tea-component';
import { fmtInt, fmtPct } from '../utils/formatters';

export interface ShareBarRow {
  /** Share (0-100), given by the kernel SQL round(...,2). */
  pct: number;
}

export function ShareBar<T extends ShareBarRow>({
  rows,
  labelOf,
  valueOf,
  emptyText,
}: {
  rows: T[];
  labelOf: (row: T) => string;
  valueOf: (row: T) => number;
  emptyText: string;
}) {
  if (rows.length === 0) {
    return <StatusTip status="empty" emptyText={emptyText} />;
  }

  // Use the largest share as the full-bar baseline: relative differences stay visible even when a single share is low.
  const max = Math.max(...rows.map((r) => r.pct || 0), 1);

  return (
    <div className="_an-sharebar">
      {rows.map((row, index) => {
        const label = labelOf(row);
        const pct = row.pct || 0;
        return (
          // label may be an empty string (the dimension is empty in CH), so combine it with index to form a stable key
          <div className="_an-sharebar-row" key={`${label}#${index}`}>
            <span className="_an-sharebar-label" title={label}>
              {label}
            </span>
            <div className="_an-sharebar-track">
              <div className="_an-sharebar-fill" style={{ width: `${(pct / max) * 100}%` }} />
            </div>
            <span className="_an-sharebar-value">
              {fmtPct(pct)} <em>({fmtInt(valueOf(row))})</em>
            </span>
          </div>
        );
      })}
    </div>
  );
}
