/**
 * v2 API request/response types -- extracted from docs/team-api-仅memory.yaml.
 *
 * Team-memory contract extension: optional IdFields layered on top of the 13 endpoints in offload.yaml
 * (team_id / agent_id / user_id / task_id) for identity isolation in service mode.
 * Old clients that do not send IdFields keep the original offload semantics.
 */

// ---------------------------------------------------------------------------
// Common
// ---------------------------------------------------------------------------

export interface ApiResponseEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data?: T;
}

/**
 * Team-memory 4-ID isolation fields, all optional; the endpoint schema layer does no required-field validation.
 * The server's resolveIsolation prefers body fields and falls back to x-tdai-* headers when they are missing.
 *
 * See the IdFields component in docs/team-api-仅memory.yaml.
 */
export interface IdFields {
  /** Team ID (PRD §3.2). */
  team_id?: string;
  /** Agent ID (PRD §3.2); forms a composite unique key with team_id. */
  agent_id?: string;
  /** User ID (PRD §3.2, Taihu account mapping). */
  user_id?: string;
  /** Task ID (PRD §3.2); ownership is validated by (team_id, task_id). */
  task_id?: string;
}

// ---------------------------------------------------------------------------
// L0 Conversation
// ---------------------------------------------------------------------------

export interface ConversationItem {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp?: string;
}

export interface ConversationAddRequest extends IdFields {
  session_id: string;
  messages: ConversationItem[];
}
export interface ConversationAddData {
  accepted_ids: string[];
  total_count: number;
}

export interface ConversationQueryRequest extends IdFields {
  session_id?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
}
export interface ConversationQueryData {
  messages: ConversationItem[];
  total: number;
}

export interface ConversationSearchRequest extends IdFields {
  query: string;
  limit?: number;
  session_id?: string;
  time_start?: string;
  time_end?: string;
}
export interface ConversationSearchHit extends ConversationItem {
  score: number;
}
export interface ConversationSearchData {
  messages: ConversationSearchHit[];
}

export interface ConversationDeleteRequest extends IdFields {
  message_ids?: string[];
  session_id?: string;
}
export interface ConversationDeleteData {
  deleted_count: number;
}

export interface CountData {
  total: number;
}

export interface ConversationCountRequest extends IdFields {
  session_id?: string;
  time_start?: string;
  time_end?: string;
}

// ---------------------------------------------------------------------------
// L1 Atomic
// ---------------------------------------------------------------------------

export interface AtomicDetail {
  id: string;
  type: string;
  content: string;
  background?: string;
  created_at: string;
  updated_at: string;
}

export interface AtomicUpdateRequest extends IdFields {
  id: string;
  content: string;
  background?: string;
}
export interface AtomicUpdateData {
  id: string;
  updated_at: string;
}

export interface AtomicQueryRequest extends IdFields {
  type?: string;
  limit?: number;
  offset?: number;
  time_start?: string;
  time_end?: string;
}
export interface AtomicQueryData {
  items: AtomicDetail[];
  total: number;
}

export interface AtomicSearchRequest extends IdFields {
  query: string;
  limit?: number;
  type?: string;
  time_start?: string;
  time_end?: string;
}
export interface AtomicSearchHit extends AtomicDetail {
  score: number;
}
export interface AtomicSearchData {
  items: AtomicSearchHit[];
}

export interface AtomicDeleteRequest extends IdFields {
  ids: string[];
}
export interface AtomicDeleteData {
  deleted_count: number;
}

export interface AtomicCountRequest extends IdFields {
  type?: string;
  time_start?: string;
  time_end?: string;
}

// ---------------------------------------------------------------------------
// L2 Scenario
// ---------------------------------------------------------------------------

export interface ScenarioListRequest extends IdFields {
  path_prefix?: string;
}
export interface ScenarioEntry {
  path: string;
  summary?: string;
  created_at: string;
  updated_at: string;
}
export interface ScenarioListData {
  entries: ScenarioEntry[];
  total: number;
}

export interface ScenarioReadRequest extends IdFields {
  path: string;
}
export interface ScenarioFile {
  path: string;
  /** File content. `null` if the file does not exist. */
  content: string | null;
  /** ISO timestamp. `null` if the file does not exist. */
  created_at: string | null;
  /** ISO timestamp. `null` if the file does not exist. */
  updated_at: string | null;
}

export interface ScenarioWriteRequest extends IdFields {
  path: string;
  content: string;
  summary?: string;
}
export interface ScenarioWriteData {
  path: string;
  updated_at: string;
}

export interface ScenarioRmRequest extends IdFields {
  path: string;
}

export interface ScenarioCountRequest extends IdFields {
  path_prefix?: string;
}

// ---------------------------------------------------------------------------
// L3 Core
// ---------------------------------------------------------------------------

export interface CoreReadRequest extends IdFields {}
export interface CoreCountRequest extends IdFields {}
export interface CoreFile {
  /** File content. `null` if core memory has not been generated yet. */
  content: string | null;
  /** ISO timestamp. `null` if not available. */
  created_at: string | null;
  /** ISO timestamp. `null` if not available. */
  updated_at: string | null;
}

export interface CoreWriteRequest extends IdFields {
  content: string;
}
export interface CoreWriteData {
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Offload (Compaction + Ingest)
// ---------------------------------------------------------------------------

export interface OffloadToolPair {
  tool_name: string;
  tool_call_id: string;
  params: unknown;
  result: unknown;
  error?: string;
  timestamp: string;
  duration_ms?: number;
}

export interface OffloadRecentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface OffloadIngestRequest {
  session_id: string;
  tool_pairs: OffloadToolPair[];
  prompt?: string;
  recent_messages?: OffloadRecentMessage[];
}

export interface OffloadIngestData {
  accepted: boolean;
}

export interface OffloadCompactRequest {
  session_id: string;
  messages: unknown[];
  ratio: number;
  context_window: number;
  total_tokens: number;
  message_tokens?: number[];
}

export interface OffloadCompactReport {
  resolvedLevel: string;
  originalCount: number;
  compactedCount: number;
  fastPathReplaced: number;
  fastPathDeleted: number;
  mildReplacements: number;
  aggressiveDeleted: number;
  emergencyDeleted: number;
  mmdInjected: number;
}

export interface OffloadCompactData {
  messages: unknown[];
  report: OffloadCompactReport;
}

export interface OffloadQueryMmdRequest {
  session_id: string;
  limit?: number;
}

export interface OffloadMmdFile {
  filename: string;
  content: string;
  version: number;
}

export interface OffloadQueryMmdData {
  mmds: OffloadMmdFile[];
  current_mmd: string | null;
}
