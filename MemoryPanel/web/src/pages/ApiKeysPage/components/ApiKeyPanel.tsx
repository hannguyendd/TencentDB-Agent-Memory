/**
 * ApiKeyPanel -- User_Key management (organization and permission group).
 *
 * Slimmed-down version: the list shows only 4 core fields -- key_id / user_id / key_prefix / created time,
 * and no longer shows the "Name" and "Expiry" columns (correspondingly, the create dialog no longer asks for a name).
 * Tea components: the list uses Table + autotip, the header uses Justify + H3,
 * destructive actions all go through Modal.confirm for a second confirmation, and the create dialog reuses the site-wide Modal shell.
 *
 * Backend path: the new panel (stateless) goes through the meta action `user-key/list|create|revoke`,
 * transparently proxied by Control to the kernel /v3/meta. The frontend does not call the kernel directly, nor use the old REST paths.
 * The owner is inferred from the logged-in user_key; the frontend neither uses nor can pass another user's user_id --
 * naturally satisfying "users can only see / manage their own keys".
 *
 * Security design (existing kernel behavior, not a trade-off of this component):
 *   - the plaintext key appears only once, in the `create` response, and is never returned again by list/get;
 *   - `key_prefix` is a displayable prefix provided by the kernel (e.g. `sk-mem-ab12****`), used to identify
 *     which key it is without the secret; it is not the plaintext;
 *   - therefore an existing key in the list cannot be "expanded to show the full key", it can only be revoked.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Moment } from 'moment';
import moment from 'moment';
import {
  Table,
  Card,
  Button,
  Alert,
  Copy,
  Text,
  DatePicker,
  Justify,
  H3,
  Form,
  Modal,
} from 'tea-component';
import { AddIcon } from 'tea-icons-react';
import { userKeysApi, metaInstancesApi, type UserKey } from '@/lib/teamApi';
import { useCurrentRole } from '@/services/useCurrentRole';
import { useAuthStore } from '@/stores/auth';
import { tea } from '@/lib/tea-bridge';
import '../styles/api-key-panel.css';

const { autotip } = Table.addons;

export default function ApiKeyPanel() {
  const { t } = useTranslation();
  const role = useCurrentRole();
  const { auth } = useAuthStore();
  const [keys, setKeys] = useState<UserKey[]>([]);
  const [loading, setLoading] = useState(true);
  // Client access base address (from the currently logged-in instance's metadata; differs per instance).
  // Prefer proxy_endpoint -- in open-source local deployments where core+proxy are separate, clients should connect to the proxy;
  // when not configured, fall back to gateway_endpoint, same as the old behavior (online, the gateway fronts the proxy and the two are merged).
  const [clientBaseUrl, setClientBaseUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!auth?.instance_id) {
      setClientBaseUrl(null);
      return;
    }
    void metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        const hit = list.find((i) => i.instance_id === auth.instance_id);
        setClientBaseUrl(hit?.proxy_endpoint ?? hit?.gateway_endpoint ?? null);
      })
      .catch(() => {
        if (!cancelled) setClientBaseUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [auth?.instance_id]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await userKeysApi.list();
      // Sort by creation time descending (the kernel does not necessarily guarantee order)
      list.sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
      // Revoked keys are no longer shown
      setKeys(list.filter((k) => !k.revoked_at));
    } catch (e) {
      tea.notify.error(e);
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ---- Create dialog ----
  // No longer collects a "name" -- the list doesn't show a name column either, so there's no need to ask the user for one on creation.
  const [showCreate, setShowCreate] = useState(false);
  const [newExpiresAt, setNewExpiresAt] = useState<Moment | null>(null);
  const [creating, setCreating] = useState(false);
  // The just-created key (contains the full plaintext, shown only once)
  const [freshKey, setFreshKey] = useState<{ keyId: string; secret: string } | null>(null);

  async function handleCreate() {
    setCreating(true);
    try {
      const key = await userKeysApi.create({
        expires_at: newExpiresAt ? newExpiresAt.endOf('day').toISOString() : undefined,
      });
      setNewExpiresAt(null);
      setShowCreate(false);
      if (key.key_value) {
        setFreshKey({ keyId: key.key_id, secret: key.key_value });
      }
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(key: UserKey) {
    const ok = await tea.confirm({
      message: t('apiKey.confirm.revoke', { name: key.key_prefix || key.key_id }),
      description: t('apiKey.confirm.revoke.desc'),
      okText: t('apiKey.confirm.revoke.ok'),
    });
    if (!ok) return;
    try {
      await userKeysApi.revoke(key.key_id);
      await refresh();
    } catch (e) {
      tea.notify.error(e);
    }
  }

  const formatTime = (iso?: string) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  return (
    <div className="_memory-apikey-body">
      {/* ===== Just-created Key notice (shown only once) ===== */}
      {freshKey && (
        <Alert type="success" onClose={() => setFreshKey(null)}>
          <div className="_memory-apikey-fresh">
            <p className="_memory-apikey-fresh-desc">
              {t('apiKey.fresh.desc', { keyId: freshKey.keyId })}
            </p>
            <div className="_memory-apikey-fresh-code-row">
              <code className="_memory-apikey-fresh-code">{freshKey.secret}</code>
              <Copy
                text={freshKey.secret}
                onCopy={() => {
                  // After a successful copy, automatically hide the full Key display, so the plaintext doesn't stay on screen for long
                  setFreshKey(null);
                }}
              />
            </div>
          </div>
        </Alert>
      )}

      {/* ===== Page header (Justify left/right layout) ===== */}
      <Justify
        left={
          <div>
            <H3>{t('apiKey.title')}</H3>
            <Text theme="text" parent="div" style={{ marginTop: 4 }}>
              {t('apiKey.desc')}
            </Text>
          </div>
        }
        right={
          role !== 'admin' ? (
            <Button
              type="primary"
              onClick={() => {
                setShowCreate(true);
                setNewExpiresAt(null);
              }}
              data-guide="create-key"
            >
              <AddIcon size={14} />
              {t('apiKey.create')}
            </Button>
          ) : null
        }
      />

      {/* ===== Key list: key_id / key_prefix / created time + actions ===== */}
      <Card>
        <Table
          verticalTop
          records={keys}
          recordKey="key_id"
          columns={[
            {
              key: 'key_id',
              header: t('apiKey.table.keyId'),
              render: (key) => (
                <Text
                  parent="code"
                  copyable
                  style={{
                    fontSize: 12,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 2,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key.key_id}
                </Text>
              ),
            },
            {
              key: 'key_prefix',
              header: t('apiKey.table.keyPrefix'),
              render: (key) => (
                <Text parent="code" style={{ fontSize: 12 }}>
                  {key.key_prefix || '—'}
                </Text>
              ),
            },
            {
              key: 'created_at',
              header: t('apiKey.table.createdAt'),
              width: 180,
              render: (key) => <Text theme="text">{formatTime(key.created_at)}</Text>,
            },
            {
              key: 'expires_at',
              header: t('apiKey.table.expiresAt'),
              width: 180,
              render: (key) => {
                if (key.revoked_at) return <Text theme="weak">{t('apiKey.revoked')}</Text>;
                return key.expires_at ? (
                  <Text theme="text">{formatTime(key.expires_at)}</Text>
                ) : (
                  <Text theme="weak">{t('apiKey.neverExpire')}</Text>
                );
              },
            },
            {
              key: 'actions',
              header: t('apiKey.table.actions'),
              width: 100,
              align: 'right',
              render: (key) => (
                <Button
                  type="text"
                  disabled={!!key.revoked_at}
                  onClick={() => void handleDelete(key)}
                >
                  {t('apiKey.revoke')}
                </Button>
              ),
            },
          ]}
          addons={[
            autotip({
              isLoading: loading,
              emptyText: (
                <div className="_memory-apikey-empty">
                  <div className="_memory-apikey-empty-title">{t('apiKey.empty.title')}</div>
                  <div className="_memory-apikey-empty-desc">{t('apiKey.empty.desc')}</div>
                </div>
              ),
              onRetry: () => void refresh(),
            }),
          ]}
        />
      </Card>

      {/* ===== Access guide ===== */}
      {/*
        instance-id is injected from the current login state (auth.instance_id) -- users no longer have to manually replace the
        [instance-id] placeholder, or look elsewhere for which instance they are connected to.
        In theory an unauthenticated user never reaches this page (LoginGate blocks it), but a placeholder fallback is kept as a safeguard.
      */}
      <Card>
        <Card.Body title={t('apiKey.endpoint.title')}>
          {auth?.instance_name && (
            <div
              style={{ marginBottom: 8, fontSize: 11, color: 'var(--tea-color-text-secondary)' }}
            >
              {t('apiKey.endpoint.current')}
              <code>{auth.instance_name}</code>
              <span style={{ opacity: 0.6, marginLeft: 6 }}>({auth.instance_id})</span>
            </div>
          )}
          <div className="_memory-apikey-endpoints">
            {(() => {
              // While base is not yet fetched show loading; prevents users from copying a hard-coded URL by mistake
              if (!clientBaseUrl) {
                return (
                  <Text theme="weak" style={{ fontSize: 11 }}>
                    {t('apiKey.endpoint.loading')}
                  </Text>
                );
              }
              // Strip the trailing slash so base + /path doesn't become a double slash (! bypasses closure narrowing)
              const base = clientBaseUrl!.replace(/\/+$/, '');
              const iid = auth?.instance_id ?? '[instance-id]';
              const endpoints: Array<{ label: string; url: string }> = [
                { label: 'CodeBuddy', url: `${base}/codebuddy/${iid}` },
                { label: 'Claude Code', url: `${base}/claude-code/${iid}` },
                // WorkBuddy uses /workbuddy/<spaceId> (spaceId=instance_id, symmetric with codebuddy).
                // The web version is built on OpenAI ChatCompletions and the desktop version on the Responses API; the proxy handles both.
                { label: 'WorkBuddy', url: `${base}/workbuddy/${iid}` },
                // codex uses the OpenAI Responses API (POST /v1/responses); the proxy side
                // registers both v1/ and no-v1 paths, and by convention the base without /v1 is used; in the client
                // config.toml just put this address in base_url, with wire_api="responses".
                { label: 'Codex', url: `${base}/codex/${iid}` },
                // dsh (deepseek-harness) -- DeepSeek's official agent harness; Web UI sessions
                // use OpenAI Chat Completions. **The tail has no /v1** -- the dsh client
                // hardcodes ${baseURL}/chat/completions, same family as CB; the proxy-side
                // route /dsh/{spaceId}/chat/completions is aligned. The baseURL the user enters
                // is exactly the address here; do not append /v1 to it.
                { label: 'DeepSeek Harness (dsh)', url: `${base}/dsh/${iid}` },
                // OpenCode -- sst/opencode general-purpose terminal AI coding Agent, protocol = standard
                // OpenAI Chat Completions (POST /v1/chat/completions), same family as CB/dsh.
                // The proxy-side agent-adapters/opencode.ts already handles form backfill + the full mem: command family.
                { label: 'OpenCode', url: `${base}/opencode/${iid}` },
                { label: 'OpenClaw', url: `${base}/openclaw/${iid}` },
                { label: 'Hermes', url: `${base}/hermes/${iid}` },
              ];
              return endpoints.map((ep) => (
                <div className="_memory-apikey-endpoint" key={ep.label}>
                  <Text theme="label" parent="div" style={{ marginBottom: 4 }}>
                    {ep.label}
                  </Text>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <code
                      style={{
                        flex: 1,
                        fontSize: 11,
                        wordBreak: 'break-all',
                        background: 'var(--tea-color-bg-secondary-default)',
                        padding: '4px 8px',
                        borderRadius: 4,
                      }}
                    >
                      {ep.url}
                    </code>
                    <Copy text={ep.url}>
                      <Button>{t('apiKey.endpoint.copy')}</Button>
                    </Copy>
                  </div>
                </div>
              ));
            })()}
          </div>
        </Card.Body>
      </Card>
      {/* ===== Create dialog: only "Expiry" needs to be set (blank = never expires), no name needed ===== */}
      {showCreate && (
        <Modal
          visible
          caption={t('apiKey.create.caption')}
          size="s"
          onClose={() => setShowCreate(false)}
          disableEscape={creating}
        >
          <Modal.Body>
            <Form>
              <Form.Item
                label={t('apiKey.create.expiresAt')}
                extra={t('apiKey.create.expiresAt.extra')}
              >
                <DatePicker
                  value={newExpiresAt ?? undefined}
                  onChange={(v) => setNewExpiresAt(v)}
                  disabledDate={(d) => !d.isBefore(moment().startOf('day'))}
                  placeholder={t('apiKey.create.expiresAt.placeholder')}
                />
              </Form.Item>
            </Form>
          </Modal.Body>
          <Modal.Footer>
            <Button
              type="primary"
              onClick={() => void handleCreate()}
              disabled={creating}
              loading={creating}
            >
              {t('apiKey.create.submit')}
            </Button>
            <Button onClick={() => setShowCreate(false)} disabled={creating}>
              {t('apiKey.create.cancel')}
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  );
}
