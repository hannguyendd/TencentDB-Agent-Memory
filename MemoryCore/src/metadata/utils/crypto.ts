/**
 * User key and password hash utilities.
 *
 * Corresponds to design doc §5:
 *   - user_key: `sk-mem-` prefix + 24-byte (192-bit) base64url random segment, the identifier for external call auth
 *   - password: scrypt + per-user random salt + global pepper (irreversible hash)
 *
 * The pepper is injected at deployment via an environment variable (see loadPasswordHashConfig).
 * Since v3.1 the metadata User domain no longer uses password hashes; this module only keeps generateUserKey and the legacy hash utilities.
 */

import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { USER_KEY_PREFIX } from "./user-key.js";

/**
 * Generate a user key: `sk-mem-` prefix + 24-byte (192-bit) base64url random segment.
 *
 * The base64url charset is `[A-Za-z0-9_-]`, safe for URLs / HTTP headers / JSON.
 * 192 bits of entropy is far above what the collision bound requires; together with the unique index on `key_value` it guarantees global uniqueness.
 */
export function generateUserKey(): string {
  return USER_KEY_PREFIX + randomBytes(24).toString("base64url");
}

const PASSWORD_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";

/** Generate a random password (default 12 characters, charset: upper/lowercase letters, digits, underscore). */
export function generatePassword(length = 12): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += PASSWORD_CHARSET[bytes[i]! % PASSWORD_CHARSET.length];
  }
  return out;
}

/** scrypt parameters and the stored-format prefix. */
export const PASSWORD_HASH_PREFIX = "$scrypt$";
const SALT_LEN = 16;
const DEFAULT_SCRYPT_N = 16384;
const DEFAULT_SCRYPT_R = 8;
const DEFAULT_SCRYPT_P = 1;
const DEFAULT_SCRYPT_KEYLEN = 32;
const PEPPER_LEN = 32;

export interface PasswordHashConfig {
  pepper: Buffer;
  scryptN: number;
  scryptR: number;
  scryptP: number;
  keylen: number;
}

/**
 * Load the password hash config from environment variables.
 *
 * Environment variables:
 *   - TDAI_PASSWORD_PEPPER — base64-encoded 32-byte random value (required in service mode)
 *   - TDAI_PASSWORD_SCRYPT_N / _R / _P / _KEYLEN — optional scrypt parameters
 *
 * @throws when the pepper is not configured or has an invalid format.
 */
export function loadPasswordHashConfig(env: NodeJS.ProcessEnv = process.env): PasswordHashConfig {
  const pepperB64 = env.TDAI_PASSWORD_PEPPER?.trim();
  if (!pepperB64) {
    throw new Error("TDAI_PASSWORD_PEPPER is not configured (base64-encoded 32-byte secret required)");
  }
  const pepper = Buffer.from(pepperB64, "base64");
  if (pepper.length !== PEPPER_LEN) {
    throw new Error(
      `TDAI_PASSWORD_PEPPER must decode to ${PEPPER_LEN} bytes, got ${pepper.length}`,
    );
  }

  const scryptN = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_N, DEFAULT_SCRYPT_N);
  const scryptR = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_R, DEFAULT_SCRYPT_R);
  const scryptP = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_P, DEFAULT_SCRYPT_P);
  const keylen = parsePositiveInt(env.TDAI_PASSWORD_SCRYPT_KEYLEN, DEFAULT_SCRYPT_KEYLEN);

  return { pepper, scryptN, scryptR, scryptP, keylen };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    throw new Error(`Invalid scrypt parameter: ${raw}`);
  }
  return n;
}

function scryptHash(plain: string, salt: Buffer, config: PasswordHashConfig): Buffer {
  const input = Buffer.concat([config.pepper, Buffer.from(plain, "utf8")]);
  return scryptSync(input, salt, config.keylen, {
    N: config.scryptN,
    r: config.scryptR,
    p: config.scryptP,
  });
}

/**
 * Hash a plaintext password with scrypt+pepper, returning a self-describing stored string.
 *
 * Format: `$scrypt$N,r,p$<salt_b64>$<hash_b64>`
 */
export function hashPassword(plain: string, config: PasswordHashConfig): string {
  const salt = randomBytes(SALT_LEN);
  const hash = scryptHash(plain, salt, config);
  return (
    `${PASSWORD_HASH_PREFIX}${config.scryptN},${config.scryptR},${config.scryptP}` +
    `$${salt.toString("base64url")}$${hash.toString("base64url")}`
  );
}

/** Determine whether a stored string is in the scrypt hash format. */
export function isPasswordHash(stored: string): boolean {
  return stored.startsWith(PASSWORD_HASH_PREFIX);
}

/**
 * Verify whether a plaintext password matches the stored hash. Returns false (no exception) for an invalid format or mismatched parameters.
 */
export function verifyPasswordHash(
  plain: string,
  stored: string,
  config: PasswordHashConfig,
): boolean {
  try {
    if (!isPasswordHash(stored)) return false;

    const body = stored.slice(PASSWORD_HASH_PREFIX.length);
    const firstSep = body.indexOf("$");
    if (firstSep < 0) return false;

    const params = body.slice(0, firstSep).split(",");
    if (params.length !== 3) return false;
    const [nStr, rStr, pStr] = params;
    const n = Number(nStr);
    const r = Number(rStr);
    const p = Number(pStr);
    if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

    const rest = body.slice(firstSep + 1);
    const secondSep = rest.indexOf("$");
    if (secondSep < 0) return false;

    const salt = Buffer.from(rest.slice(0, secondSep), "base64url");
    const expectedHash = Buffer.from(rest.slice(secondSep + 1), "base64url");

    const verifyConfig: PasswordHashConfig = {
      ...config,
      scryptN: n,
      scryptR: r,
      scryptP: p,
      keylen: expectedHash.length,
    };
    const actualHash = scryptHash(plain, salt, verifyConfig);
    if (actualHash.length !== expectedHash.length) return false;
    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}
