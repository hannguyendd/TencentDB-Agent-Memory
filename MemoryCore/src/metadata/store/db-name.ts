/**
 * Resolve the metadata database name per instance (v3.0 database-level isolation).
 * MongoDB database / SQLite directory names are both {mongoDbPrefix}_{sanitized_id}.
 */

/** Default value when `mongoDbPrefix` / `TDAI_METADATA_MONGO_DB_PREFIX` is not configured. */
export const DEFAULT_METADATA_DB_PREFIX = "tdai_metadata";

export class InvalidInstanceIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidInstanceIdError";
  }
}

/** Illegal characters in MongoDB database names → `_` */
export function sanitizeInstanceIdForDb(instanceId: string): string {
  return instanceId
    .trim()
    .replace(/[/\\."$ \0]/g, "_");
}

function normalizeDbPrefix(dbPrefix?: string): string {
  const trimmed = dbPrefix?.trim();
  return trimmed || DEFAULT_METADATA_DB_PREFIX;
}

/**
 * Resolve the logical database name, e.g. `tdai_metadata_default`.
 * @throws InvalidInstanceIdError if empty or empty after normalization
 */
export function resolveMetadataDbName(
  instanceId: string,
  dbPrefix: string = DEFAULT_METADATA_DB_PREFIX,
): string {
  const prefix = normalizeDbPrefix(dbPrefix);
  const sanitized = sanitizeInstanceIdForDb(instanceId);
  if (!sanitized) {
    throw new InvalidInstanceIdError("instance_id is empty or invalid after sanitization");
  }
  const maxInstanceLen = 64 - prefix.length - 1;
  const truncated = sanitized.slice(0, maxInstanceLen);
  return `${prefix}_${truncated}`;
}

/** SQLite: {baseDir}/{dbName}/metadata.db */
export function resolveSqliteDbPath(
  baseDir: string,
  instanceId: string,
  dbPrefix?: string,
): string {
  const dbName = resolveMetadataDbName(instanceId, dbPrefix);
  return `${baseDir.replace(/\/$/, "")}/${dbName}/metadata.db`;
}

/** SQLite instance database directory (recursively deleted on destroy) */
export function resolveSqliteDbDir(
  baseDir: string,
  instanceId: string,
  dbPrefix?: string,
): string {
  const dbName = resolveMetadataDbName(instanceId, dbPrefix);
  return `${baseDir.replace(/\/$/, "")}/${dbName}`;
}
