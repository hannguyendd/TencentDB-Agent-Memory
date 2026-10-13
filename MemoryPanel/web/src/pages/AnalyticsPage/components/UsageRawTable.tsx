/**
 * UsageRawTable -- raw usage archive (usage_raw).
 *
 * Warning: semantic tiers (do not treat the whole table as an "anomaly table"):
 * The write side `MemoryProxy/src/clickhouse.ts:getRawUsageReason()` defines the 5 reasons
 * as different in nature --
 *   - `non_tokenhub`  : the upstream URL does not contain tokenhub, i.e. the request **does not go through the TokenHub billing channel**,
 *                       and is archived as-is for traceability. This is a **normal state**, usually comparable in volume to total requests.
 *   - the other 4     : real problems inside the TokenHub channel (model missing from the price table / missing fields /
 *                       abnormal credit / report failure), which cause billing gaps and **need handling**.
 *
 * Therefore: the reason column is colored by nature (non_tokenhub neutral, the rest danger), and a tiered
 * breakdown is shown at the top, to avoid displaying "13,179 normal archives + 10 real anomalies" as "13,189 anomalies".
 */
import { useTranslation } from 'react-i18next';
import { Button, Card, Justify, Select, Table, Text } from 'tea-component';
import {
  USAGE_RAW_REASONS,
  type UsageRawReason,
  type UsageRawRow,
} from '@/lib/api/analytics';
import type { ReasonCounts } from '../hooks/useUsageStats';
import { DetailPager } from './DetailPager';
import { UserName } from './UserName';
import { fmtInt } from '../utils/formatters';

const { autotip, expandable } = Table.addons;
const ALL_REASONS = '__ALL__';

/** Reasons that need manual handling (non_tokenhub is a normal archive and is not listed here). */
const ACTIONABLE_REASONS: readonly UsageRawReason[] = [
  'unknown_model',
  'invalid_format',
  'invalid_credit',
  'report_failed',
];

function isActionable(reason: string): boolean {
  return (ACTIONABLE_REASONS as readonly string[]).includes(reason);
}

export function UsageRawTable({
  rows,
  total,
  offset,
  limit,
  reason,
  reasonCounts,
  loading,
  expandedKeys,
  resolveUserName,
  onExpandedKeysChange,
  onReasonChange,
  onOffsetChange,
  onDrillMember,
}: {
  rows: UsageRawRow[];
  total: number;
  offset: number;
  limit: number;
  reason: UsageRawReason | '';
  reasonCounts: ReasonCounts;
  loading: boolean;
  expandedKeys: string[];
  resolveUserName: (id: string) => string;
  onExpandedKeysChange: (keys: string[]) => void;
  onReasonChange: (reason: UsageRawReason | '') => void;
  onOffsetChange: (offset: number) => void;
  onDrillMember: (userId: string) => void;
}) {
  const { t } = useTranslation();

  const actionableTotal = ACTIONABLE_REASONS.reduce((sum, r) => sum + (reasonCounts[r] ?? 0), 0);
  const passthroughTotal = reasonCounts.non_tokenhub ?? 0;

  const recordKey = (r: UsageRawRow) => `${r.timestamp}:${r.session_key}:${r.model_id}:${r.reason}`;

  const columns = [
    {
      key: 'timestamp',
      header: t('analytics.usage.raw.col.time'),
      width: 170,
      render: (r: UsageRawRow) => (
        <Text className="_an-mono" overflow>
          {r.timestamp}
        </Text>
      ),
    },
    {
      key: 'reason',
      header: t('analytics.usage.raw.col.reason'),
      width: 150,
      render: (r: UsageRawRow) => {
        if (!r.reason) return '—';
        const label = t(`analytics.usage.reason.${r.reason}`, { defaultValue: r.reason });
        // Only real problems use danger; non_tokenhub is a normal-channel marker and uses the secondary color
        return isActionable(r.reason) ? (
          <Text theme="danger" overflow>
            {label}
          </Text>
        ) : (
          <Text theme="label" overflow>
            {label}
          </Text>
        );
      },
    },
    {
      key: 'model_id',
      header: t('analytics.usage.raw.col.model'),
      width: 170,
      render: (r: UsageRawRow) => (
        <Text className="_an-mono" overflow>
          {r.model_id || '—'}
        </Text>
      ),
    },
    {
      key: 'user_id',
      header: t('analytics.usage.raw.col.user'),
      width: 150,
      render: (r: UsageRawRow) =>
        r.user_id ? (
          <Button
            type="link"
            className="_an-user-link"
            tooltip={r.user_id}
            onClick={() => onDrillMember(r.user_id)}
          >
            <UserName userId={r.user_id} displayName={resolveUserName(r.user_id)} />
          </Button>
        ) : (
          '—'
        ),
    },
    {
      key: 'key_id',
      header: t('analytics.usage.raw.col.key'),
      width: 130,
      render: (r: UsageRawRow) => (
        <Text className="_an-mono" overflow>
          {r.key_id || '—'}
        </Text>
      ),
    },
    {
      key: 'space_id',
      header: t('analytics.usage.raw.col.space'),
      width: 120,
      render: (r: UsageRawRow) => r.space_id || '—',
    },
  ];

  return (
    <Card bordered>
      <Card.Body
        title={t('analytics.usage.section.raw')}
        subtitle={t('analytics.usage.section.rawSub')}
      >
        <div className="_an-raw-summary">
          <span className="_an-raw-stat">
            <Text theme={actionableTotal > 0 ? 'danger' : 'success'} className="_an-raw-stat-value">
              {fmtInt(actionableTotal)}
            </Text>
            <Text theme="label">{t('analytics.usage.raw.actionable')}</Text>
          </span>
          <span className="_an-raw-stat">
            <Text className="_an-raw-stat-value">{fmtInt(passthroughTotal)}</Text>
            <Text theme="label">{t('analytics.usage.raw.passthrough')}</Text>
          </span>
          {actionableTotal > 0 && (
            <Text theme="label" className="_an-raw-breakdown">
              {ACTIONABLE_REASONS.filter((r) => (reasonCounts[r] ?? 0) > 0)
                .map(
                  (r) =>
                    `${t(`analytics.usage.reason.${r}`, { defaultValue: r })} ${fmtInt(reasonCounts[r])}`,
                )
                .join(' · ')}
            </Text>
          )}
        </div>

        <Table.ActionPanel>
          <Justify
            left={
              <Select
                className="_an-toolbar-select"
                appearance="button"
                value={reason || ALL_REASONS}
                onChange={(v) => onReasonChange(v === ALL_REASONS ? '' : (v as UsageRawReason))}
                options={[
                  { value: ALL_REASONS, text: t('analytics.usage.raw.allReasons') },
                  ...USAGE_RAW_REASONS.map((r) => ({
                    value: r,
                    text: `${t(`analytics.usage.reason.${r}`, { defaultValue: r })}（${fmtInt(reasonCounts[r] ?? 0)}）`,
                  })),
                ]}
                listWidth={260}
              />
            }
          />
        </Table.ActionPanel>

        <Table
          records={rows}
          recordKey={recordKey}
          columns={columns}
          verticalTop
          bordered
          addons={[
            expandable({
              expandedKeys,
              onExpandedKeysChange,
              render: (r: UsageRawRow) => (
                <pre className="_an-trace-body">{r.usage || t('analytics.usage.raw.emptyPayload')}</pre>
              ),
            }),
            autotip({ isLoading: loading, emptyText: t('analytics.usage.empty.raw') }),
          ]}
        />

        <DetailPager
          total={total}
          offset={offset}
          limit={limit}
          count={rows.length}
          loading={loading}
          onOffsetChange={onOffsetChange}
        />
      </Card.Body>
    </Card>
  );
}
