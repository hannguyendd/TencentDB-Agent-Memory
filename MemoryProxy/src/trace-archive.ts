/**
 * Trace archive -- local JSONL cold storage.
 *
 * Each trace + span is written as a JSONL line to a local file, one file per date.
 * Can be combined with a crontab script to periodically compress and upload to COS/S3 archive storage.
 *
 * Design:
 *  - Uses WriteStream for async buffered writes, without blocking the event loop
 *  - Isolates archive files of multiple instances by hostname
 *  - Backpressure handling: pause writes when the buffer is full, resume after drain
 *  - Controlled by the config option `traceArchive.enabled`, off by default
 */

import { createWriteStream, mkdirSync, existsSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { log } from "./report/log.js";

/** Host identifier for multi-instance isolation. */
const HOST_ID = hostname();

/** Default directory for archive files */
const DEFAULT_ARCHIVE_DIR = "logs/traces";

/** Shutdown timeout (ms) -- prevents end() from hanging */
const SHUTDOWN_TIMEOUT_MS = 5000;

/** WriteStream highWaterMark (bytes) — 64KB buffer */
const HIGH_WATER_MARK = 64 * 1024;

let archiveDir = "";
let enabled = false;
let currentDate = "";
let currentStream: WriteStream | null = null;
let warnedDisabled = false;
let backpressure = false;
let droppedLines = 0;

// ── Public types ─────────────────────────────────────────────────────────────

/** Configuration for trace archive. */
export interface TraceArchiveConfig {
  /** Master switch -- whether to enable local JSONL archiving. Defaults to false (off). */
  enabled: boolean;
  /** Archive directory (relative to the project root or an absolute path). Defaults to "logs/traces". */
  dir: string;
}

/** Archived trace event shape (trace create). */
export interface ArchivedTrace {
  type: "trace";
  id: string;
  name: string;
  projectName: string;
  startTime: string;
  input: unknown;
  tags?: string[];
}

/** Archived span event shape (LLM span). */
export interface ArchivedSpan {
  type: "span";
  id: string;
  traceId: string;
  name: string;
  projectName: string;
  model: string;
  startTime: string;
  endTime: string;
  input: unknown;
  output: unknown;
  usage: Record<string, unknown>;
  tags?: string[];
}

// ── Lifecycle ────────────────────────────────────────────────────────────────

/**
 * initTraceArchive initializes the trace archive system.
 * Writing is only actually enabled when config.enabled === true.
 *
 * @param baseDir project root directory (used to resolve relative paths)
 * @param config  TraceArchive config
 */
export function initTraceArchive(baseDir: string, config: TraceArchiveConfig): void {
  if (!config.enabled) {
    log.info("trace_archive.disabled");
    return;
  }

  const dir = config.dir || DEFAULT_ARCHIVE_DIR;
  archiveDir = resolve(baseDir, dir);
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
  enabled = true;
  log.info("trace_archive.init", { dir: archiveDir, host: HOST_ID });
}

/**
 * shutdownTraceArchive closes the archive write stream, ensuring data is flushed to disk.
 * Called on graceful shutdown. A timeout fallback prevents hanging.
 */
export function shutdownTraceArchive(): Promise<void> {
  if (droppedLines > 0) {
    log.warn("trace_archive.dropped_lines", { count: droppedLines });
  }

  return new Promise((resolvePromise) => {
    if (!currentStream) {
      resolvePromise();
      return;
    }

    const stream = currentStream;
    currentStream = null;
    enabled = false;

    // Timeout fallback: force resolve if not finished within 5 seconds
    const timer = setTimeout(() => {
      log.warn("trace_archive.shutdown_timeout", { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      stream.destroy();
      resolvePromise();
    }, SHUTDOWN_TIMEOUT_MS);

    stream.on("error", () => {
      clearTimeout(timer);
      resolvePromise();
    });

    stream.end(() => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

// ── Internal ─────────────────────────────────────────────────────────────────

/**
 * getOrCreateStream returns the write stream for the current date.
 * Automatically closes the old stream and creates a new one when the day rolls over.
 */
function getOrCreateStream(): WriteStream | null {
  if (!enabled) return null;

  const today = new Date().toISOString().slice(0, 10);
  if (today !== currentDate) {
    // Day rollover: close the old stream (fire-and-forget; old stream data is flushed asynchronously)
    if (currentStream) {
      const oldStream = currentStream;
      oldStream.end();
    }
    currentDate = today;
    backpressure = false;
    const filePath = join(archiveDir, `${HOST_ID}-${today}.jsonl`);
    currentStream = createWriteStream(filePath, {
      flags: "a",
      encoding: "utf-8",
      highWaterMark: HIGH_WATER_MARK,
    });
    currentStream.on("error", (err) => {
      log.warn("trace_archive.stream_error", { error: err.message });
    });
    currentStream.on("drain", () => {
      backpressure = false;
    });
  }
  return currentStream;
}

/**
 * archiveLine appends one JSON line to the archive file.
 * Uses WriteStream for async buffered writes, without blocking the event loop.
 * Handles backpressure: drops new data when the buffer is full and records a count.
 */
function archiveLine(line: string): void {
  if (!enabled) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      // If the caller invokes this while disabled, skip silently (config default off is the normal case)
    }
    return;
  }

  // Backpressure: drop when the buffer is full (best-effort archive)
  if (backpressure) {
    droppedLines++;
    return;
  }

  const stream = getOrCreateStream();
  if (stream) {
    const ok = stream.write(line + "\n");
    if (!ok) {
      backpressure = true;
    }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * archiveTrace archives a trace creation event.
 * Exception-safe: JSON.stringify or write failures never throw.
 * No-op when traceArchive.enabled = false.
 */
export function archiveTrace(trace: ArchivedTrace): void {
  if (!enabled) return;
  try {
    archiveLine(JSON.stringify(trace));
  } catch (err: unknown) {
    log.warn("trace_archive.serialize_error", {
      type: "trace",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * archiveSpan archives an LLM span event.
 * Exception-safe: JSON.stringify or write failures never throw.
 * No-op when traceArchive.enabled = false.
 */
export function archiveSpan(span: ArchivedSpan): void {
  if (!enabled) return;
  try {
    archiveLine(JSON.stringify(span));
  } catch (err: unknown) {
    log.warn("trace_archive.serialize_error", {
      type: "span",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
