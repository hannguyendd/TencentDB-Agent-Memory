/**
 * LoginGate — Login page shown before entering the app (backed by the new panel Control, see design doc 09 §3.3).
 *
 * Login flow (no cookies, no OAuth, dual-credential header auth):
 *   1. GET /api/v1/meta/instances              → pick a memory instance
 *   2. User enters their own user_key (sk-mem-…)
 *   3. POST /api/v1/meta/auth/verify (header carries only X-Tdai-Service-Id; body carries user_key)
 *      → data.valid === true login succeeds; data.user is written to the session
 *   4. The frontend caches { instance_id, user_key, user } in localStorage (see lib/panelSession.ts),
 *      and every subsequent meta request reads from there to inject both headers Header
 *
 * Design: single-column centered, bright minimalist style — full-screen dot-matrix wave background (ParticleWaveBackground,
 * pure Canvas, zero dependencies, visually inspired by React Bits' Particles / DotGrid) + a centered frosted-glass card,
 * The card contains a "pick instance + enter user_key" form.
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Select } from 'tea-component';
import { getErrorMessage } from '@/lib/error-message';
import {
  authMethodsApi,
  authVerifyApi,
  metaInstancesApi,
  type AuthMethod,
  type MetadataInstance,
  type PublicUser,
} from '@/lib/teamApi';
import { getPanelSession, setPanelSession, clearPanelSession } from '@/lib/panelSession';
import ParticleWaveBackground from './ParticleWaveBackground';
import './login-gate.css';

export interface AuthState {
  /** Display username (display_name || username); keeps the old field name for downstream component compatibility */
  user: string;
  /** Backend ULID — the real key for all ownership checks (owner_user_id / creator_user_id / team_members.user_id) key */
  user_id: string;
  instance_id: string;
  instance_name: string;
  loggedInAt: number;
  /**
   * Whether the user is a global admin — from the auth/verify response data.user.user_type === 'system_admin'.
   * admin admin is a global role, independent of creating/joining any team (manages teams, not resources);
   * only non-admin regular users (user_type !== 'system_admin') need a role lookup in the team.members table.
   */
  isAdmin: boolean;
}

// In-memory cache — real persistence is delegated to localStorage (lib/panelSession.ts, shared across tabs).
// This only provides a synchronous mirror cache for legacy components that read identity via readAuth() with no props (ChatMemoryPanel / WikiSourcesPanel /ChatMemoryPanel / WikiSourcesPanel /
// CodeSourcesPanel etc.).
let _authCache: AuthState | null = null;

export function readAuth(): AuthState | null {
  return _authCache;
}

/** Logout / 401 fallback: clears both the in-memory mirror cache and the instance_id+user_key in localStorage. */
export function clearAuth(): void {
  _authCache = null;
  clearPanelSession();
}

function writeAuthCache(auth: AuthState): void {
  _authCache = auth;
}

function toAuthState(user: PublicUser, instanceId: string, instanceName: string): AuthState {
  return {
    user: user.display_name || user.username,
    user_id: user.user_id,
    instance_id: instanceId,
    instance_name: instanceName,
    loggedInAt: Date.now(),
    isAdmin: user.user_type === 'system_admin',
  };
}

/**
 * Try to restore the login state from the { instance_id, user_key, user } cached in localStorage.
 * The new panel has no cookies; the frontend holds the credentials itself. But the cache is persistent (shared across tabs, survives closing tabs),
 * so trusting only the local cache would still report "logged in" after the instance is deleted / the user_key expires, causing a fake login.
 * Therefore auth/verify must be called against the backend as a liveness check before restoring:
 *   - valid === true  → restore with the latest user returned by the backend (also refreshing user info and the admin flag);
 *   - valid !== true or the request throws (instance deleted / credentials invalid / business error) → clear the cache, return null, go back to the login page.
 * App is called on startup; on success it writes the in-memory mirror cache and returns the result; on failure (not logged in / incomplete cache / liveness check failed) it returns null.
 *
 * Race-condition guard: verify is async, and the local session may be changed by concurrent operations during its RTT window
 * (e.g. another tab logging out and clearing the cache via a storage event, or switching instances). If, after it returns,
 * localStorage in { instanceId, userKey } no longer matches the value at the start, this means this restore's
 * result is stale: discard it without writing the cache, to avoid writing back a login state that has been cleared or replaced.
 */
export async function resumeSession(): Promise<AuthState | null> {
  const session = getPanelSession();
  // Path 1: a local user_key cache exists (legacy login) — restore after a backend liveness check.
  if (session?.user && session.instanceId && session.userKey) {
    try {
      const res = await authVerifyApi.verify(session.instanceId, session.userKey);

      // During the verify RTT, if the local session is concurrently logged out/switched, this result is discarded.
      const latest = getPanelSession();
      if (
        !latest ||
        latest.instanceId !== session.instanceId ||
        latest.userKey !== session.userKey
      ) {
        return null;
      }

      if (!res.valid) {
        // Liveness check failed: instance deleted / user_key invalid, clear the stale login state.
        clearAuth();
        return null;
      }
      // Prefer the latest user just returned by the backend; fall back to the cached user if missing.
      const user = res.user ?? session.user;
      const auth = toAuthState(user, session.instanceId, session.instanceName ?? '');
      writeAuthCache(auth);
      return auth;
    } catch {
      // Request threw (instance missing / backend rejected / network unreachable): treat the login state as invalid, clear the cache and go back to the login page.
      clearAuth();
      return null;
    }
  }

  // Path 2: the IdP (WOA) session uses an HttpOnly cookie and cannot be restored from localStorage;
  // query the backend for the current session. Only taken when the local session is missing / has no userKey (IdP login does not persist userKey).
  try {
    const idp = await authMethodsApi.session();
    if (!idp.authenticated || !idp.instance_id || !idp.user) return null;
    setPanelSession({
      authMethod: 'idp',
      instanceId: idp.instance_id,
      userKey: '',
      user: idp.user,
    });
    const auth = toAuthState(idp.user, idp.instance_id, '');
    writeAuthCache(auth);
    return auth;
  } catch {
    return null;
  }
}

export default function LoginGate({
  onLoggedIn,
}: {
  onLoggedIn: (auth: AuthState) => void;
}) {
  const { t } = useTranslation();
  const [instances, setInstances] = useState<MetadataInstance[]>([]);
  const [authMethods, setAuthMethods] = useState<AuthMethod[]>([]);
  const [instanceId, setInstanceId] = useState('');
  const [userKey, setUserKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [instancesError, setInstancesError] = useState(false);
  const [authMethodsLoaded, setAuthMethodsLoaded] = useState(false);
  const [pendingWoa, setPendingWoa] = useState<{
    instanceId: string;
    displayName?: string;
    loginName?: string;
  } | null>(null);
  const [pendingUsername, setPendingUsername] = useState('');
  // First external-auth login: the user_key provided by the user (required).
  const [pendingUserKey, setPendingUserKey] = useState('');
  // Preview result: null = not previewed; exists=true means the key already belongs to an account in the system (can be bound).
  const [pendingPreview, setPendingPreview] = useState<{
    exists: boolean;
    user_id?: string;
    username?: string;
    display_name?: string;
    user_type?: string;
  } | null>(null);
  const [pendingPreviewing, setPendingPreviewing] = useState(false);
  const [pendingSubmitting, setPendingSubmitting] = useState(false);
  const [dismissingWoa, setDismissingWoa] = useState(false);
  const [resumingWoa, setResumingWoa] = useState(false);
  // After account creation, show the auto-generated user_key once (for the user to copy into the client to connect to the proxy).
  const [createdKey, setCreatedKey] = useState<{ userKey: string; user: PublicUser; instanceId: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const hasUserKeyMethod = authMethods.some((method) => method.type === 'user_key');
  const showWoaLogin = authMethodsLoaded && authMethods.some((method) => method.type === 'woa');
  /**
   * user_key form is always shown directly — there is no "login method selection page" layer.
   *
   * Enabling iOA no longer changes the default page either: the login page is the user_key form, with iOA being just a
   * jump link ("Sign in with iOA") below the form. Each of the two login surfaces embeds a link to the other, one click away.
   */
  const showUserKeyLogin = authMethodsLoaded && hasUserKeyMethod;

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    authMethodsApi.session()
      .then((session) => {
        if (!cancelled && session.pending && session.instance_id) {
          setPendingWoa({
            instanceId: session.instance_id,
            displayName: session.pending_identity?.display_name,
            loginName: session.pending_identity?.login_name,
          });
          setPendingUsername(session.pending_identity?.login_name || '');
          setInstanceId(session.instance_id);
        }
      })
      .catch(() => undefined);
    authMethodsApi.list()
      .then((result) => {
        if (cancelled) return;
        setAuthMethods(result.methods.filter((method) => method.enabled));
        setAuthMethodsLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        // When the config endpoint is unavailable, conservatively fall back to the legacy user_key login to avoid a blank login page.
        setAuthMethods([{ id: 'user_key', type: 'user_key', display_name: 'user_key', enabled: true }]);
        setAuthMethodsLoaded(true);
      });
    metaInstancesApi
      .list()
      .then((list) => {
        if (cancelled) return;
        setInstancesError(false);
        setInstances(list);
        if (list.length > 0) setInstanceId(list[0].instance_id);
      })
      .catch((err) => {
        if (cancelled) return;
        setInstancesError(true);
        setError(t('login.error.loadInstances', { detail: err instanceof Error ? ` (${err.message})` : '' }));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  /** Submit user_key: log in directly after the liveness check passes; an invalid key reports an error (no automatic account creation). */
  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!instanceId) {
      setError(t('login.error.selectInstance'));
      return;
    }
    const key = userKey.trim();
    if (!key) {
      setError(t('login.error.emptyKey'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const { valid, user } = await authVerifyApi.verify(instanceId, key);
      if (!valid) {
        setError(t('login.error.invalidKey'));
        setSubmitting(false);
        return;
      }
      if (!user) {
        setError(t('login.error.noUser'));
        setSubmitting(false);
        return;
      }
      const instance = instances.find((i) => i.instance_id === instanceId) ?? null;
      setPanelSession({ authMethod: 'user_key', instanceId, instanceName: instance?.name, userKey: key, user });
      const auth = toAuthState(user, instanceId, instance?.name ?? '');
      writeAuthCache(auth);
      onLoggedIn(auth);
    } catch (err) {
      setError(getErrorMessage(err));
      setSubmitting(false);
    }
  }

  function enterWithAuth(user: PublicUser, instanceId: string) {
    setPanelSession({
      authMethod: 'idp',
      instanceId,
      userKey: '',
      user,
    });
    const auth = toAuthState(user, instanceId, '');
    writeAuthCache(auth);
    onLoggedIn(auth);
  }

  /**
   * Step 1 (preview): check whether the user_key entered already has an account in the system.
   * exists=true → show the account info for the user to confirm binding (existing data is fully preserved);
   * exists=false → let the user confirm creating a new account with this key.
   * When the user changes the key, the old preview must be cleared, to avoid submitting B with A's preview result.
   */
  async function previewPendingKey() {
    const key = pendingUserKey.trim();
    if (!key) {
      setError(t('login.woa.userKeyRequired'));
      return;
    }
    setPendingPreviewing(true);
    setError(null);
    try {
      setPendingPreview(await authMethodsApi.previewWoaKey(key));
    } catch (err) {
      setError(getErrorMessage(err));
      setPendingPreview(null);
    } finally {
      setPendingPreviewing(false);
    }
  }

  // Step 2 (confirm): bind the existing account or create a new one based on the preview result.
  async function completePendingWoa() {
    if (!/^[A-Za-z0-9_-]+$/.test(pendingUsername.trim())) {
      setError(t('login.woa.invalidUsername'));
      return;
    }
    if (!pendingUserKey.trim()) {
      setError(t('login.woa.userKeyRequired'));
      return;
    }
    // Preview must come before submit, ensuring the user confirms knowingly (bind vs. create).
    if (!pendingPreview) {
      await previewPendingKey();
      return;
    }
    setPendingSubmitting(true);
    setError(null);
    try {
      const result = await authMethodsApi.completeWoa({
        username: pendingUsername.trim(),
        userKey: pendingUserKey.trim(),
      });
      if (!result.user) throw new Error(t('login.error.noUser'));
      const user = result.user;
      // Auto-generated key: show it once for the user to copy and save, then enter the panel;
      // Custom key: the user already knows it, enter directly.
      if (result.user_key_autogenerated && result.user_key) {
        setCreatedKey({ userKey: result.user_key, user, instanceId: result.instance_id });
        setPendingSubmitting(false);
      } else {
        enterWithAuth(user, result.instance_id);
      }
    } catch (err) {
      setError(getErrorMessage(err));
      setPendingSubmitting(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !submitting) void submit();
  }

  /**
   * WOA confirmation page → switch to user_key login.
   *
   * Must call the backend dismiss first: the WOA gateway injects identity headers into every request, so clearing only frontend state
   * would bounce back to the confirmation page immediately on refresh. The backend clears the pending cookie and issues a suppression flag.
   */
  async function switchToUserKeyFromWoa() {
    setDismissingWoa(true);
    setError(null);
    try {
      await authMethodsApi.dismissWoa();
      setPendingWoa(null);
      setPendingUserKey('');
      setPendingPreview(null);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setDismissingWoa(false);
    }
  }

  /**
   * Clicking iOA-related buttons: revoke the suppression flag + resume the original behavior.
   *
   * Must be paired with switchToUserKeyFromWoa: revoke the suppression flag set earlier,
   * otherwise the WOA ingress middleware lets requests through directly, and after clicking iOA the user would still be stuck on the user_key form.
   *
   * Backend call failure does not block: the suppression flag is session-scoped and expires when the browser is closed;
   * and compared with "clicking iOA does nothing", "a bit slower" is an acceptable degradation.
   */
  async function switchToWoa() {
    setResumingWoa(true);
    setError(null);
    try {
      await authMethodsApi.resumeWoa();
    } catch {
      // Ignored: see the note above; failure does not block.
    }
    setResumingWoa(false);
    if (instanceId) authMethodsApi.loginWoa(instanceId);
  }

  return (
    <div className="_tdai-login">
      {/* Bright dot-matrix wave animated background (pure Canvas, zero external dependencies) */}
      <div className="_tdai-login-bg" aria-hidden="true">
        <ParticleWaveBackground
          className="_tdai-login-bg-canvas"
          gap={22}
          dotRadius={1.6}
          speed={1}
        />
      </div>

      {/* Centered content area */}
      <main className="_tdai-login-main">
        <div className="_tdai-login-card">
          <img src="/logo.png" alt="Memory Hub" className="_tdai-login-logo" />

          <h1 className="_tdai-login-title">{t('login.welcome')}</h1>
          <p className="_tdai-login-subtitle">{t('login.tagline')}</p>

          {pendingWoa && createdKey && (
            <div className="_tdai-login-pending">
              <h2 className="_tdai-login-pending-title">{t('login.woa.keyReadyTitle')}</h2>
              <p className="_tdai-login-hint">{t('login.woa.keyReadyHint')}</p>

              <div className="_tdai-login-field">
                <p className="_tdai-login-field-label">{t('login.woa.yourUserKey')}</p>
                <Input
                  size="full"
                  value={createdKey.userKey}
                  readonly
                />
                <Button
                  className="_tdai-login-copy"
                  onClick={() => {
                    void navigator.clipboard?.writeText(createdKey.userKey);
                    setCopied(true);
                  }}
                >
                  {copied ? t('login.woa.copied') : t('login.woa.copyKey')}
                </Button>
                <p className="_tdai-login-hint _tdai-login-warn">{t('login.woa.keyReadyWarn')}</p>
              </div>

              <Button
                type="primary"
                className="_tdai-login-submit"
                onClick={() => enterWithAuth(createdKey.user, createdKey.instanceId)}
              >
                {t('login.woa.savedEnter')}
              </Button>
            </div>
          )}

          {pendingWoa && !createdKey && (
            <div className="_tdai-login-pending">
              <h2 className="_tdai-login-pending-title">{t('login.woa.pendingTitle')}</h2>
              <p className="_tdai-login-hint">
                {t('login.woa.pendingIdentity', { name: pendingWoa.displayName || pendingWoa.loginName || 'WOA user' })}
              </p>

              <div className="_tdai-login-field">
                <p className="_tdai-login-field-label">{t('login.woa.usernameLabel')}</p>
                <Input
                  size="full"
                  value={pendingUsername}
                  onChange={(value) => {
                    setPendingUsername(value);
                    setError(null);
                  }}
                  placeholder={t('login.woa.usernamePlaceholder')}
                  disabled={pendingSubmitting}
                />
                <p className="_tdai-login-hint">{t('login.woa.usernameHint')}</p>
              </div>

              <div className="_tdai-login-field">
                <p className="_tdai-login-field-label">{t('login.woa.userKeyLabel')}</p>
                <Input
                  size="full"
                  value={pendingUserKey}
                  onChange={(value) => {
                    setPendingUserKey(value);
                    // key changed, the old preview is invalidated immediately — otherwise B would be submitted with A's preview result.
                    setPendingPreview(null);
                    setError(null);
                  }}
                  placeholder={t('login.woa.userKeyPlaceholder')}
                  disabled={pendingSubmitting}
                />
                <p className="_tdai-login-hint">{t('login.woa.userKeyHint')}</p>
              </div>

              {/* Preview result: let the user see who this key belongs to before deciding to bind or create */}
              {pendingPreview && (
                <div className="_tdai-login-alert">
                  {pendingPreview.exists ? (
                    <Alert type="info">
                      {t('login.woa.keyExistsHint', {
                        name: pendingPreview.display_name || pendingPreview.username || pendingPreview.user_id || '',
                      })}
                    </Alert>
                  ) : (
                    <Alert type="info">{t('login.woa.keyMissingHint')}</Alert>
                  )}
                </div>
              )}

              {error && (
                <div className="_tdai-login-alert">
                  <Alert type="error">{error}</Alert>
                </div>
              )}

              <Button
                type="primary"
                className="_tdai-login-submit"
                onClick={() => void completePendingWoa()}
                loading={pendingSubmitting || pendingPreviewing}
                disabled={pendingSubmitting || pendingPreviewing || !pendingUsername.trim() || !pendingUserKey.trim()}
              >
                {/* Not previewed = Next (see the key's owner first); previewed = clearly tell whether this is a bind or a create */}
                {!pendingPreview
                  ? t('login.woa.previewNext')
                  : pendingPreview.exists
                    ? t('login.woa.confirmBind')
                    : t('login.woa.confirmCreate')}
              </Button>

              {/* Existing users who already have a user_key should not be forced to create an account: provide a way back to user_key login */}
              {hasUserKeyMethod && (
                <div className="_tdai-login-switch">
                  <Button
                    type="link"
                    className="_tdai-login-switch-link"
                    onClick={() => void switchToUserKeyFromWoa()}
                    loading={dismissingWoa}
                    disabled={pendingSubmitting || dismissingWoa}
                  >
                    {t('login.switchUserKey')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {!pendingWoa && showUserKeyLogin && (
            <form onSubmit={submit} className="_tdai-login-form">
            {/* Memory instance selection — GET /api/v1/meta/instances */}
            <div className="_tdai-login-field">
              <label className="_tdai-login-label" htmlFor="tdai-login-instance">
                {t('login.field.instance')}
              </label>
              <Select
                appearance="button"
                size="full"
                value={instanceId}
                onChange={(value) => {
                  setInstanceId(value);
                  setError(null);
                }}
                disabled={submitting || instances.length === 0}
                placeholder={
                  instancesError ? t('login.placeholder.instanceError') : t('login.placeholder.instance')
                }
                options={instances.map((inst) => ({ value: inst.instance_id, text: inst.name }))}
                boxSizeSync
              />
            </div>

            {/* user_key (sk-mem-…), written to the frontend session after the auth/verify liveness check */}
            <div className="_tdai-login-field">
              <label className="_tdai-login-label" htmlFor="tdai-login-key">
                {t('login.field.userKey')}
              </label>
              <Input.Password
                size="full"
                value={userKey}
                onChange={(value) => {
                  setUserKey(value);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                placeholder={t('login.placeholder.userKey')}
                autoComplete="current-password"
                disabled={submitting}
                rules={false}
              />
              <p className="_tdai-login-hint">{t('login.hint.userKey')}</p>
            </div>

            {error && (
              <div className="_tdai-login-alert">
                <Alert type="error">{error}</Alert>
              </div>
            )}

            <Button
              type="primary"
              htmlType="submit"
              className="_tdai-login-submit"
              loading={submitting}
              disabled={submitting || !userKey.trim() || !instanceId}
            >
              {submitting ? t('login.submitting') : t('login.submit')}
            </Button>
            </form>
          )}

          {/* user_key form: iOA jump entry below it; when iOA is enabled, jump straight there without a selection page */}
          {!pendingWoa && showWoaLogin && showUserKeyLogin && instanceId && (
            <div className="_tdai-login-switch">
              <Button
                type="link"
                className="_tdai-login-switch-link"
                onClick={() => void switchToWoa()}
                loading={resumingWoa}
                disabled={submitting || resumingWoa}
              >
                {t('login.useWoa')}
              </Button>
            </div>
          )}
        </div>

        <p className="_tdai-login-footer">{t('login.footer')}</p>
      </main>
    </div>
  );
}
