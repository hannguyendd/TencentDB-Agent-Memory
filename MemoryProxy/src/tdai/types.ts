/** TDAI memory integration configuration and shared types. */

export interface TdaiMemoryConfig {
  enabled: boolean;
  /** TDAI Gateway base URL, e.g. http://127.0.0.1:8420 */
  endpoint: string;
  /** Bearer token passed to TDAI Gateway. */
  apiKey: string;
  /** x-tdai-service-id header value. */
  serviceId: string;

  writeL0: boolean;
  recallL1: boolean;
  injectL2L3: boolean;

  l1Limit: number;
  l2Limit: number;
  timeoutMs: number;
}

export interface TdaiIdentity {
  teamId: string;
  userId: string;
  agentId: string;
  /** Conversation/session dimension for L0/L1 only. */
  sessionId: string;
  /** Task dimension for L0/L1 only. */
  taskId?: string;
  /**
   * User key of the request initiator (raw `sk-mem-...`). Used for Layer 3 user auth
   * on tdai `/v3/meta/*` routes (`x-tdai-user-key` header); required on the ACL check path.
   *
   * The data plane (`/v3/conversation/*`) uses the team/user/agent header triple and does not use this field.
   */
  userKey?: string;
}

/**
 * Per-agent context used when reading other agents' memories
 * (e.g. via the "imported" relation). team/user/agent identify the data
 * owner; sessionId/taskId stay on the *caller* (current request).
 *
 * Why the split: borrowing memories from agent B doesn't change which
 * conversation we're in — L0 captures into the caller's sessionId,
 * but L1 search and L2/L3 reads use B's owning triplet.
 */
export interface TdaiAgentCtx {
  teamId: string;
  userId: string;
  agentId: string;
  /** Display name for prompt section headings ("from X"). */
  agentName?: string;
}

/** Result of L1 recall — keep `from` so proxy can label "[from X]" in prompt. */
export interface TdaiL1Hit extends TdaiL1Memory {
  fromAgentId: string;
  fromAgentName?: string;
}

export interface TdaiMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TdaiL1Memory {
  id: string;
  type?: string;
  content: string;
  score?: number;
  updatedAt?: string;
}

export interface TdaiL2Entry {
  path: string;
  summary?: string;
  updatedAt?: string;
}

export interface TdaiL2File extends TdaiL2Entry {
  content: string;
}

export interface TdaiL3Core {
  content: string;
  updatedAt?: string;
}
