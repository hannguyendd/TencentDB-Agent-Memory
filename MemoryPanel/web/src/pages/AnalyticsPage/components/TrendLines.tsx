/**
 * TrendLines -- multi-line trend chart (lightweight SVG implementation with zero chart dependencies).
 *
 * Normalized to a viewBox of 100xH, then stretched horizontally to fill the container with preserveAspectRatio="none".
 *
 * Two implementation constraints that must be kept (read fully before changing):
 *
 * 1. **Data point markers must be rendered; drawing only a polyline is not enough.**
 *    Time series are aggregated by calendar day, and `days=1` usually returns only 1-2 rows; a single-point `<polyline>`
 *    has no segment and produces no visible shape -- drawing only the line would leave the "last 1 day" chart completely blank
 *    (KPIs have values but the trend chart shows nothing). Point markers are the only visible element in that scenario.
 *
 * 2. **Point markers use "zero-length line + round linecap + non-scaling-stroke", not `<circle>`.**
 *    preserveAspectRatio="none" stretches the viewBox's 100 horizontal units to the container's actual width
 *    (often 8x or more), which squashes a `<circle>` into a flat ellipse. Stroke width is unaffected by geometric transforms,
 *    and a zero-length subpath with a round cap renders as a perfect circle per the SVG spec, the only stable way to draw points when stretched.
 */
import { StatusTip, Text } from 'tea-component';
import { fmtInt, fmtShortDay } from '../utils/formatters';

const VIEW_HEIGHT = 180;
const PAD_TOP = 8;
const PAD_BOTTOM = 16;
/** Point marker diameter (px; does not scale with the container under non-scaling-stroke). */
const DOT_SIZE = 5;
/** Above this point count, point markers are no longer drawn, otherwise dense points blur together (90-day window). */
const MAX_DOTS = 31;
/** At or below this point count the X axis labels every point's date; otherwise only the first and last. */
const MAX_FULL_AXIS = 3;

export interface TrendLineConfig<T> {
  key: keyof T & string;
  label: string;
  color: string;
}

export function TrendLines<T extends { day: string }>({
  rows,
  lines,
  emptyText,
  maxLabel,
  singlePointHint,
}: {
  rows: T[];
  lines: Array<TrendLineConfig<T>>;
  emptyText: string;
  /** Peak description text (passed in by the page via i18n; no hard-coded text in the component). */
  maxLabel: (max: string) => string;
  /** Description text when there is only 1 data point (no trend comparison possible). */
  singlePointHint: string;
}) {
  if (rows.length === 0) {
    return <StatusTip status="empty" emptyText={emptyText} />;
  }

  const valueAt = (row: T, key: keyof T & string): number => {
    const v = Number(row[key]);
    return Number.isFinite(v) ? v : 0;
  };

  const max = Math.max(1, ...rows.flatMap((r) => lines.map((l) => valueAt(r, l.key))));
  const n = rows.length;
  // With a single point, center it (hugging the left edge gets clipped by the Y axis and looks like a render failure)
  const xAt = (i: number): number => (n === 1 ? 50 : (i / (n - 1)) * 100);
  const yAt = (v: number): number => PAD_TOP + (1 - v / max) * (VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM);

  const showDots = n <= MAX_DOTS;
  const axisDays =
    n <= MAX_FULL_AXIS ? rows.map((r) => fmtShortDay(r.day)) : [fmtShortDay(rows[0].day), fmtShortDay(rows[n - 1].day)];

  return (
    <div className="_an-trend">
      <svg
        viewBox={`0 0 100 ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        className="_an-trend-svg"
      >
        {lines.map((l) => (
          <g key={l.key}>
            {n > 1 && (
              <polyline
                fill="none"
                stroke={l.color}
                strokeWidth="0.6"
                vectorEffect="non-scaling-stroke"
                points={rows
                  .map((r, i) => `${xAt(i).toFixed(2)},${yAt(valueAt(r, l.key)).toFixed(2)}`)
                  .join(' ')}
              >
                <title>{l.label}</title>
              </polyline>
            )}
            {showDots &&
              rows.map((r, i) => {
                const v = valueAt(r, l.key);
                const x = xAt(i).toFixed(2);
                const y = yAt(v).toFixed(2);
                return (
                  <line
                    key={`${l.key}-${r.day}-${i}`}
                    x1={x}
                    y1={y}
                    x2={x}
                    y2={y}
                    stroke={l.color}
                    strokeWidth={DOT_SIZE}
                    strokeLinecap="round"
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{`${r.day} · ${l.label}: ${fmtInt(v)}`}</title>
                  </line>
                );
              })}
          </g>
        ))}
      </svg>

      <div className={`_an-trend-axis${n === 1 ? ' _an-trend-axis--single' : ''}`}>
        {axisDays.map((day, i) => (
          <span key={`${day}-${i}`}>{day}</span>
        ))}
      </div>

      <div className="_an-trend-legend">
        {lines.map((l) => (
          <span className="_an-trend-legend-item" key={l.key}>
            <i style={{ background: l.color }} />
            {l.label}
          </span>
        ))}
        <span className="_an-trend-max">{maxLabel(fmtInt(max))}</span>
      </div>

      {n === 1 && (
        <Text theme="label" className="_an-trend-hint">
          {singlePointHint}
        </Text>
      )}
    </div>
  );
}
