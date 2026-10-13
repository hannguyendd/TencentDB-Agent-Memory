/**
 * TCVDB **real-machine** verification: the delete semantics and guardrails of clearMemoryContent / deleteL0BySession.
 *
 * Difference from mock unit tests: this connects to a real VDB and verifies VDB's own behavior, rather than our
 * assumptions about it. It focuses on confirming several things previously only inferred:
 *   1. when the filter is non-empty, delete only removes the matching documents and does not affect other teams/agents
 *   2. the empty-value / empty-session guardrails really take effect on the real-machine path, and no delete request is sent
 *   3. writing can continue after clearing, and repeated clearing is idempotent
 *
 * Safety conventions:
 *   - operate in a **separate temporary database** (name with timestamp + PID), without touching any existing database
 *   - drop the whole temporary database in finally, leaving nothing behind even on failure
 *   - credentials are read only from environment variables, never written to disk or printed
 *
 * Prerequisite: the VDB instance has a collection cap of 1500, and each memory database takes 8 collections.
 * If headroom is insufficient, createCollection fails with code=15129 and the store enters degraded mode,
 * causing subsequent writes to fail silently. First check the headroom with scripts/probe-vdb-capacity.ts.
 *
 * Run (first source .env.devcloud to provide VDB_URL / VDB_API_KEY):
 *   node --import tsx scripts/verify-tcvdb-clear.ts
 */
import { TcvdbMemoryStore } from "../src/core/store/tcvdb/memory-store.js";
import { TcvdbClient } from "../src/core/store/tcvdb/client.js";

const VDB_URL = process.env.VDB_URL;
const VDB_API_KEY = process.env.VDB_API_KEY;
const VDB_USERNAME = process.env.VDB_USERNAME ?? "root";

if (!VDB_URL || !VDB_API_KEY) {
  console.error("Environment variables VDB_URL / VDB_API_KEY are required (do not put them in code or command-line history)");
  process.exit(2);
}

/** Separate temporary database: with timestamp + PID, to avoid conflicts with any existing database or concurrent instance. */
const TMP_DB = `clearverify-${Date.now().toString(36)}-${process.pid}`;

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {},
  error: (m: string) => console.error(`  [store-error] ${m}`),
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
  else { console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); fail++; }
}

interface Scope { teamId: string; agentId: string; userId: string; sessionId: string }

/** Two mutually independent scopes, used to verify "clearing A does not affect B". */
const A: Scope = { teamId: "vt-a", agentId: "agt-a", userId: "vu-a", sessionId: "vs-a" };
const B: Scope = { teamId: "vt-b", agentId: "agt-b", userId: "vu-b", sessionId: "vs-b" };
/** Same team as A but a different agent -- verifies agent-granularity isolation. */
const A2: Scope = { teamId: "vt-a", agentId: "agt-a2", userId: "vu-a", sessionId: "vs-a2" };

function l0(scope: Scope, id: string, text: string) {
  return {
    id,
    sessionKey: scope.sessionId,
    sessionId: scope.sessionId,
    teamId: scope.teamId,
    taskId: "",
    userId: scope.userId,
    agentId: scope.agentId,
    role: "user",
    messageText: text,
    recordedAt: new Date().toISOString(),
    timestamp: Date.now(),
  };
}

/** Create an L1 record (structure aligned with MemoryRecord). */
function l1(scope: Scope, id: string, content: string) {
  const now = new Date().toISOString();
  return {
    id,
    content,
    type: "episodic" as const,
    priority: 50,
    scene_name: "verify",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 1,
    sessionKey: scope.sessionId,
    sessionId: scope.sessionId,
    teamId: scope.teamId,
    userId: scope.userId,
    agentId: scope.agentId,
    taskId: "",
  };
}

/** L1 count: counted by (team, agent, user), consistent with the scope of clearMemoryContent. */
async function countL1(store: TcvdbMemoryStore, scope: Scope): Promise<number> {
  return store.countL1({
    teamId: scope.teamId, agentId: scope.agentId, userId: scope.userId,
  });
}

/** Poll until L1 reaches the expected count. */
async function waitCountL1(
  store: TcvdbMemoryStore, scope: Scope, want: number, timeoutMs = 25_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await countL1(store, scope);
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/** There is a seconds-level delay from VDB write to queryable; poll until the expected count (or return the actual value after a timeout). */
async function waitCount(
  store: TcvdbMemoryStore, scope: Scope, want: number, timeoutMs = 25_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = -1;
  while (Date.now() < deadline) {
    last = await store.countL0({
      teamId: scope.teamId, agentId: scope.agentId,
      userId: scope.userId, sessionId: scope.sessionId,
    });
    if (last === want) return last;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

/** Guardrail assertions: do not depend on data in the database; should hold under any schema. */
async function runGuardChecks(store: TcvdbMemoryStore): Promise<void> {
  console.log("\n4. Empty-value guardrails (must be rejected before a delete request is sent)");
  for (const bad of [
    { teamId: "", agentId: "agt-x" },
    { teamId: "vt-x", agentId: "" },
    { teamId: "  ", agentId: "  " },
  ]) {
    let threw = false;
    try { await store.clearMemoryContent(bad); } catch { threw = true; }
    check(`clearMemoryContent rejects teamId="${bad.teamId}" agentId="${bad.agentId}"`, threw);
  }
  for (const badSid of ["", "   "]) {
    let threw = false;
    try { await store.deleteL0BySession(badSid, { teamId: "vt-x", agentId: "agt-x" }); }
    catch { threw = true; }
    check(`deleteL0BySession rejects an empty sessionId ("${badSid}")`, threw);
  }
}

async function main() {
  const store = new TcvdbMemoryStore({
    url: VDB_URL!,
    username: VDB_USERNAME,
    apiKey: VDB_API_KEY!,
    database: TMP_DB,
    embeddingModel: "bge-base-zh",
    timeout: 30_000,
    logger: silentLogger,
  });

  console.log(`\nTemporary database: ${TMP_DB} (deleted automatically after the run)`);
  await store.init();

  if ((store as unknown as { degraded: boolean }).degraded) {
    console.error(
      "\n✗ store is in degraded mode; collection creation failed.\n" +
      "  Common cause: the VDB instance collection count has reached the cap of 1500.\n" +
      "  First run scripts/probe-vdb-capacity.ts to check the headroom.\n",
    );
    process.exit(1);
  }

  try {
    console.log("\nPreparing data (L0 + L1)");
    for (let i = 0; i < 3; i++) await store.upsertL0(l0(A, `rec-a-${i}`, `A msg ${i}`), undefined);
    for (let i = 0; i < 2; i++) await store.upsertL0(l0(B, `rec-b-${i}`, `B msg ${i}`), undefined);
    await store.upsertL0(l0(A2, "rec-a2-0", "A2 msg"), undefined);

    // L1: this is the focus this round -- previously only L0 was written, and the L1 delete path was never truly verified
    let l1WriteOk = true;
    for (let i = 0; i < 2; i++) {
      l1WriteOk = (await store.upsertL1(l1(A, `mem-a-${i}`, `A memory ${i}`))) && l1WriteOk;
    }
    l1WriteOk = (await store.upsertL1(l1(B, "mem-b-0", "B memory"))) && l1WriteOk;
    l1WriteOk = (await store.upsertL1(l1(A2, "mem-a2-0", "A2 memory"))) && l1WriteOk;
    check("All L1 write calls returned success", l1WriteOk);

    const aN = await waitCount(store, A, 3);
    const bN = await waitCount(store, B, 2);
    const a2N = await waitCount(store, A2, 1);
    check("A L0 wrote 3 items", aN === 3, `actually ${aN}`);
    check("B L0 wrote 2 items", bN === 2, `actually ${bN}`);
    check("A2 L0 wrote 1 item (same team, different agent)", a2N === 1, `actually ${a2N}`);

    const aL1 = await waitCountL1(store, A, 2);
    const bL1 = await waitCountL1(store, B, 1);
    const a2L1 = await waitCountL1(store, A2, 1);
    check("A L1 wrote 2 items", aL1 === 2, `actually ${aL1}`);
    check("B L1 wrote 1 item", bL1 === 1, `actually ${bL1}`);
    check("A2 L1 wrote 1 item", a2L1 === 1, `actually ${a2L1}`);

    if (aN !== 3 || bN !== 2 || a2N !== 1 || aL1 !== 2 || bL1 !== 1) {
      console.error("\nData not ready, later assertions are meaningless, exiting early");
      return;
    }

    // -- 1. Scope correctness: the most critical one on a real machine --
    console.log("\n1. clearMemoryContent scope (L0 + L1 verified together)");
    const r = await store.clearMemoryContent({ teamId: A.teamId, agentId: A.agentId });
    check("returns l0Deleted=3", r.l0Deleted === 3, `actually ${r.l0Deleted}`);
    check("returns l1Deleted=2", r.l1Deleted === 2, `actually ${r.l1Deleted}`);

    check("A L0 cleared", (await waitCount(store, A, 0)) === 0);
    check("A L1 cleared", (await waitCountL1(store, A, 0)) === 0);
    check("B L0 unaffected (no cross-team wrong deletion)", (await waitCount(store, B, 2)) === 2);
    check("B L1 unaffected", (await waitCountL1(store, B, 1)) === 1);
    check("A2 L0 unaffected (no cross-agent wrong deletion)", (await waitCount(store, A2, 1)) === 1);
    check("A2 L1 unaffected (no cross-agent wrong deletion)", (await waitCountL1(store, A2, 1)) === 1);

    // -- 2. Idempotency --
    console.log("\n2. Idempotency");
    const again = await store.clearMemoryContent({ teamId: A.teamId, agentId: A.agentId });
    check("repeated clear of L0 returns 0", again.l0Deleted === 0, `actually ${again.l0Deleted}`);
    check("repeated clear of L1 returns 0", again.l1Deleted === 0, `actually ${again.l1Deleted}`);

    // -- 3. Writing can continue after clearing (requirement acceptance criterion) --
    console.log("\n3. Writing can continue after clearing");
    await store.upsertL0(l0(A, "rec-a-new", "A msg after clear"), undefined);
    await store.upsertL1(l1(A, "mem-a-new", "A memory after clear"));
    check("new L0 write is visible after clearing", (await waitCount(store, A, 1)) === 1);
    check("new L1 write is visible after clearing", (await waitCountL1(store, A, 1)) === 1);

    // -- 4. Guardrails --
    await runGuardChecks(store);
    check("B data is intact after the guardrail triggers", (await waitCount(store, B, 2)) === 2);

    // -- 5. deleteL0BySession normal path --
    console.log("\n5. deleteL0BySession normal path");
    const n = await store.deleteL0BySession(B.sessionId, {
      teamId: B.teamId, agentId: B.agentId, userId: B.userId,
    });
    check("delete by session returns 2", n === 2, `actually ${n}`);
    check("B cleared", (await waitCount(store, B, 0)) === 0);
    check("A2 still unaffected", (await waitCount(store, A2, 1)) === 1);

    console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
  } finally {
    // Clean up the temporary database regardless of success or failure
    try {
      const admin = new TcvdbClient({
        url: VDB_URL!, username: VDB_USERNAME, apiKey: VDB_API_KEY!,
        database: TMP_DB, timeout: 30_000, logger: silentLogger,
      });
      await admin.dropDatabase(TMP_DB);
      console.log(`Deleted temporary database ${TMP_DB}`);
    } catch (err) {
      console.error(
        `⚠️ Failed to delete temporary database ${TMP_DB}, please clean up manually: ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await store.close?.();
  }

  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exitCode = 1;
});
