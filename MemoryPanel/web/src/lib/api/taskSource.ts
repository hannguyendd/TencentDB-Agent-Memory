/**
 * api/taskSource.ts - Task external sources (import Task).
 *
 * Corresponds to the backend /api/v1/task/source/*.
 *
 * Security boundary: **the frontend never touches tokens**.
 *   - Tokens are injected into Core by the Panel server from the session, and the request body has no credential fields;
 *   - Here only a boolean for "whether connected" and the account identifier are obtained, not the token itself.
 */

import { getPanelSession } from '../panelSession';
import { request, ApiError } from './base';
import type { MetaEnvelope } from './types';

/** External work item type (TAPD: story / task / bug). */
export interface TaskSourceItemType {
  id: string;
  label: string;
}

/**
 * Auth methods: all are tokens manually entered by the user (no OAuth).
 *
 * `token_doc_url`: the apply/view page address of this kind of token, delivered by deployment configuration.
 * The two kinds of tokens are often issued by different systems (Taihu / TAPD), so the address hangs on **each method** rather than at provider level.
 * null means not configured - the frontend then does not show the guide link (no blind jumps, no hardcoded fallback address).
 */
export type AuthScheme =
  | { kind: 'bearer'; label: string; token_doc_url?: string | null }
  | { kind: 'basic'; label: string; token_doc_url?: string | null }
  | { kind: 'custom'; headerName: string; label: string; token_doc_url?: string | null };

/** Token submitted by the user. Sent with the request body, not retained by the server. */
export interface Credential {
  kind: 'bearer' | 'basic' | 'custom';
  secret: string;
  username?: string;
  extra?: Record<string, unknown>;
}

export interface TaskSourceProvider {
  id: string;
  item_types: TaskSourceItemType[];
  max_batch_size: number;
  needs_workspace: boolean;
  auth_schemes: AuthScheme[];
  /** Capabilities supported by the source; the frontend hides the entry for undeclared capabilities (does not assume all sources support everything). */
  capabilities?: { todo?: boolean };
}

export interface TaskWorkspace {
  id: string;
  name: string;
}

export interface CandidateItem {
  external_id: string;
  item_type: string;
  scope?: string;
  title: string;
  url?: string;
  status?: string;
  updated_at?: string;
}

export interface CandidatePage {
  items: CandidateItem[];
  total: number;
  has_more: boolean;
}

/** No skipped: the same item may be imported repeatedly, and there is no "already exists → skip" result. */
export interface ImportResult {
  created: Array<{ external_id: string; task_id: string }>;
  failed: Array<{ external_id: string; error: string }>;
}

function sessionHeaders(): Record<string, string> {
  const session = getPanelSession();
  if (!session) throw new ApiError(401, 'Unauthorized', 'no active panel session');
  return {
    'X-Tdai-Service-Id': session.instanceId,
    'X-Tdai-User-Key': session.userKey,
  };
}

async function post<T>(action: string, body: Record<string, unknown>): Promise<T> {
  const envelope = await request<MetaEnvelope<T>>(
    'POST',
    `/api/v1/task/source/${action}`,
    body,
    sessionHeaders(),
  );
  if (envelope.code !== 0) {
    throw new ApiError(200, envelope.message, '', {
      code: envelope.code,
      requestId: envelope.request_id,
      rawMessage: envelope.message,
    });
  }
  return envelope.data as T;
}

export const taskSourceApi = {
  /** List of enabled sources. Empty array → the frontend hides the "Import Task" entry. */
  providers: (teamId: string) => post<{ providers: TaskSourceProvider[] }>('providers', { team_id: teamId }),

  /** Workspace (TAPD project) list. */
  workspaces: (teamId: string, providerId: string, credential: Credential) =>
    post<{ workspaces: TaskWorkspace[] }>('workspaces', {
      team_id: teamId,
      provider_id: providerId,
      credential,
    }),

  /** Candidate work items (paginated, story + task + bug merged). */
  candidates: (
    teamId: string,
    providerId: string,
    credential: Credential,
    params: {
      workspace_id?: string;
      item_types?: string[];
      keyword?: string;
      owner?: string;
      status?: string;
      page?: number;
      limit?: number;
      /** Only my to-dos (goes through the TAPD to-do API, does not support title/handler filters). */
      only_todo?: boolean;
    },
  ) => post<CandidatePage>('candidates', { team_id: teamId, provider_id: providerId, credential, ...params }),

  /** Batch import. A single failure does not block the rest; results are split into created / failed. */
  import: (
    teamId: string,
    providerId: string,
    credential: Credential,
    items: Array<{ external_id: string; item_type: string; scope?: string }>,
  ) => post<ImportResult>('import', { team_id: teamId, provider_id: providerId, credential, items }),
};
