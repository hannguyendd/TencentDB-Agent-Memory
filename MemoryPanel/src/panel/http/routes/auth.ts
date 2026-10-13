import type { Context, Hono, Next } from 'hono';
import type { PanelDeps } from '../../panel-deps.js';
import { buildExpiredSessionCookie, buildSessionCookie, buildTransientCookie, readCookie } from '../../auth/cookies.js';
import { PanelAuthError } from '../../auth/service.js';

const INSTANCE_QUERY = 'instance_id';
const RETURN_QUERY = 'return_to';
const PENDING_WOA_COOKIE = 'tdai_woa_pending';
const PENDING_WOA_TTL_SECONDS = 300;
/**
 * Suppression cookie for "switched to user_key login this time".
 *
 * The upstream gateway injects identity headers on every request, and the middleware that registers the WOA ingress route
 * rebuilds the pending login on every visit to the root path. So "switch to user_key" cannot just clear the pending
 * cookie; it must also set a suppression marker, otherwise a page refresh would immediately bounce the user back to the WOA confirmation page.
 *
 * A cookie rather than server memory: it remains valid after a process restart and needs no session table.
 * It stores only a constant value with no identity information, so no identifiable data lands in the browser.
 *
 * Must be **session-scoped** (no Max-Age). A 12h persistent cookie was once used by mistake, and the frontend logout() does not call the backend
 * /auth/logout (the new panel has no server-side session; logout only clears localStorage), so once the marker was set it
 * could not be cleared: after the user clicked "Switch to user_key login" once, they could not enter the WOA flow again for 12 hours.
 * Session scope ensures it expires when the browser closes, limiting the impact to "this browsing session".
 */
const WOA_DISMISSED_COOKIE = 'tdai_woa_dismissed';
const WOA_DISMISSED_VALUE = '1';

function headersOf(c: { req: { raw: Request } }): Record<string, string | undefined> {
  return Object.fromEntries(c.req.raw.headers.entries());
}

function returnTo(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return '/';
  return value;
}

function handleAuthError(c: Context, err: unknown): Response {
  if (err instanceof PanelAuthError) {
    return c.json(
      { code: err.status, message: err.code, request_id: c.get('reqId') ?? '', data: null },
      err.status as 400 | 401 | 403 | 404 | 500,
    );
  }
  throw err;
}

export function registerAuthRoutes(api: Hono, deps: PanelDeps): void {
  api.get('/auth/methods', (c) => c.json({ methods: deps.auth.listMethods() }));

  /**
   * The four WOA-specific GET routes are targets of **full-page browser navigation** (user clicks a link / the gateway redirects directly),
   * not fetch calls. When WOA is not enabled they must not return a bare JSON 404 that leaves the browser on an error page -- they must redirect back to
   * the login page root path and hand control back to the SPA to show the user_key form, so it "works as it did before WOA was developed".
   * Only affects these four GET routes; POST endpoints (dismiss/resume/bind/preview-key/complete)
   * are fetch calls, and their JSON errors are unaffected.
   */
  const isWoaEnabled = () => deps.auth.listMethods().some((m) => m.type === 'woa');

  const login = (c: Context) => {
    if (!isWoaEnabled()) return c.redirect('/', 302);
    try {
      const instanceId = c.req.query(INSTANCE_QUERY);
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const url = deps.auth.buildWoaLoginUrl(instanceId, returnTo(c.req.query(RETURN_QUERY)));
      return c.redirect(url, 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  };
  api.get('/auth/idp/woa/login', login);
  api.get('/auth/idp/woa/authorize', login);

  api.get('/auth/idp/woa/callback', async (c: Context) => {
    if (!isWoaEnabled()) return c.redirect('/', 302);
    try {
      const instanceId = c.req.query(INSTANCE_QUERY);
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const result = await deps.auth.completeWoaLogin(
        instanceId,
        headersOf(c),
        returnTo(c.req.query(RETURN_QUERY)),
        c.get('reqId'),
      );
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ));
      return c.redirect(returnTo(c.req.query(RETURN_QUERY)), 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.get('/auth/session', (c: Context) => {
    const session = deps.auth.getSession(readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName));
    if (!session) {
      const pending = deps.auth.getPendingWoaLogin(readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE));
      if (!pending) return c.json({ authenticated: false }, 200);
      return c.json({
        authenticated: false,
        pending: true,
        instance_id: pending.instanceId,
        pending_identity: {
          display_name: pending.identity.displayName,
          login_name: pending.identity.loginName,
          subject: pending.identity.subject,
        },
      }, 200);
    }
    const requestedInstance = c.req.query(INSTANCE_QUERY);
    if (requestedInstance && requestedInstance !== session.instanceId) {
      return c.json({ authenticated: false }, 200);
    }
    return c.json({
      authenticated: true,
      method: 'idp',
      instance_id: session.instanceId,
      user_id: session.coreUserId,
      provider_id: session.providerId,
      external_subject: session.externalSubject,
      display_name: session.displayName,
      user: session.user,
      expires_at: session.expiresAt,
    });
  });

  // ── user_key login (compatible with user-owned keys) ─────────────────────────────────
  //
  // A pair of endpoints parallel to the WOA flow, but **not dependent on the pending cookie**: the user enters their own key directly,
  // and if the system does not have it, it is used to create an account (registration on first login). Two-step confirmation (preview -> confirm) prevents wrong binding.
  //
  // Goes through Panel rather than the frontend connecting to core directly: account creation needs the instance admin credentials, which the frontend cannot get,
  // and auth/verify is a read-only probe that cannot create accounts.
  api.post('/auth/user-key/preview', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        instance_id?: unknown;
        user_key?: unknown;
      };
      const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const preview = await deps.auth.previewUserKeyLogin({
        instanceId,
        userKey: typeof body.user_key === 'string' ? body.user_key : '',
        requestId: c.get('reqId'),
      });
      return c.json(preview);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/user-key/login', async (c: Context) => {
    try {
      const body = await c.req.json().catch(() => ({})) as {
        instance_id?: unknown;
        user_key?: unknown;
        username?: unknown;
      };
      const instanceId = typeof body.instance_id === 'string' ? body.instance_id : '';
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      const result = await deps.auth.loginWithUserKey({
        instanceId,
        userKey: typeof body.user_key === 'string' ? body.user_key : '',
        username: typeof body.username === 'string' ? body.username : undefined,
        requestId: c.get('reqId'),
      });
      return c.json({
        authenticated: true,
        instance_id: instanceId,
        user_id: result.user_id,
        user: result.user,
        created: result.created,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  // Preview: whether the user_key entered by the user already has a corresponding account in the system.
  // A guard against wrong binding on first external-auth login -- let the user see clearly "whom this key belongs to" first,
  // then decide whether to bind it or create a new one, instead of silently deciding for the user.
  api.post('/auth/idp/woa/preview-key', async (c: Context) => {
    try {
      const token = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
      if (!token) return c.json({ code: 401, message: 'WOA_LOGIN_PENDING_REQUIRED', data: null }, 401);
      const body = await c.req.json().catch(() => ({})) as { user_key?: unknown };
      const userKey = typeof body.user_key === 'string' ? body.user_key : '';
      const preview = await deps.auth.previewPendingWoaLogin({
        token,
        userKey,
        requestId: c.get('reqId'),
      });
      return c.json(preview);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/idp/woa/complete', async (c: Context) => {
    try {
      const token = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
      if (!token) return c.json({ code: 401, message: 'WOA_LOGIN_PENDING_REQUIRED', data: null }, 401);
      const body = await c.req.json().catch(() => ({})) as {
        username?: unknown;
        user_key?: unknown;
        custom_user_key?: unknown;
      };
      const result = await deps.auth.completePendingWoaLogin({
        token,
        username: typeof body.username === 'string' ? body.username : undefined,
        userKey: typeof body.user_key === 'string' ? body.user_key : undefined,
        customUserKey: typeof body.custom_user_key === 'string' ? body.custom_user_key : undefined,
        requestId: c.get('reqId'),
      });
      c.header('Set-Cookie', buildExpiredSessionCookie(PENDING_WOA_COOKIE, deps.config.auth.sessionSecure));
      // The user has completed login via WOA; the suppression marker is no longer needed, so clear it to avoid affecting the next login.
      c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ), { append: true });
      return c.json({
        authenticated: true,
        instance_id: result.session.instanceId,
        user_id: result.session.coreUserId,
        user: result.session.user,
        // Return the newly created account's user_key once, for the user to copy into clients such as CodeBuddy/ClaudeCode to connect to the proxy.
        // A custom key is provided by the user and need not be echoed; an auto-generated key is visible only this once.
        user_key: result.userKeyDisplay ?? undefined,
        user_key_autogenerated: result.userKeyAutogenerated ?? false,
      });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  // "Switch to user_key login": clear the WOA pending state + set the suppression marker, so the login page stays on the user_key form.
  // The suppression marker is cleared on successful login (user_key or IdP), to avoid affecting the next normal login.
  api.post('/auth/idp/woa/dismiss', (c: Context) => {
    const pendingToken = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
    deps.auth.dismissPendingWoaLogin(pendingToken);
    c.header('Set-Cookie', buildExpiredSessionCookie(PENDING_WOA_COOKIE, deps.config.auth.sessionSecure));
    // Session-scoped (no Max-Age): expires when the browser closes, so a "temporary choice" does not become cross-day persistent state.
    c.header('Set-Cookie', buildTransientCookie(
      WOA_DISMISSED_COOKIE,
      WOA_DISMISSED_VALUE,
      deps.config.auth.sessionSecure,
    ), { append: true });
    return c.json({ ok: true });
  });

  // "Switch back to iOA login": clear the suppression marker. dismiss is a reversible temporary choice; the user can switch back at any time.
  api.post('/auth/idp/woa/resume', (c: Context) => {
    c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure));
    return c.json({ ok: true });
  });

  api.post('/auth/logout', (c: Context) => {
    const token = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    deps.auth.destroySession(token);
    c.header('Set-Cookie', buildExpiredSessionCookie(
      deps.config.auth.sessionCookieName,
      deps.config.auth.sessionSecure,
    ));
    // Logout means the "this time" choice has ended; clear the suppression marker so the next login returns to the default (WOA) entry.
    c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
    return c.json({ ok: true });
  });

  api.get('/auth/idp/woa/logout', (c: Context) => {
    const token = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    deps.auth.destroySession(token);
    c.header('Set-Cookie', buildExpiredSessionCookie(
      deps.config.auth.sessionCookieName,
      deps.config.auth.sessionSecure,
    ));
    c.header('Set-Cookie', buildExpiredSessionCookie(WOA_DISMISSED_COOKIE, deps.config.auth.sessionSecure), { append: true });
    if (!isWoaEnabled()) return c.redirect('/', 302);
    try {
      return c.redirect(deps.auth.buildWoaLogoutUrl(returnTo(c.req.query(RETURN_QUERY))), 302);
    } catch (err) {
      return handleAuthError(c, err);
    }
  });

  api.post('/auth/idp/woa/bind', async (c: Context) => {
    try {
      const instanceId = c.req.header('X-Tdai-Service-Id')?.trim();
      const userKey = c.req.header('X-Tdai-User-Key')?.trim();
      if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
      if (!userKey) return c.json({ code: 400, message: 'MISSING_USER_KEY', data: null }, 400);
      const result = await deps.auth.bindWoaIdentity(instanceId, userKey, headersOf(c), c.get('reqId'));
      return c.json({ code: 0, message: 'ok', request_id: c.get('reqId') ?? '', data: result });
    } catch (err) {
      return handleAuthError(c, err);
    }
  });
}

export function registerWoaIngressRoutes(app: Hono, deps: PanelDeps): void {
  // All Providers using the "gateway injects identity headers" pattern (currently only WOA) enter through this middleware:
  // iterate the registered header-injected Providers; if any provider's ingressHeaderName matches,
  // it is treated as a login request initiated by that provider. To add a second provider of this kind later (e.g. iOA), just register one in the registry;
  // this middleware need not change.
  const headerProviders = deps.auth.listHeaderInjectedProviders();
  if (headerProviders.length === 0) return;
  app.get('*', async (c: Context, next: Next) => {
    // The gateway's redirect-back target is the APP_URL root path; identity is injected by the gateway via request headers.
    if (c.req.path !== '/') return next();
    // Find the first matching Provider in registration order. If none matches, pass through (keeping "same as before development when no IdP is enabled").
    const matched = headerProviders.find((p) => c.req.header(p.ingressHeaderName));
    if (!matched) return next();
    // The user has explicitly chosen to switch to user_key login: do not automatically enter the IdP flow this time.
    if (readCookie(c.req.header('cookie'), WOA_DISMISSED_COOKIE) === WOA_DISMISSED_VALUE) return next();
    const sessionToken = readCookie(c.req.header('cookie'), deps.config.auth.sessionCookieName);
    const pendingToken = readCookie(c.req.header('cookie'), PENDING_WOA_COOKIE);
    if (deps.auth.getSession(sessionToken) || deps.auth.getPendingWoaLogin(pendingToken)) return next();
    const instanceId = c.req.query(INSTANCE_QUERY) || deps.instanceRegistry.listAll()[0]?.instance_id;
    if (!instanceId) return c.json({ code: 400, message: 'MISSING_INSTANCE_ID', data: null }, 400);
    const returnPath = returnTo(c.req.query(RETURN_QUERY));
    try {
      const result = await deps.auth.completeWoaLogin(
        instanceId,
        headersOf(c),
        returnPath,
        c.get('reqId'),
      );
      c.header('Set-Cookie', buildSessionCookie(
        deps.config.auth.sessionCookieName,
        result.session.token,
        deps.config.auth.sessionTtlSeconds,
        deps.config.auth.sessionSecure,
      ));
      return c.redirect(returnPath, 302);
    } catch (err) {
      if (err instanceof PanelAuthError && err.code === 'IDENTITY_NOT_BOUND') {
        const pending = await deps.auth.createPendingWoaLogin({
          instanceId,
          headers: headersOf(c),
        });
        c.header('Set-Cookie', buildSessionCookie(
          PENDING_WOA_COOKIE,
          pending.token,
          PENDING_WOA_TTL_SECONDS,
          deps.config.auth.sessionSecure,
        ));
        return c.redirect(returnPath, 302);
      }
      return handleAuthError(c, err);
    }
  });
}
