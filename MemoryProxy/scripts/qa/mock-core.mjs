#!/usr/bin/env node
/**
 * mock-core.mjs -- minimal core stub used to test the Proxy's instance-upstream 4-state resolution.
 *
 * Provides:
 *   POST /v3/meta/auth/verify              -> valid=true
 *   POST /v3/internal/meta/instance-upstream/list -> returns different rows depending on MOCK_MODE
 *
 * MOCK_MODE:
 *   blocked-default   -> default group enabled=false (covers pi) -> expect 400 UPSTREAM_DISABLED
 *   blocked-custom    -> custom group enabled=false (covers codebuddy) -> expect 400 UPSTREAM_DISABLED
 *   unmanaged         -> declares only some agents, the rest fall to unmanaged -> expect 400 AGENT_NOT_CONFIGURED
 *
 * Usage: MOCK_MODE=blocked-default node mock-core.mjs
 */
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 18500);
const MODE = process.env.MOCK_MODE || "blocked-default";

function rowsFor(mode) {
  const allAgents = ["claude-code", "codebuddy", "codex", "workbuddy", "dsh", "opencode", "pi", "hermes", "openclaw"];
  if (mode === "blocked-default") {
    return [{
      id: 1, group_id: "dflt-mock", group_type: "default", name: "mock-default",
      agents: allAgents, enabled: false, mode: "official",
      base_url: "", api_key: "", model_id: "", description: "",
      version: 1, supported_agents_snapshot: allAgents,
      created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z",
    }];
  }
  if (mode === "blocked-custom") {
    return [
      { id: 1, group_id: "dflt-mock", group_type: "default", name: "mock-default",
        agents: allAgents, enabled: true, mode: "official",
        base_url: "", api_key: "", model_id: "", description: "",
        version: 1, supported_agents_snapshot: allAgents,
        created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z" },
      { id: 2, group_id: "grp-mock", group_type: "custom", name: "mock-custom-blocked",
        agents: ["codebuddy"], enabled: false, mode: "custom_unified",
        base_url: "https://api.deepseek.com", api_key: "sk-mock", model_id: "", description: "",
        version: 1, supported_agents_snapshot: [],
        created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z" },
    ];
  }
  if (mode === "unmanaged") {
    // The default group declares only dsh -- all other agents fall to unmanaged
    return [{
      id: 1, group_id: "dflt-mock", group_type: "default", name: "mock-default",
      agents: ["dsh"], enabled: true, mode: "official",
      base_url: "", api_key: "", model_id: "", description: "",
      version: 1, supported_agents_snapshot: ["dsh"],
      created_at: "2026-10-08T00:00:00.000Z", updated_at: "2026-10-08T00:00:00.000Z",
    }];
  }
  return [];
}

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => { body += c; });
  req.on("end", () => {
    const url = req.url.split("?")[0];
    const send = (obj, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    if (url === "/v3/meta/auth/verify") {
      return send({
        code: 0, message: "ok", request_id: "req-mock",
        data: { valid: true, user: { user_id: "usr-mock", user_type: "normal", username: "mock", created_at: "2026-01-01T00:00:00Z" } },
      });
    }
    if (url === "/v3/internal/meta/instance-upstream/list") {
      return send({ code: 0, message: "ok", request_id: "req-mock", data: { items: rowsFor(MODE) } });
    }
    if (url === "/health") {
      return send({ status: "ok", version: "mock", stores: {}, services: {} });
    }
    send({ code: 404, message: `mock: no route ${url}` }, 404);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[mock-core] listening on ${PORT}, MOCK_MODE=${MODE}`);
});
