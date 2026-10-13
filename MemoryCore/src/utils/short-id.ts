/**
 * short-id — a short ID generator based on CSPRNG + base62
 *
 * Why not Math.random().toString(36):
 *   - Math.random() is pseudo-random (V8 xorshift128+), and the returned double mantissa has only 52 bits
 *   - No seed isolation across processes; replicas starting in the same second may have correlated leading digits
 *   - 12 base36 characters look like a 62-bit space, but limited by 52 bits of entropy,
 *     the collision probability for 1 million skills on a single instance is about 1.1e-4 (birthday paradox; not engineering-acceptable)
 *
 * This utility uses `crypto.randomBytes` (CSPRNG) + base62 encoding:
 *   - base62 = 0-9 A-Z a-z, purely alphanumeric, no special symbols (URL/COS/log friendly)
 *   - 12 base62 characters = 62^12 ≈ 3.23e21 space ≈ 71 bits of true entropy
 *   - Collision probability at 1 million entries ≈ 1.5e-10, about 730,000 times lower than the status quo
 *
 * Used for:
 *   - SkillCore generating skill_id (`skl-` + 12 characters = 16 characters, the same length as the status quo)
 *   - SqliteSkillStore / TcvdbSkillStore generating row_id
 */

import { randomBytes } from "node:crypto";

const BASE62_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Rejection sampling threshold: floor(256 / 62) * 62 = 248
// Byte values 0..247 map uniformly to the 62 characters; 248..255 are discarded to avoid modulo bias.
const REJECTION_THRESHOLD = 248;

/**
 * Generate a base62 random string of the given length (CSPRNG entropy).
 *
 * @param len number of output characters (>=1)
 */
export function randomBase62(len: number): string {
  if (!Number.isInteger(len) || len < 1) {
    throw new RangeError(`randomBase62: len must be a positive integer, got ${len}`);
  }
  let out = "";
  while (out.length < len) {
    // How many bytes are needed: estimate ceil(remaining length * 256/248) + a little slack
    const remaining = len - out.length;
    const need = Math.max(8, Math.ceil((remaining * 256) / REJECTION_THRESHOLD) + 4);
    const buf = randomBytes(need);
    for (let i = 0; i < buf.length && out.length < len; i++) {
      const b = buf[i];
      if (b < REJECTION_THRESHOLD) {
        out += BASE62_ALPHABET[b % 62];
      }
    }
  }
  return out;
}
