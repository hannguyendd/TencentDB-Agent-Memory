/**
 * file-logger.ts — local log file writer
 *
 * Dual-writes logs to a local file, supporting:
 * - file rotation (rotate)
 * - backup count limit
 * - automatic directory creation
 * - silent error handling (does not affect the main business flow)
 *
 * Uses synchronous file writes (appendFileSync) to avoid a WriteStream preventing the process from exiting.
 * Log volume is small and infrequent, so the synchronous overhead is negligible.
 */

import fs from "node:fs";
import path from "node:path";

export interface FileLoggerConfig {
  /** Log file directory, e.g. /data/log/. File writing is disabled when empty. */
  path: string;
  /** Log file name, e.g. core.log */
  filename: string;
  /** Max bytes per file; rotates when exceeded */
  rotateSizeBytes: number;
  /** Number of backup files to keep */
  rotateBackupLimit: number;
}

/**
 * FileLogger local log file writer.
 * Implements dual-writing of logs to a local file, with rotate support.
 */
export class FileLogger {
  private cfg: FileLoggerConfig;
  private currentSize = 0;
  private disabled = false;
  private filePath = "";

  constructor(cfg: FileLoggerConfig) {
    this.cfg = cfg;

    // disabled when Path is empty
    if (!cfg.path) {
      this.disabled = true;
      return;
    }

    // set defaults
    if (this.cfg.rotateSizeBytes <= 0) {
      this.cfg.rotateSizeBytes = 100 * 1024 * 1024; // 100MB
    }
    if (this.cfg.rotateBackupLimit <= 0) {
      this.cfg.rotateBackupLimit = 10;
    }

    // try to initialize
    try {
      this.initFile();
    } catch (err) {
      this.disabled = true;
      process.stderr.write(`[file-logger] failed to init log file: ${err}\n`);
    }
  }

  /**
   * write writes one log entry.
   * Format: [time][level] message {json data}\n
   */
  write(level: string, message: string, data?: Record<string, unknown>): void {
    if (this.disabled) {
      return;
    }

    try {
      const line = this.formatLine(level, message, data);
      this.writeLine(line);
    } catch {
      // write failures are handled silently and do not affect the main flow
    }
  }

  /**
   * flush flushes the buffer to disk (a no-op in synchronous write mode, kept for interface compatibility).
   */
  async flush(): Promise<void> {
    // in synchronous write mode the data is already on disk; nothing more to do
  }

  /**
   * close closes (a no-op in synchronous write mode, kept for interface compatibility).
   */
  close(): void {
    // in synchronous write mode there is nothing to close
  }

  // ─── Private methods ───

  private formatLine(level: string, message: string, data?: Record<string, unknown>): string {
    const timestamp = new Date().toISOString();
    let line = `[${timestamp}][${level}] ${message}`;

    if (data && Object.keys(data).length > 0) {
      // sort by key to keep the output stable
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(data).sort()) {
        sorted[key] = data[key];
      }
      line += ` ${JSON.stringify(sorted)}`;
    }

    line += "\n";
    return line;
  }

  private writeLine(line: string): void {
    const lineBytes = Buffer.byteLength(line, "utf-8");

    // check whether rotation is needed
    if (this.currentSize + lineBytes > this.cfg.rotateSizeBytes) {
      this.rotate();
    }

    // synchronous append write
    fs.appendFileSync(this.filePath, line, "utf-8");
    this.currentSize += lineBytes;
  }

  private initFile(): void {
    // automatically create the directory
    fs.mkdirSync(this.cfg.path, { recursive: true });

    this.filePath = path.join(this.cfg.path, this.cfg.filename);

    // get the current file size
    try {
      const stat = fs.statSync(this.filePath);
      this.currentSize = stat.size;
    } catch {
      this.currentSize = 0;
    }
  }

  private rotate(): void {
    try {
      this.currentSize = 0;

      // rename the current file to a backup (with timestamp)
      const now = new Date();
      const ts = now.toISOString().replace(/[:.]/g, "").replace("T", "_").replace("Z", "");
      const backupName = `${this.cfg.filename}.${ts}`;
      const backupPath = path.join(this.cfg.path, backupName);

      try {
        fs.renameSync(this.filePath, backupPath);
      } catch {
        // rename failure does not affect subsequent steps
      }

      // clean up old backups beyond the limit
      this.cleanOldBackups();
    } catch (err) {
      this.disabled = true;
      process.stderr.write(`[file-logger] failed to rotate: ${err}\n`);
    }
  }

  private cleanOldBackups(): void {
    try {
      const entries = fs.readdirSync(this.cfg.path);
      const prefix = this.cfg.filename + ".";

      const backups = entries
        .filter((name) => name.startsWith(prefix) && name !== this.cfg.filename)
        .sort(); // timestamp is in the suffix, so lexicographic order is chronological order

      if (backups.length > this.cfg.rotateBackupLimit) {
        const toDelete = backups.slice(0, backups.length - this.cfg.rotateBackupLimit);
        for (const name of toDelete) {
          try {
            fs.unlinkSync(path.join(this.cfg.path, name));
          } catch {
            // delete failures are handled silently
          }
        }
      }
    } catch {
      // handled silently
    }
  }
}
