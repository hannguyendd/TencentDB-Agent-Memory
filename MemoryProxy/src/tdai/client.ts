import type {
  TdaiAgentCtx,
  TdaiIdentity,
  TdaiL1Memory,
  TdaiL2Entry,
  TdaiL2File,
  TdaiL3Core,
  TdaiMemoryConfig,
  TdaiMessage,
} from "./types.js";
import { log } from "../report/log.js";

interface TdaiEnvelope<T = unknown> {
  code?: number;
  message?: string;
  data?: T;
}

const TDAI_MESSAGE_CONTENT_MAX_CHARS = 8192;
const TDAI_CONVERSATION_MAX_MESSAGES = 100;

/**
 * Split messages to fit the gateway schema without losing content or breaking
 * UTF-16 surrogate pairs. The gateway validates string.length, so this limit
 * intentionally uses JavaScript code units rather than UTF-8 bytes.
 */
function chunkConversationMessages(messages: TdaiMessage[]): TdaiMessage[] {
  return messages.flatMap((message) => {
    if (message.content.length <= TDAI_MESSAGE_CONTENT_MAX_CHARS) return [message];

    const chunks: TdaiMessage[] = [];
    let start = 0;
    while (start < message.content.length) {
      let end = Math.min(start + TDAI_MESSAGE_CONTENT_MAX_CHARS, message.content.length);
      if (
        end < message.content.length
        && isHighSurrogate(message.content.charCodeAt(end - 1))
        && isLowSurrogate(message.content.charCodeAt(end))
      ) {
        end -= 1;
      }
      chunks.push({ role: message.role, content: message.content.slice(start, end) });
      start = end;
    }
    return chunks;
  });
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xD800 && code <= 0xDBFF;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xDC00 && code <= 0xDFFF;
}

// ── Shared factory (Phase 0.4, 2026-09-28) ─────────────────────────────────────
/**
 * Builds a per-request TdaiClient. Previously handler / anthropicHandler / codexHandler /
 * workbuddyHandler each wrote the exact same factory (the workbuddy version forgetting to pass spaceId was a
 * known bug, see handler-audit §2.2).
 *
 * `spaceId` (from the URL `/{agent}/{spaceId}/...`) overrides config.tdai.serviceId,
 * so multi-tenant requests write to the correct kernel tenant; without spaceId it falls back to the global default (compatible with
 * legacy single-tenant deployments).
 *
 * Returns null when memory is not enabled; callers short-circuit with `if (client)`.
 */
export function buildTdaiClientForRequest(
  config: {
    tdai: {
      enabled?: boolean;
      endpoint?: string;
      apiKey?: string;
      serviceId?: string;
      memory: {
        enabled?: boolean;
        writeL0?: boolean;
        recallL1?: boolean;
        injectL2L3?: boolean;
        l1Limit?: number;
        l2Limit?: number;
        timeoutMs?: number;
      };
    };
  },
  spaceId?: string,
): TdaiClient | null {
  const t = config.tdai;
  if (!t?.enabled || !t.memory?.enabled || !t.endpoint) return null;
  // Fields are passed through exactly as in createTdaiClient in handler/anthropic;
  // the old factory did not apply defaults either - it relies on the config loader's fillDefaults having filled them.
  return new TdaiClient({
    enabled: t.enabled && t.memory.enabled,
    endpoint: t.endpoint,
    apiKey: t.apiKey ?? "",
    serviceId: spaceId || t.serviceId || "",
    writeL0: t.memory.writeL0 ?? false,
    recallL1: t.memory.recallL1 ?? false,
    injectL2L3: t.memory.injectL2L3 ?? false,
    l1Limit: t.memory.l1Limit ?? 0,
    l2Limit: t.memory.l2Limit ?? 0,
    timeoutMs: t.memory.timeoutMs ?? 0,
  });
}

// ── ACL types ─────────────────────────────────────────────────────────────
export type AclAction = "read" | "write" | "delete" | "grant";

export interface AclCheckParams {
  /**
   * User key of the request initiator (raw `sk-mem-...`).
   *
   * tdai `/v3/meta/*` routes require the `x-tdai-user-key` header to pass Layer 3
   * user auth (otherwise 401 missing_user_key). The user_key passed here will:
   *   1. be used as the `x-tdai-user-key` header for authentication ("who you are")
   *   2. be used by the tdai server to resolve user_id, which is used by checkAssetPermission
   *
   * So the body **no longer needs** user_id - tdai resolves it from the header.
   */
  user_key: string;
  /** Target asset id, e.g. `chat_memory-{team}-{agent}`. */
  asset_id: string;
  action: AclAction;
  /** Optional: explicitly restrict which agent the check applies to. */
  agent_id?: string;
}

export interface AclCheckResult {
  allowed: boolean;
  reason?: string;
}

export class TdaiClient {
  constructor(private config: TdaiMemoryConfig) {}

  isEnabled(): boolean {
    return this.config.enabled && !!this.config.endpoint;
  }

  async addConversation(identity: TdaiIdentity, messages: TdaiMessage[]): Promise<void> {
    if (!this.isEnabled() || !this.config.writeL0 || messages.length === 0) return;

    const chunkedMessages = chunkConversationMessages(messages);
    log.info("tdai-recorder:write-l0", {
      team: identity.teamId,
      agent: identity.agentId,
      user: identity.userId,
      session: identity.sessionId,
      task: identity.taskId,
      msgs: messages.length,
      chunks: chunkedMessages.length,
      userLen: (messages[0]?.content ?? "").length,
    });

    for (let offset = 0; offset < chunkedMessages.length; offset += TDAI_CONVERSATION_MAX_MESSAGES) {
      const batch = chunkedMessages.slice(offset, offset + TDAI_CONVERSATION_MAX_MESSAGES);
      await this.postForCtx(
        "/v3/conversation/add",
        { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
        {
          team_id: identity.teamId,
          user_id: identity.userId,
          agent_id: identity.agentId,
          session_id: identity.sessionId,
          task_id: identity.taskId,
          messages: batch,
        },
        identity.sessionId,
        identity.taskId,
        { includeSession: true, includeTask: true, throwOnError: true },
      );
    }
  }

  async searchL1(identity: TdaiIdentity, query: string): Promise<TdaiL1Memory[]> {
    return this.searchL1ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      query,
      identity.sessionId,
      identity.taskId,
    );
  }

  /**
   * Multi-agent variant: search L1 against a specific (team, user, agent)
   * triplet, while keeping the caller's session/task on the wire.
   *   - used for one agent in "own + borrowed" recall
   *   - returns empty directly without a query (same as the original behavior)
   */
  async searchL1ForCtx(
    ctx: TdaiAgentCtx,
    query: string,
    sessionId: string,
    taskId?: string,
    limit?: number,
  ): Promise<TdaiL1Memory[]> {
    if (!this.isEnabled() || !this.config.recallL1 || !query.trim()) return [];
    const data = await this.postForCtx<{ items?: Array<Record<string, unknown>> }>(
      "/v3/atomic/search",
      ctx,
      {
        team_id: ctx.teamId,
        user_id: ctx.userId,
        agent_id: ctx.agentId,
        session_id: sessionId,
        task_id: taskId,
        query: query.slice(0, 2048),
        limit: limit ?? this.config.l1Limit,
      },
      sessionId,
      taskId,
      { includeSession: true, includeTask: true },
    );
    return (data.items ?? [])
      .map((item) => ({
        id: String(item.id ?? ""),
        type: typeof item.type === "string" ? item.type : undefined,
        content: typeof item.content === "string" ? item.content : "",
        score: typeof item.score === "number" ? item.score : undefined,
        updatedAt: typeof item.updated_at === "string" ? item.updated_at : undefined,
      }))
      .filter((m) => m.id && m.content);
  }

  async listL2(identity: TdaiIdentity): Promise<TdaiL2Entry[]> {
    return this.listL2ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async listL2ForCtx(ctx: TdaiAgentCtx): Promise<TdaiL2Entry[]> {
    if (!this.isEnabled() || !this.config.injectL2L3) return [];
    const data = await this.postForCtx<{ entries?: Array<Record<string, unknown>> }>(
      "/v3/scenario/ls",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path_prefix: "",
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    return (data.entries ?? [])
      .map((entry) => ({
        path: String(entry.path ?? ""),
        summary: typeof entry.summary === "string" ? entry.summary : undefined,
        updatedAt: typeof entry.updated_at === "string" ? entry.updated_at : undefined,
      }))
      .filter((entry) => entry.path && !entry.path.endsWith("/"))
      .slice(0, this.config.l2Limit);
  }

  async readL2(identity: TdaiIdentity, path: string): Promise<TdaiL2File | null> {
    return this.readL2ForCtx(
      { teamId: identity.teamId, userId: identity.userId, agentId: identity.agentId },
      path,
    );
  }

  async readL2ForCtx(ctx: TdaiAgentCtx, path: string): Promise<TdaiL2File | null> {
    if (!this.isEnabled() || !this.config.injectL2L3 || !path) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/scenario/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
        path,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return {
      path,
      content,
      updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined,
    };
  }

  async readL3(identity: TdaiIdentity): Promise<TdaiL3Core | null> {
    return this.readL3ForCtx({
      teamId: identity.teamId,
      userId: identity.userId,
      agentId: identity.agentId,
    });
  }

  async readL3ForCtx(ctx: TdaiAgentCtx): Promise<TdaiL3Core | null> {
    if (!this.isEnabled() || !this.config.injectL2L3) return null;
    const data = await this.postForCtx<Record<string, unknown> | null>(
      "/v3/core/read",
      ctx,
      {
        team_id: ctx.teamId,
        agent_id: ctx.agentId,
      },
      "",
      undefined,
      { includeSession: false, includeTask: false },
    );
    const content = typeof data?.content === "string" ? data.content : "";
    if (!content) return null;
    return { content, updatedAt: typeof data?.updated_at === "string" ? data.updated_at : undefined };
  }

  private async postForCtx<T>(
    path: string,
    ctx: TdaiAgentCtx,
    body: Record<string, unknown>,
    sessionId: string,
    taskId: string | undefined,
    options: { includeSession: boolean; includeTask: boolean; throwOnError?: boolean } = { includeSession: true, includeTask: true },
  ): Promise<T> {
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.config.apiKey || "local-proxy"}`,
        "x-tdai-service-id": this.config.serviceId || "default",
        "x-tdai-team-id": ctx.teamId,
        "x-tdai-user-id": ctx.userId,
        "x-tdai-agent-id": ctx.agentId,
      };
      if (options.includeSession && sessionId) headers["x-tdai-session-id"] = sessionId;
      if (options.includeTask && taskId) headers["x-tdai-task-id"] = taskId;

      const res = await fetch(`${base}${path}`, {
        method: "POST",
        signal: controller.signal,
        headers,
        body: JSON.stringify(stripUndefined(body)),
      });
      if (!res.ok) {
        if (options.throwOnError) throw new Error(`TDAI ${path} failed: HTTP ${res.status}`);
        return {} as T;
      }
      const envelope = await res.json() as TdaiEnvelope<T>;
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        if (options.throwOnError) throw new Error(`TDAI ${path} failed: code ${envelope.code}`);
        return {} as T;
      }
      return (envelope.data ?? {}) as T;
    } catch (error) {
      if (options.throwOnError) throw error;
      return {} as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ── ACL check ──────────────────────────────────────────────────────────
  //
  // **Opposite semantics** to memory read calls (postForCtx default mode):
  //   - postForCtx returns empty on read failure so the injection path degrades; L0 writes enable throwOnError
  //   - checkAcl must throw on network/HTTP/envelope errors - so the caller fails closed and rejects injection
  //     and logs an error (otherwise an ACL service outage would silently become "allow all", a privilege escalation)
  //
  // So this method does not reuse postForCtx and is implemented independently - but still reuses the same config
  // （endpoint / apiKey / serviceId / timeoutMs）。

  /**
   * Checks a user_id's permission on an asset.
   *
   * Throw scenarios (fetch/timeout/HTTP non-2xx/envelope code≠0/data.allowed not boolean)
   * should be caught by the caller and handled as the business requires - injection paths should use the checkAclOrDeny helper.
   */
  async checkAcl(params: AclCheckParams): Promise<AclCheckResult> {
    if (!this.isEnabled()) {
      // When tdai is not enabled, treat as "allowed", consistent with other memory methods' returns when disabled.
      return { allowed: true, reason: "tdai_disabled" };
    }
    const base = this.config.endpoint.replace(/\/$/, "");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(`${base}/v3/meta/acl/check`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey || "local-proxy"}`,
          "x-tdai-service-id": this.config.serviceId || "default",
          // Layer 3 user auth: tdai v3 meta routes require this header to pass, otherwise
          // 401 missing_user_key. The Proxy side uses the current request initiator's user_key directly as
          // the caller identity.
          "x-tdai-user-key": params.user_key,
        },
        body: JSON.stringify({
          // body user_key = the **target user whose permission is checked** (same person as the caller here - in the proxy
          // scenario it is always checking oneself). The schema (userIdOrKeyFields.refine)
          // requires at least one of user_id or user_key - we reuse the header's key.
          user_key: params.user_key,
          asset_id: params.asset_id,
          action: params.action,
          agent_id: params.agent_id,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`acl/check http ${res.status}: ${body.slice(0, 200)}`);
      }
      const envelope = (await res.json()) as TdaiEnvelope<AclCheckResult>;
      if (typeof envelope.code === "number" && envelope.code !== 0) {
        throw new Error(`acl/check envelope code=${envelope.code} msg=${envelope.message ?? ""}`);
      }
      const data = envelope.data;
      if (!data || typeof data.allowed !== "boolean") {
        throw new Error(`acl/check malformed response: ${JSON.stringify(data).slice(0, 200)}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Injection-path helper: wraps a try/catch + error logging.
 *
 * Semantics:
 *   - allowed=true                  -> allow
 *   - allowed=false                 -> deny (normal; the caller decides whether to warn)
 *   - underlying call throws        -> deny + error log (fail-closed)
 *
 * Use case: when filtering ctxs one by one in resolveFixedAssetCtxs, we don't want a single network error to
 * make the whole injection path throw; this helper converts the exception into a "deny" signal.
 */
export async function checkAclOrDeny(
  client: TdaiClient,
  params: AclCheckParams,
): Promise<AclCheckResult> {
  try {
    return await client.checkAcl(params);
  } catch (err) {
    log.error(
      "[tdai-acl] check_failed",
      { user_key_masked: maskUserKey(params.user_key), asset_id: params.asset_id, action: params.action },
      err instanceof Error ? err : new Error(String(err)),
    );
    return { allowed: false, reason: "acl_check_error" };
  }
}

function stripUndefined(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value !== undefined));
}

/** Mask the sensitive userKey when printing: keep only the first 6 and last 4 chars. */
function maskUserKey(key: string | undefined): string {
  if (!key) return "";
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}...${key.slice(-4)}`;
}
