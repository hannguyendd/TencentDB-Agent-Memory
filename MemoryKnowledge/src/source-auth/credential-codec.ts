/**
 * Credential base64 encode/decode (for storage; not encryption).
 *
 * The token is stored in `cred_secret` as base64 and decoded in memory at use time.
 * base64 provides no confidentiality: Node's base64 decoding does not throw, and invalid input yields garbage —
 * so a charset + length check must be done **first**, otherwise corrupted content would be used as a valid token to clone.
 *
 * Confidentiality is provided by access control (SQLite file permissions + the API never echoing it + plaintext never in logs),
 * not by this module. See design doc §4.1.3.
 */

const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** UTF-8 → base64. An empty string returns an empty string (the caller guarantees secret is non-empty). */
export function encodeSecret(plain: string): string {
  return Buffer.from(plain, "utf8").toString("base64");
}

/** base64 → UTF-8. Invalid input returns null (does not throw). */
export function decodeSecret(b64: string | null | undefined): string | null {
  if (!b64 || b64.length % 4 !== 0 || !B64_RE.test(b64)) return null;
  return Buffer.from(b64, "base64").toString("utf8");
}
