export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=') || undefined;
  }
  return undefined;
}

export function buildSessionCookie(
  ...args: [name: string, token: string, maxAgeSeconds: number, secure: boolean]
): string {
  const [name, token, maxAgeSeconds, secure] = args;
  const attributes = [
    `${name}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

/**
 * Build a "session-scoped" cookie (no Max-Age / Expires).
 *
 * Difference from buildSessionCookie: the latter always carries Max-Age and persists after the browser closes;
 * a session-scoped cookie disappears automatically when the browser session ends. Suited to expressing "a temporary choice for this browsing session" --
 * such a choice should not survive a browser restart, otherwise users get stuck with an old decision they have long forgotten.
 */
export function buildTransientCookie(name: string, value: string, secure: boolean): string {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildExpiredSessionCookie(name: string, secure: boolean): string {
  return buildSessionCookie(name, '', 0, secure);
}
