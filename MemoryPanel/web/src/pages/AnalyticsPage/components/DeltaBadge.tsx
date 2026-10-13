/**
 * DeltaBadge -- period-over-period delta badge.
 *
 * Positive up arrow (success color) / negative down arrow (error color) / flat approx (secondary color).
 * Threshold 0.005: changes below this are treated as flat, so CH round(...,2) rounding residue isn't rendered as a "change".
 */

const FLAT_THRESHOLD = 0.005;

export function DeltaBadge({
  value,
  unit,
}: {
  value: number | null | undefined;
  unit: string;
}) {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  const up = value > FLAT_THRESHOLD;
  const down = value < -FLAT_THRESHOLD;
  const cls = up ? '_an-delta--up' : down ? '_an-delta--down' : '_an-delta--flat';
  const sign = up ? '↑' : down ? '↓' : '≈';
  const magnitude = up || down ? Math.abs(value).toFixed(2) : '0';

  return (
    <span className={`_an-delta ${cls}`}>
      {`${sign} ${magnitude}${unit}`}
    </span>
  );
}
