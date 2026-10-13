/**
 * user_key sanitization and validity checks (multi-key model).
 */

/** Fixed user_key prefix, used to identify ownership and for secret scanning. */
export const USER_KEY_PREFIX = "sk-mem-";

/**
 * Generic sensitive-string sanitization: first 8 characters + ellipsis, never exposing the full secret.
 * Used by api-trace to sanitize logs of generic secrets such as password / token / authorization.
 */
export function maskKeyValue(keyValue: string): string {
  if (!keyValue) return "";
  if (keyValue.length <= 8) return `${keyValue}…`;
  return `${keyValue.slice(0, 8)}…`;
}

/**
 * user_key sanitization for list/detail display: keep the `sk-mem-` prefix + `****` + last 4 characters.
 * For example `sk-mem-<32 chars>...e5fG` → `sk-mem-****e5fG`.
 */
export function maskUserKey(keyValue: string): string {
  if (!keyValue) return "";
  const prefix = keyValue.startsWith(USER_KEY_PREFIX) ? USER_KEY_PREFIX : "";
  const body = keyValue.slice(prefix.length);
  const tail = body.length >= 4 ? body.slice(-4) : body;
  return `${prefix}****${tail}`;
}

/** Whether an active key has expired (expires_at is an ISO string). */
export function isUserKeyExpired(expiresAt: string | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now;
}

export const DEFAULT_MAX_ACTIVE_USER_KEYS = 20;
