/**
 * DetailPager -- generic "Previous / Next + range" pager for detail tables.
 *
 * Shared by the trace / usage / usage_raw detail tables to avoid repeating offset boundary checks.
 * All kernel list endpoints return { total, offset, limit, items }, so only offset semantics are needed here.
 */
import { useTranslation } from 'react-i18next';
import { Button, Text } from 'tea-component';
import { fmtInt } from '../utils/formatters';

export function DetailPager({
  total,
  offset,
  limit,
  count,
  loading,
  onOffsetChange,
}: {
  total: number;
  offset: number;
  limit: number;
  /** Actual row count of the current page (the last page may have fewer than limit). */
  count: number;
  loading: boolean;
  onOffsetChange: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + count;

  return (
    <div className="_an-pager">
      <Button
        type="weak"
        disabled={offset <= 0 || loading}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        {t('analytics.trace.prev')}
      </Button>
      <Button
        type="weak"
        disabled={offset + limit >= total || loading}
        onClick={() => onOffsetChange(offset + limit)}
      >
        {t('analytics.trace.next')}
      </Button>
      <Text theme="label">
        {t('analytics.trace.range', { from: fmtInt(from), to: fmtInt(to), total: fmtInt(total) })}
      </Text>
    </div>
  );
}
