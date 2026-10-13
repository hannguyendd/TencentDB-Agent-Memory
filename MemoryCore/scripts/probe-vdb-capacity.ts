/**
 * One-off investigation script (**read-only**): counts the VDB databases and collection usage, to locate the source of the collection-count overrun.
 *
 * Background: the VDB instance has a collection cap of 1500. Each memory database takes up 8 collections, and before creating a new database one needs to
 * confirm there is headroom, otherwise createCollection fails with code=15129 and the store enters degraded
 * mode, causing all subsequent writes to fail silently (actually hit in practice).
 *
 * This script performs no creation/deletion and only outputs statistics, for humans to decide which databases to clean up.
 */
import { TcvdbClient } from "../src/core/store/tcvdb/client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;

if (!VDB_URL || !VDB_API_KEY) {
  console.error("Environment variables VDB_URL / VDB_API_KEY are required");
  process.exit(2);
}

const silent = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

async function main() {
  const client = new TcvdbClient({
    url: VDB_URL!,
    username: process.env.VDB_USERNAME ?? "root",
    apiKey: VDB_API_KEY!,
    database: process.env.VDB_DATABASE ?? "default",
    timeout: 30_000,
    logger: silent,
  });

  // TcvdbClient does not wrap a list endpoint, so call the underlying request directly (read-only)
  const dbResp = await client.request<{ databases?: string[] }>("/database/list", {});
  const dbs = dbResp.databases ?? [];
  console.log(`Total databases: ${dbs.length}`);

  const counts: Array<{ db: string; n: number }> = [];
  let total = 0;
  for (const db of dbs) {
    try {
      const r = await client.request<{ collections?: Array<{ collection?: string }> }>(
        "/collection/list", { database: db },
      );
      const n = (r.collections ?? []).length;
      counts.push({ db, n });
      total += n;
    } catch {
      counts.push({ db, n: -1 }); // no permission or an error
    }
  }

  console.log(`Total collections: ${total} / 1500 (headroom ${1500 - total})`);

  const leftovers = counts.filter((c) => c.db.startsWith("clearverify-"));
  console.log(`\nLeftover databases clearverify-* from this verification script: ${leftovers.length}`);
  for (const c of leftovers) console.log(`  ${c.db}  (${c.n} collections)`);

  counts.sort((a, b) => b.n - a.n);
  console.log("\nTop 15 by collection count:");
  for (const c of counts.slice(0, 15)) {
    console.log(`  ${String(c.n).padStart(5)}  ${c.db}`);
  }
}

main().catch((err) => {
  console.error("probe failed:", err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
