/**
 * YAML static memory system user (auth/verify path only; not persisted, not hooked into authenticateV3).
 */

import { timingSafeEqual } from "node:crypto";
import type { GatewayMetadataConfig } from "../gateway/config.js";
import type { MetadataDeployMode } from "./store/factory.js";
import { MetadataStartupValidationError } from "./store/factory.js";
import type { UserEntity } from "./types.js";
import { USER_KEY_PREFIX } from "./utils/user-key.js";

export const MEMORY_SYSTEM_USER_ID_PREFIX = "usr-sys-";
const MEMORY_SYSTEM_USERNAME = "memory";
const MEMORY_SYSTEM_AUTH_PROVIDER = "system";
const MEMORY_SYSTEM_EXTERNAL_ID = "memory";

export interface MemorySystemUserConfig {
  userId: string;
  displayName: string;
  userKey: string;
}

function env(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

function safeEqual(a: string, b: string): boolean {
  if (!a || !b) return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** user_key format: sk-mem- + 32-character base64url. */
export function isValidMemorySystemUserKey(userKey: string): boolean {
  return /^sk-mem-[A-Za-z0-9_-]{32}$/.test(userKey);
}

/** Resolve from Gateway metadata + process.env (env takes precedence). */
export function resolveMemorySystemUserConfig(
  metadata: GatewayMetadataConfig,
): MemorySystemUserConfig | undefined {
  const yaml = metadata.systemUser?.memory;
  const userId = env("TDAI_MEMORY_SYSTEM_USER_ID") ?? yaml?.userId?.trim();
  const displayName = env("TDAI_MEMORY_SYSTEM_USER_NAME") ?? yaml?.displayName?.trim() ?? MEMORY_SYSTEM_USERNAME;
  const userKey = env("TDAI_MEMORY_SYSTEM_USER_KEY") ?? yaml?.userKey?.trim();

  if (!userId && !userKey) return undefined;
  if (!userId || !userKey) return undefined;

  return { userId, displayName, userKey };
}

export function validateMemorySystemUserConfig(
  deployMode: MetadataDeployMode,
  config: MemorySystemUserConfig | undefined,
): void {
  if (deployMode !== "service") return;

  if (!config) {
    throw new MetadataStartupValidationError(
      "metadata.systemUser.memory is required when deployMode=service " +
      "(set yaml metadata.systemUser.memory or TDAI_MEMORY_SYSTEM_USER_ID / TDAI_MEMORY_SYSTEM_USER_KEY)",
    );
  }

  const errors: string[] = [];
  if (!config.userId.startsWith(MEMORY_SYSTEM_USER_ID_PREFIX)) {
    errors.push(
      `memory system userId must start with '${MEMORY_SYSTEM_USER_ID_PREFIX}' (got: '${config.userId}')`,
    );
  }
  if (!isValidMemorySystemUserKey(config.userKey)) {
    errors.push("memory system userKey must match sk-mem-[A-Za-z0-9_-]{32}");
  }
  if (!config.displayName.trim()) {
    errors.push("memory system displayName must be non-empty");
  }

  if (errors.length > 0) {
    throw new MetadataStartupValidationError(
      `Memory system user validation failed: ${errors.join("; ")}`,
    );
  }
}

function buildSyntheticUser(
  config: MemorySystemUserConfig,
): UserEntity {
  const now = new Date().toISOString();
  return {
    user_id: config.userId,
    password: null,
    auth_provider: MEMORY_SYSTEM_AUTH_PROVIDER,
    external_id: MEMORY_SYSTEM_EXTERNAL_ID,
    username: MEMORY_SYSTEM_USERNAME,
    display_name: config.displayName,
    email: null,
    raw_profile_json: "{}",
    status: "active",
    user_type: "normal",
    created_at: now,
    updated_at: now,
    metadata_json: "{}",
  };
}

/** Constant-time comparison of userKey; on a hit returns a synthesized UserEntity. */
export function lookupMemorySystemUser(
  userKey: string,
  instanceId: string,
  config: MemorySystemUserConfig | undefined,
): UserEntity | null {
  void instanceId;
  if (!config || !userKey) return null;
  if (!safeEqual(userKey, config.userKey)) return null;
  return buildSyntheticUser(config);
}

/** For Header API auth: the memory key in the config cannot be used as x-tdai-user-key. */
export function isMemorySystemUserKey(
  userKey: string,
  config: MemorySystemUserConfig | undefined,
): boolean {
  if (!config || !userKey) return false;
  return safeEqual(userKey, config.userKey);
}

/** auth/verify external response: hides the internal system marker. */
export function toMemorySystemVerifyUser(user: UserEntity): UserEntity {
  const { password: _pw, auth_provider: _ap, external_id: _ei, ...rest } = user;
  return {
    ...rest,
    auth_provider: "local",
    external_id: user.user_id,
    email: null,
    raw_profile_json: "{}",
    metadata_json: "{}",
  };
}

/** For startup logs: sanitized key prefix. */
export function maskMemorySystemUserKeyForLog(userKey: string): string {
  if (!userKey.startsWith(USER_KEY_PREFIX)) return "****";
  const tail = userKey.slice(-4);
  return `${USER_KEY_PREFIX}****${tail}`;
}
