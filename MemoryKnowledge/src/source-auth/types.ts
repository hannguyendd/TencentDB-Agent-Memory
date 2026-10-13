/**
 * External knowledge source authentication — generic type contract (resource-level binding).
 *
 * Shared by wiki and codegraph: credentials attach to the accessed resource (`code_graph_id` / `wiki_id`),
 * not to a person. Design doc: MemoryPanel/docs/design/2026-09-08-external-source-import.md §1.1 / §4.1.
 *
 * Stored in KS; the token is encoded into `cred_secret` as base64 and decoded in memory at use time;
 * plaintext never leaves the process (the route layer only echoes metadata).
 */

/**
 * Credential forms:
 *   - `bearer`: a single token (PAT) — the platform protocol supplies a placeholder username for basic-auth injection
 *   - `basic`: username + password (the user fills in the username)
 *
 * To add a new method, first add an implementation in `code-source/auth-methods/`, then come back and add the union member.
 * Do not reserve unimplemented members (avoids the misleading "looks supported but doesn't actually work").
 */
export type CredentialKind = "bearer" | "basic";

/**
 * Resource reference — the binding unit of a credential.
 * Primary key (service_id, resource_type, resource_id), isomorphic with the credential table PK.
 */
export type ResourceRef =
  | { type: "code-graph"; serviceId: string; resourceId: string }   // resourceId = code_graph_id
  | { type: "wiki"; serviceId: string; resourceId: string };        // resourceId = wiki_id

export type ResourceType = ResourceRef["type"];

export interface SourceCredential {
  kind: CredentialKind;
  /** Long-lived token; for basic it is the password. */
  secret: string;
  /** Username for basic auth (filled by the user); for PAT kinds it is fixed by the source (see CLONE_USERNAME). */
  username?: string;
  /** Protocol-specific fields (mcp_url / corpid / header name). */
  extra?: Record<string, unknown>;
}

/** Credential metadata (never contains plaintext). */
export interface CredentialStatus {
  resource_type: ResourceType;
  resource_id: string;
  provider_id: string;
  cred_kind: CredentialKind;
  last_verified_at: string | null;
  updated_at: string;
}

/** Resource-level credential store. */
export interface ICredentialStore {
  /** Get the plaintext credential (used only within the KS process). Not configured / decode failure → null (does not throw). */
  get(ref: ResourceRef): SourceCredential | null;
  /** provider_id records the protocol source ('gongfeng' / 'iwiki' etc.); not a key, for display only. */
  put(ref: ResourceRef, cred: SourceCredential, providerId: string, updatedBy?: string): void;
  delete(ref: ResourceRef): boolean;
  /** Metadata only; never echoes the secret. */
  status(ref: ResourceRef): CredentialStatus | null;
  /**
   * List all credential rows of a certain resource type **across the whole service** (id + service only, for the background scheduler to scan).
   * KS-internal method; no HTTP endpoint is exposed (cross-resource enumeration increases the authorization-bypass surface).
   */
  listAllByType(type: ResourceType): Array<{ serviceId: string; resourceId: string }>;
  /** Record the result of one validation (only updates the timestamp). */
  recordVerify(ref: ResourceRef): void;
}

/** Ciphertext row (as persisted). */
export interface CredentialRow {
  service_id: string;
  resource_type: ResourceType;
  resource_id: string;
  provider_id: string;
  cred_kind: CredentialKind;
  cred_secret: string;                // base64
  cred_username: string | null;       // basic only
  cred_extra_json: string | null;
  last_verified_at: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
