/**
 * FsStorage -- the local filesystem implementation of ProxyStorage.
 *
 * Positioning: offline/private deployments or docker read-only fallback. Not recommended for production (a directory shared by multiple processes races).
 *
 * Semantics:
 *   - key is a relative path; absolute paths / path traversal are forbidden (security guard)
 *   - putText/putJSON use tmp + rename for atomicity; putIfAbsent uses O_EXCL for CAS
 *   - directories are created automatically
 *
 * TTL: no sweeper implemented (`fs.stat().mtime` is unreliable on some container filesystems) --
 * cleanup is left to ops via tmpwatch / systemd-tmpfiles. See plan section 3.3.3.
 */
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { ProxyStorage } from "./proxy-storage.js";

export class FsStorage implements ProxyStorage {
  readonly type = "fs" as const;

  constructor(private readonly root: string) {}

  private resolve(key: string): string {
    if (!key || key.length === 0) throw new Error(`[fs-storage] invalid empty key`);
    if (isAbsolute(key)) throw new Error(`[fs-storage] absolute path not allowed: ${key}`);
    const normalized = normalize(key);
    if (normalized.startsWith("..") || normalized.split(sep).includes("..")) {
      throw new Error(`[fs-storage] path traversal not allowed: ${key}`);
    }
    const full = join(this.root, normalized);
    // Double check: the resolved path must stay inside root.
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error(`[fs-storage] path escapes root: ${key}`);
    }
    return full;
  }

  private async ensureDir(filePath: string): Promise<void> {
    await fs.mkdir(dirname(filePath), { recursive: true });
  }

  async putText(key: string, value: string): Promise<void> {
    const full = this.resolve(key);
    await this.ensureDir(full);
    // atomic write: tmp + rename
    const tmp = full + "." + randomBytes(6).toString("hex") + ".tmp";
    await fs.writeFile(tmp, value, "utf-8");
    await fs.rename(tmp, full);
  }

  async putJSON(key: string, value: unknown): Promise<void> {
    return this.putText(key, JSON.stringify(value));
  }

  async putTextIfAbsent(key: string, value: string): Promise<boolean> {
    const full = this.resolve(key);
    await this.ensureDir(full);
    try {
      const handle = await fs.open(full, "wx"); // O_CREAT | O_EXCL
      try {
        await handle.writeFile(value, "utf-8");
      } finally {
        await handle.close();
      }
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  async putJSONIfAbsent(key: string, value: unknown): Promise<boolean> {
    return this.putTextIfAbsent(key, JSON.stringify(value));
  }

  async getText(key: string): Promise<string | null> {
    const full = this.resolve(key);
    try {
      return await fs.readFile(full, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async getJSON<T>(key: string): Promise<T | null> {
    const raw = await this.getText(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  async exists(key: string): Promise<boolean> {
    const full = this.resolve(key);
    try {
      await fs.access(full);
      return true;
    } catch {
      return false;
    }
  }

  async del(key: string): Promise<void> {
    const full = this.resolve(key);
    try {
      await fs.unlink(full);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  async delPrefix(prefix: string): Promise<number> {
    // prefix is in directory form; treat it as a directory and rmdir -r. To count deletions, list first, then unlink one by one.
    const names = await this.listNames(prefix);
    let n = 0;
    for (const name of names) {
      await this.del(prefix + name);
      n++;
    }
    // Also clean up empty directories (best-effort); does not affect the count.
    try {
      const fullPrefixDir = this.resolve(prefix.replace(/\/+$/, "") || ".");
      await fs.rm(fullPrefixDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    return n;
  }

  async listNames(prefix: string): Promise<string[]> {
    // prefix usually ends with "/", representing a directory; otherwise treat it as a "directory basename" filter.
    const dirPart = prefix.endsWith("/") ? prefix : prefix + "/";
    let dirAbs: string;
    try {
      dirAbs = this.resolve(dirPart.replace(/\/+$/, "") || ".");
    } catch {
      return [];
    }
    const out: string[] = [];
    await this.walk(dirAbs, "", out);
    return out;
  }

  private async walk(absDir: string, relPrefix: string, out: string[]): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const e of entries) {
      const relName = relPrefix + e.name;
      if (e.isDirectory()) {
        await this.walk(join(absDir, e.name), relName + "/", out);
      } else {
        out.push(relName);
      }
    }
  }
}
