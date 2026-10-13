/**
 * Dev-machine verification script: compares the effects of "delete Agent" and "clear" on chat_memory assets.
 *
 * The goal is to nail down the problem in the panel's current behavior (rather than inferring only from reading the code):
 *   Scenario A -- archiveAgent (the kernel action finally called by the panel /api/v1/agent/delete-cascade)
 *             **deletes the chat_memory asset entirely**; for the Agent to keep using it, it must be rebuilt + rebound.
 *   Scenario B -- /v3/chat-memory/clear only clears content; the asset / bindings / visibility are all kept,
 *             and writing can continue directly after clearing.
 *
 * Usage (in the MemoryCore directory):
 *   node --import tsx scripts/verify-clear-vs-archive.ts
 *
 * Read-only + self-built temporary data, connects to no online resources; the temporary directory is cleaned up automatically after the run.
 */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { TdaiGateway } from "../src/gateway/server.js";

const GATEWAY_KEY = "verify-clear-key";
const PORT = 19300 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;

interface Envelope<T = unknown> {
  code: number;
  message?: string;
  data?: T;
}

function post<T = unknown>(
  urlPath: string,
  body: unknown,
  userKey?: string,
): Promise<{ status: number; body: Envelope<T> }> {
  const json = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(json)),
    "x-tdai-service-id": "default",
    Authorization: `Bearer ${GATEWAY_KEY}`,
  };
  if (userKey) headers["x-tdai-user-key"] = userKey;

  return new Promise((resolve, reject) => {
    const req = http.request(new URL(urlPath, BASE), { method: "POST", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) as Envelope<T> });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: { code: res.statusCode ?? 0, message: raw } });
        }
      });
    });
    req.on("error", reject);
    req.write(json);
    req.end();
  });
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

async function must<T>(label: string, p: Promise<{ status: number; body: Envelope<T> }>): Promise<T> {
  const r = await p;
  if (r.body.code !== 0) {
    throw new Error(`${label} failed: code=${r.body.code} msg=${r.body.message}`);
  }
  return r.body.data as T;
}

interface Ctx {
  userId: string;
  userKey: string;
  teamId: string;
  agentId: string;
  memoryId: string;
  sessionId: string;
}

async function setup(adminKey: string, tag: string): Promise<Ctx> {
  const u = await must<{ user_id: string; default_user_key: string }>(
    "user/create",
    post("/v3/meta/user/create", { username: `u-${tag}-${Date.now().toString(36)}` }, adminKey),
  );
  const t = await must<{ team_id: string }>(
    "team/create",
    post("/v3/meta/team/create", { name: `T-${tag}`, owner_user_id: u.user_id }, u.default_user_key),
  );
  const a = await must<{ agent_id: string }>(
    "agent/create",
    post(
      "/v3/meta/agent/create",
      { team_id: t.team_id, owner_user_id: u.user_id, name: `A-${tag}` },
      u.default_user_key,
    ),
  );
  const ctx: Ctx = {
    userId: u.user_id,
    userKey: u.default_user_key,
    teamId: t.team_id,
    agentId: a.agent_id,
    memoryId: `chat_memory-${t.team_id}-${a.agent_id}`,
    sessionId: `s-${tag}-${Date.now()}`,
  };
  await addMsgs(ctx, 3);
  return ctx;
}

async function addMsgs(c: Ctx, n: number) {
  return must<{ accepted_ids: string[] }>(
    "conversation/add",
    post(
      "/v3/conversation/add",
      {
        team_id: c.teamId, user_id: c.userId, agent_id: c.agentId, session_id: c.sessionId,
        messages: Array.from({ length: n }, (_, i) => ({
          role: i % 2 === 0 ? "user" : "assistant",
          content: `msg ${i} for ${c.agentId}`,
        })),
      },
      c.userKey,
    ),
  );
}

async function countL0(c: Ctx): Promise<number> {
  const d = await must<{ total: number }>(
    "conversation/count",
    post(
      "/v3/conversation/count",
      { team_id: c.teamId, user_id: c.userId, agent_id: c.agentId, session_id: c.sessionId },
      c.userKey,
    ),
  );
  return d.total;
}

async function assetStatus(c: Ctx): Promise<{ exists: boolean; code: number }> {
  const r = await post("/v3/meta/asset/get", { asset_id: c.memoryId }, c.userKey);
  return { exists: r.body.code === 0 && !!r.body.data, code: r.body.code };
}

async function bindings(c: Ctx): Promise<string[]> {
  const r = await post<{ items: Array<{ asset_id: string }> }>(
    "/v3/meta/agent-fixed-asset/list",
    { agent_id: c.agentId },
    c.userKey,
  );
  if (r.body.code !== 0) return [];
  return (r.body.data?.items ?? []).map((i) => i.asset_id);
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-clear-"));
  process.env.TDAI_METADATA_SQLITE_BASE_DIR = path.join(tmpDir, "metadata");

  const gateway = new TdaiGateway({
    server: { port: PORT, host: "127.0.0.1", apiKey: GATEWAY_KEY },
    data: { baseDir: tmpDir },
    llm: { baseUrl: "http://localhost:1", apiKey: "test-key", model: "test-model" },
  });
  await gateway.start();

  try {
    const admin = await must<{ user_key?: string; default_user_key?: string }>(
      "init-admin",
      post("/v3/internal/meta/user/init-admin", { username: `admin-${Date.now().toString(36)}` }),
    );
    const adminKey = admin.user_key ?? admin.default_user_key!;

    // -- Scenario A: delete Agent (the final action of the panel's delete-cascade) --
    console.log("\nScenario A — agent/archive (delete Agent: the agent's memory content should be deleted along with it)");
    const a = await setup(adminKey, "archive");
    check("Precondition: memory asset exists", (await assetStatus(a)).exists);
    check("Precondition: binding exists", (await bindings(a)).includes(a.memoryId));
    check("Precondition: L0 has 3 items", (await countL0(a)) === 3);

    await must("agent/archive", post("/v3/meta/agent/archive", { agent_id: a.agentId }, a.userKey));

    const aAfter = await assetStatus(a);
    check("After deleting the Agent the memory asset is deleted", !aAfter.exists, `asset/get code=${aAfter.code}`);

    // Key regression point: before the fix 3 items would remain here (the asset is gone but the content is still there → permanent orphan data)
    const aL0 = await countL0(a);
    check("After deleting the Agent the agent's memory content is also zeroed (no orphan data)", aL0 === 0, `actually ${aL0} left over`);

    // -- Scenario B: clear (the new endpoint) --
    console.log("\nScenario B — /v3/chat-memory/clear (the new endpoint)");
    const b = await setup(adminKey, "clear");
    const beforeAsset = await post<{ visibility: string; owner_user_id: string; name?: string }>(
      "/v3/meta/asset/get", { asset_id: b.memoryId }, b.userKey,
    );
    check("Precondition: memory asset exists", beforeAsset.body.code === 0);
    check("Precondition: L0 has 3 items", (await countL0(b)) === 3);

    const cleared = await must<{
      items: Array<{ memory_id: string; cleared: boolean; l0_deleted: number }>;
      all_cleared: boolean;
    }>("chat-memory/clear", post("/v3/chat-memory/clear", { memory_ids: [b.memoryId] }, b.userKey));

    check("clear returns all_cleared=true", cleared.all_cleared === true);
    check("clear deleted 3 L0 items", cleared.items[0].l0_deleted === 3, `actually ${cleared.items[0].l0_deleted}`);
    check("After clearing L0 is zero", (await countL0(b)) === 0);
    check("After clearing the memory asset still exists", (await assetStatus(b)).exists);
    check("After clearing the Agent binding is still there", (await bindings(b)).includes(b.memoryId));

    const afterAsset = await post<{ visibility: string; owner_user_id: string; name?: string }>(
      "/v3/meta/asset/get", { asset_id: b.memoryId }, b.userKey,
    );
    check(
      "After clearing Owner / visibility / name are unchanged",
      afterAsset.body.data?.owner_user_id === beforeAsset.body.data?.owner_user_id
      && afterAsset.body.data?.visibility === beforeAsset.body.data?.visibility
      && afterAsset.body.data?.name === beforeAsset.body.data?.name,
    );

    // After clearing, continue writing, with no need to rebuild
    await addMsgs(b, 2);
    check("After clearing, writing can continue directly with the original memory_id", (await countL0(b)) === 2);

    // Idempotency
    const again = await must<{ items: Array<{ cleared: boolean; l0_deleted: number }> }>(
      "chat-memory/clear again",
      post("/v3/chat-memory/clear", { memory_ids: [b.memoryId] }, b.userKey),
    );
    check("Repeated clear succeeds idempotently", again.items[0].cleared === true);

    console.log(`\nResult: ${pass} passed, ${fail} failed\n`);
  } finally {
    await gateway.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.TDAI_METADATA_SQLITE_BASE_DIR;
  }

  process.exitCode = fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("verify crashed:", err);
  process.exitCode = 1;
});
