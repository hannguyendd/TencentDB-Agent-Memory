/**
 * api/base.ts - API infrastructure.
 *
 * Rules (no Cookie · stateless):
 *   - Metadata CRUD uniformly goes through POST /api/v1/meta/{action};
 *   - Auth is by the frontend sessionStorage caching instance_id + user_key (see lib/panelSession.ts),
 *     injecting Headers X-Tdai-Service-Id + X-Tdai-User-Key on every request (except auth/verify,
 *     whose user_key goes only in the body, not in a Header);
 *   - agent-fixed-asset/* does not apply to the generic "asset" UI (PANEL_CAPABILITIES.assets is false),
 *     skill mounting goes through the v3 data-plane fork (skillApi.forkToAgent);
 *   - All functions return Promise<T> and throw ApiError on failure.
 */
import { getPanelSession, clearPanelSession } from '../panelSession';
import { formatApiErrorMessage } from '../error-message';
import type { MetaEnvelope, PaginatedResult, PublicUser } from './types';

/**
 * Generic "asset" capability switch.
 * Before the UI consumes assetsApi / agentsApi.getAssets|getFixedAssets|setFixedAssets it should first check
 * `PANEL_CAPABILITIES.assets`; when false, show a "not yet available" placeholder and do not send requests doomed to 501.
 */
export const PANEL_CAPABILITIES = {
  assets: false,
} as const;

// ========================= Error =========================

export class ApiError extends Error {
  public code?: number | string;
  public requestId?: string;
  public rawMessage?: string;

  constructor(
    public status: number,
    public statusText: string,
    public body: string,
    opts: { code?: number | string; requestId?: string; rawMessage?: string } = {}
  ) {
    super(formatApiErrorMessage({
      code: opts.code,
      message: opts.rawMessage ?? statusText,
      requestId: opts.requestId,
      httpStatus: status,
      httpStatusText: statusText,
      body,
    }));
    this.name = 'ApiError';
    this.code = opts.code;
    this.requestId = opts.requestId;
    this.rawMessage = opts.rawMessage ?? statusText;
  }
}

// ========================= Base Request =========================

const AUTH_UNAUTHORIZED_EVENT = 'auth:unauthorized';

/** Emit a 401 event; the App layer listens, clears the auth state and shows the login page */
function emitUnauthorized() {
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT));
}

/** Listen for the 401 event */
export function onUnauthorized(handler: () => void): () => void {
  window.addEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
  return () => window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, handler);
}

function parseMetaErrorEnvelope(text: string): {
  code?: number | string;
  requestId?: string;
  rawMessage?: string;
} {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return {};
  try {
    const env = JSON.parse(trimmed) as MetaEnvelope<unknown>;
    if (typeof env?.message === 'string' && env.message.trim()) {
      return {
        code: env.code,
        requestId: env.request_id,
        rawMessage: env.message,
      };
    }
  } catch {
    /* non-JSON error body */
  }
  return {};
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<T> {
  const headers: Record<string, string> = { ...extraHeaders };
  const init: RequestInit = { method, headers, credentials: 'include' };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    const text = await res.text().catch(() => '');
    const env = parseMetaErrorEnvelope(text);
    // WOA login confirmation has not yet established a business session, so on failure the whole login page state must not be cleared.
    if (!path.endsWith('/auth/idp/woa/complete')) emitUnauthorized();
    throw new ApiError(res.status, res.statusText, text || 'Unauthorized', env);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const env = parseMetaErrorEnvelope(text);
    throw new ApiError(res.status, res.statusText, text, env);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

// ========================= Meta API basics =========================

export const META_PREFIX = '/api/v1/meta';
export const META_PAGE_SIZE = 100;

/**
 * Clear the frontend session on logout / 401 (instance_id + user_key + user cache).
 * No Cookie; "clearing the session" just clears sessionStorage and involves no backend call.
 */
export function clearSessionCache(): void {
  clearPanelSession();
}

/** Get the current logged-in user from the session; throws if not logged in (callers should ensure login first). */
export async function getCurrentUser(): Promise<PublicUser> {
  const session = getPanelSession();
  if (!session?.user) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  return session.user;
}

/**
 * Unwrap the kernel's unified envelope: throws ApiError when `code !== 0` or `data` is empty.
 *
 * The envelope structure of transparent proxies such as meta (/api/v1/meta/*) and analytics (/api/v1/analytics/*) is
 * exactly the same; the unwrap logic is carried uniformly by this function, avoiding behavior drift caused by each client reimplementing it.
 */
export function unwrapEnvelope<T>(envelope: MetaEnvelope<T>, emptyMessage: string): T {
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  if (envelope.data === null || envelope.data === undefined) {
    throw new ApiError(200, envelope.message || emptyMessage, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message || emptyMessage,
    });
  }
  return envelope.data;
}

/**
 * Common call of the meta transparent proxy: inject the specified Header, POST body, parse the envelope.
 * `auth/verify` goes through this function but passes only X-Tdai-Service-Id (without user-key),
 * other actions go through `metaPost` (automatically injecting both Headers from the session).
 */export async function metaCall<T>(
  action: string,
  body: Record<string, unknown>,
  headers: Record<string, string>
): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>('POST', `${META_PREFIX}/${action}`, body, headers);
  return unwrapEnvelope(envelope, 'empty meta response');
}

export async function metaPost<T>(action: string, body: Record<string, unknown> = {}): Promise<T> {
  const session = getPanelSession();
  if (!session) {
    throw new ApiError(401, 'Unauthorized', 'no active panel session');
  }
  const headers: Record<string, string> = { 'X-Tdai-Service-Id': session.instanceId };
  // IdP Session authenticates with an HttpOnly Cookie; user_key is not sent down to the browser.
  if (session.userKey) headers['X-Tdai-User-Key'] = session.userKey;
  return metaCall<T>(action, body, headers);
}

/**
 * Page through all items of a meta list (kernel DEFAULT_PAGINATION = {limit: 20};
 * without passing limit only the first 20 are returned, so list reads must use this utility to get everything).
 *
 * offset must step by limit and **not** by `items.length`: for APIs with filter semantics
 * (e.g. agent-fixed-asset/list-with-detail, where total is the pre-filter total and items is the filtered set)
 * `items.length < limit`, and advancing by items.length makes the next page restart from the wrong position,
 * causing duplicate entries; when a whole page is filtered out it also breaks early and misses the tail data.
 */
export async function metaListAll<T>(action: string, body: Record<string, unknown>): Promise<T[]> {
  const items: T[] = [];
  let offset = 0;
  for (;;) {
    const page = await metaPost<PaginatedResult<T>>(action, {
      ...body,
      limit: META_PAGE_SIZE,
      offset,
    });
    const batch = page.items ?? [];
    items.push(...batch);
    const total = typeof page.total === 'number' ? page.total : undefined;
    if (batch.length === 0) {
      // Empty page: usually means the end has been reached. But for APIs with filter semantics a middle page may be entirely empty
      // (total is still the pre-filter total), so keep advancing to avoid missing later valid data.
      if (total !== undefined && offset + META_PAGE_SIZE < total) {
        offset += META_PAGE_SIZE;
        continue;
      }
      break;
    }
    offset += META_PAGE_SIZE;
    if (total !== undefined && offset >= total) break;
  }
  return items;
}

/**
 * "In-flight deduplication": when the previous request on the same key has not settled, reuse the same Promise,
 * and remove it from the table immediately after the request ends (no result caching).
 *
 * Purpose: eliminate the double invocation of effects in React 18 StrictMode dev mode, and duplicate network requests for the same API
 * caused by concurrent component mounting.
 *
 * Constraint: only for **idempotent read-only** APIs (list/get). Write operations such as create/revoke must never reuse it,
 * otherwise two independent writes would be merged into one.
 */
const inFlightReads = new Map<string, Promise<unknown>>();
export function dedupeInFlight<T>(key: string, factory: () => Promise<T>): Promise<T> {
  const existing = inFlightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const p = factory().finally(() => {
    inFlightReads.delete(key);
  });
  inFlightReads.set(key, p);
  return p;
}
