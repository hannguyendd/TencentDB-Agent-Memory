/**
 * SkillResourceStore — resource byte read/write (files/ subtree only)
 *
 * Differences from the old SkillContentManager:
 *   - the path key is changed to `<skill_id>/v<version>/files/<relative_path>` (no longer uses name)
 *   - no longer manages SKILL.md (the DB is the authoritative source)
 *   - the manifest is listed directly from disk by `listResources` (no DB sync needed)
 *
 * Design doc correspondence: §2.4 physical storage layout; §3.5.9~3.5.11 interfaces.
 */

import type { StorageAdapter } from "../storage/adapter.js";
import type { SkillManifestEntry } from "./types.js";

const STORAGE_PREFIX = "skills/";
const FILES_SUBDIR = "files";
const DEFAULT_MAX_RESOURCE_SIZE_BYTES = 5_000_000;
const DEFAULT_MAX_SKILL_TOTAL_BYTES = 50_000_000;

export type ResourceErrorCode = "INVALID_PATH" | "RESOURCE_TOO_LARGE";

export class SkillResourceError extends Error {
  constructor(public readonly code: ResourceErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = "SkillResourceError";
  }
}

export interface SkillResourcePayload {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  mime_type?: string;
  is_executable?: boolean;
}

export interface SkillResourceReadResult {
  path: string;
  content: string;
  encoding: "utf-8" | "base64";
  size_bytes: number;
  mime_type: string;
  is_executable: boolean;
  version: number;
}

export interface SkillResourceStoreOptions {
  storage: StorageAdapter;
  maxResourceSizeBytes?: number;
  /** Upper limit on the total resource size of an entire skill. Default 50 MB (design §3.5.1). */
  maxSkillTotalBytes?: number;
}

export class SkillResourceStore {
  private readonly storage: StorageAdapter;
  private readonly maxBytes: number;
  private readonly maxTotalBytes: number;

  constructor(opts: SkillResourceStoreOptions) {
    this.storage = opts.storage;
    this.maxBytes = opts.maxResourceSizeBytes ?? DEFAULT_MAX_RESOURCE_SIZE_BYTES;
    this.maxTotalBytes = opts.maxSkillTotalBytes ?? DEFAULT_MAX_SKILL_TOTAL_BYTES;
  }

  /** Upper limit on the total bytes of an entire skill (for external reference before aggregate validation). */
  getMaxSkillTotalBytes(): number {
    return this.maxTotalBytes;
  }

  /**
   * Estimate the decoded byte size of a payload, without writing to disk.
   * Used by SkillVersioning for aggregate total-size validation of the entire skill before persisting.
   */
  estimatePayloadSize(payload: SkillResourcePayload): number {
    return decodeContent(payload.content, payload.encoding).length;
  }

  /**
   * Aggregate validation: current manifest + newly written - deleted/overwritten ≤ maxTotalBytes.
   * Over the limit throws RESOURCE_TOO_LARGE, called by versioning before persisting.
   */
  assertTotalSize(
    currentManifest: SkillManifestEntry[],
    toWrite: SkillResourcePayload[] = [],
    toRemove: string[] = [],
  ): void {
    const removed = new Set(toRemove);
    const writePaths = new Set(toWrite.map((p) => p.path));
    let total = 0;
    for (const m of currentManifest) {
      if (removed.has(m.path)) continue;
      if (writePaths.has(m.path)) continue; // will be replaced
      total += m.size_bytes;
    }
    for (const p of toWrite) {
      total += this.estimatePayloadSize(p);
    }
    if (total > this.maxTotalBytes) {
      throw new SkillResourceError(
        "RESOURCE_TOO_LARGE",
        `total skill size ${total} bytes exceeds max ${this.maxTotalBytes} bytes`,
      );
    }
  }

  /** Write resource bytes, validating path and size. If the path already exists it is overwritten. */
  async writeResource(skillId: string, version: number, payload: SkillResourcePayload): Promise<SkillManifestEntry> {
    this.assertPath(payload.path);
    const buf = decodeContent(payload.content, payload.encoding);
    if (buf.length > this.maxBytes) {
      throw new SkillResourceError(
        "RESOURCE_TOO_LARGE",
        `${payload.path} (${buf.length} bytes) exceeds max ${this.maxBytes} bytes`,
      );
    }
    const key = this.fileKey(skillId, version, payload.path);
    const mime = payload.mime_type ?? guessMime(payload.path);
    const isExec = payload.is_executable ?? false;
    // write directly with backend.putObject to preserve metadata (is_executable)
    await this.storage.getBackend().putObject(key, buf, {
      contentType: mime,
      metadata: { is_executable: isExec ? "1" : "0" },
    });
    return {
      path: payload.path,
      size_bytes: buf.length,
      mime_type: mime,
      is_executable: isExec,
    };
  }

  /** Read resource bytes; not present → null. */
  async readResource(
    skillId: string,
    version: number,
    path: string,
    encoding: "utf-8" | "base64",
  ): Promise<SkillResourceReadResult | null> {
    this.assertPath(path);
    const key = this.fileKey(skillId, version, path);
    const buf = await this.storage.readFileBuffer(key);
    if (!buf) return null;
    return {
      path,
      content: encoding === "base64" ? buf.toString("base64") : buf.toString("utf-8"),
      encoding,
      size_bytes: buf.length,
      mime_type: guessMime(path),
      is_executable: false, // not inferred from storage metadata (local-fs and COS behave inconsistently)
      version,
    };
  }

  /** Delete a resource (idempotent: no error if it does not exist). */
  async removeResource(skillId: string, version: number, path: string): Promise<void> {
    this.assertPath(path);
    const key = this.fileKey(skillId, version, path);
    try {
      await this.storage.unlink(key);
    } catch {
      /* idempotent */
    }
  }

  /** List the metadata of all resources under a version directory (without bytes). */
  async listResources(skillId: string, version: number): Promise<SkillManifestEntry[]> {
    const prefix = this.filesPrefix(skillId, version);
    const result = await this.storage.getBackend().listObjects(prefix, {
      recursive: true,
      maxKeys: 100_000,
    });
    const out: SkillManifestEntry[] = [];
    for (const e of result.entries) {
      if (e.isDirectory) continue;
      const path = e.key.startsWith(prefix) ? e.key.slice(prefix.length) : e.key;
      // read the metadata to get is_executable / contentType (much cheaper than reading the bytes)
      const obj = await this.storage.getBackend().getObject(e.key);
      const isExec = obj?.metadata?.is_executable === "1";
      const mime = obj?.contentType ?? guessMime(path);
      out.push({
        path,
        size_bytes: e.size,
        mime_type: mime,
        is_executable: isExec,
      });
    }
    return out;
  }

  /** Get the relative prefix of that version directory, for skill-versioning to call storage.copyTree. */
  versionDir(skillId: string, version: number): string {
    return `${STORAGE_PREFIX}${skillId}/v${version}`;
  }

  // ── helpers ──

  private fileKey(skillId: string, version: number, path: string): string {
    return `${this.filesPrefix(skillId, version)}${path}`;
  }

  private filesPrefix(skillId: string, version: number): string {
    return `${this.versionDir(skillId, version)}/${FILES_SUBDIR}/`;
  }

  private assertPath(path: string): void {
    if (!path) throw new SkillResourceError("INVALID_PATH", "empty path");
    if (path.startsWith("/") || path.startsWith("\\"))
      throw new SkillResourceError("INVALID_PATH", `absolute path not allowed: ${path}`);
    if (path.includes("\0"))
      throw new SkillResourceError("INVALID_PATH", `NUL not allowed: ${path}`);
    // ".." segment guards against escaping
    const segs = path.split(/[\\/]/);
    if (segs.some((s) => s === "..")) {
      throw new SkillResourceError("INVALID_PATH", `traversal not allowed: ${path}`);
    }
  }
}

// ═════════════════════════════════════════════════════════════════════
//  Standalone utilities
// ═════════════════════════════════════════════════════════════════════

function decodeContent(content: string, encoding: "utf-8" | "base64"): Buffer {
  return encoding === "base64" ? Buffer.from(content, "base64") : Buffer.from(content, "utf-8");
}

const MIME_BY_EXT: Record<string, string> = {
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".ts": "application/typescript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".yml": "application/yaml",
  ".yaml": "application/yaml",
  ".py": "text/x-python",
  ".html": "text/html",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
};

function guessMime(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx < 0) return "application/octet-stream";
  const ext = path.slice(idx).toLowerCase();
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}
