/**
 * @tencentdb-agent-memory/memory-sdk-ts-v2 — TypeScript SDK for TencentDB Agent Memory v3 API.
 *
 * Top-level exports come directly from the v3 strict-isolation version. Existing code that previously imported from the
 * `@tencentdb-agent-memory/memory-sdk-ts-v2/v3` subpath can keep doing so (the subpath
 * is kept as a backward-compatible alias with exactly the same contents as this module).
 */

export * from "./v3/index.js";

// Raw data-shape types of the HTTP contract -- the v3 client returns these shapes (v3/types.ts
// has `V3*` aliases; both names work).
export type {
  // Common
  ApiResponseEnvelope, CountData,
  // L0
  ConversationItem, ConversationAddData, ConversationQueryData,
  ConversationSearchData, ConversationSearchHit, ConversationDeleteData,
  // L1
  AtomicDetail, AtomicUpdateData, AtomicQueryData,
  AtomicSearchData, AtomicSearchHit, AtomicDeleteData,
  // L2
  ScenarioEntry, ScenarioListData, ScenarioFile, ScenarioWriteData,
  // L3
  CoreFile, CoreWriteData,
  // Offload
  OffloadToolPair, OffloadRecentMessage,
  OffloadIngestRequest, OffloadIngestData,
  OffloadCompactRequest, OffloadCompactData, OffloadCompactReport,
  OffloadQueryMmdRequest, OffloadQueryMmdData,
} from "./types.js";

// Shared types / utils (not v3-only and not part of the v2 API implementation; exported for callers who need a custom transport
// or direct reads via STS COS)
export { ParamError, TDAMError } from "./errors.js";
export { HttpTransport, type HttpTransportOptions } from "./http.js";
export type { MemoryClientConfig, Transport } from "./client.js";
export {
  MemoryFileReader,
  StsCredentialManager,
  StsCredential,
  createMemoryFileReader,
  cosV5Sign,
  type MemoryFileReaderConfig,
} from "./cos.js";
