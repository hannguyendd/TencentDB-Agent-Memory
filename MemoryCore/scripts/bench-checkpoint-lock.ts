/**
 * Write-throughput benchmark after adding a distributed lock to checkpoint.
 *
 * Purpose: quantify how much QPS can be supported after "adding an instance-level lock to checkpoint mutate",
 * and at what concurrency/data scale it becomes the bottleneck of the L1 pipeline.
 *
 * Uses a real CheckpointManager + a real Redis lock + real COS/local storage,
 * with the backend chosen via environment variables:
 *   REDIS_HOST/REDIS_PORT/REDIS_PASSWORD  → real Redis lock (uses an in-process lock if unset)
 *
 * Run:
 *   npx tsx scripts/bench-checkpoint-lock.ts [--sessions 500] [--concurrency 60]
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { CheckpointManager, type CheckpointDistributedLock } from "../src/utils/checkpoint.js";

interface BenchResult {
  label: string;
  ops: number;
  elapsedMs: number;
  qps: number;
  p50: number;
  p95: number;
  p99: number;
  existingSessions: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

/** Real Redis lock (if REDIS_HOST is configured) */
async function createRedisLock(): Promise<{ lock: CheckpointDistributedLock; close: () => Promise<void> } | null> {
  const host = process.env.REDIS_HOST;
  if (!host) return null;

  const { default: Redis } = await import("ioredis");
  const client = new Redis({
    host,
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: 2,
  });

  const lock: CheckpointDistributedLock = {
    async acquireLock(key, ownerId, ttlMs) {
      const res = await client.set(`bench:lock:${key}`, ownerId, "PX", ttlMs, "NX");
      return res === "OK";
    },
    async renewLock(key, ownerId, ttlMs) {
      // Only renew a lock held by itself (consistent with the production Redis backend semantics)
      const res = await client.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end`,
        1,
        `bench:lock:${key}`,
        ownerId,
        String(ttlMs),
      );
      return res === 1;
    },
    async releaseLock(key, ownerId) {
      // Only release a lock held by itself (consistent with the production Redis backend semantics)
      await client.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
        1,
        `bench:lock:${key}`,
        ownerId,
      );
    },
  };

  return { lock, close: async () => { await client.quit(); } };
}

/**
 * @param sessions total number of submissions (each = one markL1ExtractionComplete)
 * @param concurrency number of concurrent coroutines
 * @param preload how many sessions to write in advance, to test the effect of file size on throughput
 */
async function bench(opts: {
  label: string;
  sessions: number;
  concurrency: number;
  preload: number;
  lock: CheckpointDistributedLock | null;
}): Promise<BenchResult> {
  const dir = await mkdtemp(join(tmpdir(), "cp-bench-"));
  try {
    const lockOptions = opts.lock
      ? { lock: opts.lock, lockKey: `bench-${Math.random().toString(36).slice(2, 8)}`, ttlMs: 15_000, maxWaitMs: 60_000 }
      : undefined;
    const mgr = new CheckpointManager(dir, undefined, undefined, lockOptions);

    // Pre-fill: simulate a checkpoint that already has a large number of sessions
    for (let i = 0; i < opts.preload; i++) {
      await mgr.markL1ExtractionComplete(`preload-sess-${i}`, 1, 1_700_000_000_000 + i, "scene");
    }

    const latencies: number[] = [];
    let cursor = 0;
    const started = Date.now();

    async function workerLoop() {
      for (;;) {
        const idx = cursor++;
        if (idx >= opts.sessions) return;
        const t0 = Date.now();
        await mgr.markL1ExtractionComplete(`bench-sess-${idx}`, 1, 1_800_000_000_000 + idx, "scene");
        latencies.push(Date.now() - t0);
      }
    }

    await Promise.all(Array.from({ length: opts.concurrency }, () => workerLoop()));
    const elapsedMs = Date.now() - started;
    latencies.sort((a, b) => a - b);

    return {
      label: opts.label,
      ops: opts.sessions,
      elapsedMs,
      qps: (opts.sessions / elapsedMs) * 1000,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      existingSessions: opts.preload,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function printTable(rows: BenchResult[]) {
  console.log(
    "\n  scenario                | existing |  ops | elapsed |QPS |  p50 |  p95 |  p99",
  );
  console.log(
    "  ---------------------------------|----------|------|---------|--------|------|------|-----",
  );
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(32)} | ${String(r.existingSessions).padStart(8)} | ` +
        `${String(r.ops).padStart(4)} | ${String(r.elapsedMs + "ms").padStart(7)} | ` +
        `${r.qps.toFixed(0).padStart(6)} | ${String(r.p50).padStart(4)} | ` +
        `${String(r.p95).padStart(4)} | ${String(r.p99).padStart(4)}`,
    );
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      sessions: { type: "string", default: "300" },
      concurrency: { type: "string", default: "60" },
    },
  });
  const sessions = Number(values.sessions);
  const concurrency = Number(values.concurrency);

  const redis = await createRedisLock();
  const lock = redis?.lock ?? null;
  console.log(
    `checkpoint lock benchmark — lock backend: ${redis ? "real Redis" : "in-process only"}`,
  );

  try {
    const rows: BenchResult[] = [];

    // 1) Concurrency gradient: observe throughput and latency under lock contention
    for (const c of [1, 10, 30, 60, 120]) {
      rows.push(await bench({
        label: `concurrency=${c}`,
        sessions,
        concurrency: c,
        preload: 0,
        lock,
      }));
    }
    printTable(rows);

    // 2) File size gradient: observe the effect of runner_states growth on a single mutate
    const sizeRows: BenchResult[] = [];
    for (const preload of [0, 500, 2000, 5000]) {
      sizeRows.push(await bench({
        label: `preloaded sessions=${preload}`,
        sessions: 100,
        concurrency,
        preload,
        lock,
      }));
    }
    printTable(sizeRows);

    // 3) Conclusion hint
    const peak = rows.reduce((a, b) => (b.qps > a.qps ? b : a));
    console.log(
      `\n  Peak throughput ≈ ${peak.qps.toFixed(0)} QPS (${peak.label})`,
    );
    console.log(
      "  An L1 single task with LLM calls usually takes 3-30s; with concurrency=60, " +
      `checkpoint write demand ≈ ${(60 / 5).toFixed(0)} QPS, far below the peak above.`,
    );
  } finally {
    await redis?.close();
  }
}

void main();
